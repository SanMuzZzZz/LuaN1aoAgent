import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationalTopology } from "../src/operational-topology.js";
import { SQLiteGraphStore } from "../src/stores/graph-store.js";

function createStore(): SQLiteGraphStore {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-topology-"));
  const store = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  store.upsertDelta({
    sourceEventIds: [],
    nodes: [
      { id: "host:a", graphKind: "operation", type: "Host", label: "A", properties: {} },
      { id: "host:b", graphKind: "operation", type: "Host", label: "B", properties: {} },
      { id: "session:legacy", graphKind: "operation", type: "Session", label: "Legacy", properties: { status: "live" } }
    ],
    edges: []
  });
  return store;
}

test("operational topology keeps stable identities, lifecycle, TTL, and sanitized properties", () => {
  const store = createStore();
  let now = new Date("2026-01-01T00:00:00.000Z");
  const topology = new OperationalTopology(store, { clock: () => now, ttlMs: 1_000 });

  const sessionRef = topology.upsertAgentSession({
    sessionId: "agent/1",
    hostRef: "host:a",
    properties: {
      transport: "ssh",
      token: "remove-me",
      nested: { password: "remove-me", safe: "keep", list: [{ body: "remove-me", port: 22 }] }
    }
  });
  assert.equal(sessionRef, "agent-session:agent%2F1");
  assert.deepEqual(topology.availableSessionRefs(), [sessionRef, "session:legacy"]);

  const tunnelRef = topology.upsertTunnel({
    tunnelId: "tun/1",
    fromHostRef: "host:a",
    toHostRef: "host:b",
    properties: { localPort: 8080, authorization: "remove-me" }
  });
  assert.equal(tunnelRef, "tunnel:tun%2F1");

  const snapshot = store.query("operation", [], 100);
  const session = snapshot.nodes.find((node) => node.id === sessionRef);
  const tunnel = snapshot.edges.find((edge) => edge.id === tunnelRef);
  assert.equal(session?.type, "AgentSession");
  assert.equal(tunnel?.properties?.tunnelId, "tun/1");
  assert.equal(JSON.stringify({ session, tunnel }).includes("remove-me"), false);
  assert.equal(JSON.stringify(session?.properties).includes("password"), false);

  topology.transitionStatus(sessionRef, "degraded", { via: "relay" });
  assert.equal(topology.effectiveStatus(sessionRef), "degraded");
  now = new Date("2026-01-01T00:00:01.000Z");
  assert.equal(topology.effectiveStatus(sessionRef), "stale");
  assert.deepEqual(topology.availableSessionRefs(), ["session:legacy"]);

  topology.transitionStatus(sessionRef, "closed");
  assert.equal(topology.effectiveStatus(sessionRef), "closed");
  assert.throws(() => topology.transitionStatus(sessionRef, "live"), /cannot be reopened/);
  assert.ok(store.query("operation", [sessionRef], 10).nodes.some((node) => node.id === sessionRef));
  store.close();
});

test("operational topology requires existing Host endpoints and preserves edge identity", () => {
  const store = createStore();
  const topology = new OperationalTopology(store);
  assert.throws(() => topology.upsertShellSession({ sessionId: "shell-1", hostRef: "missing" }), /existing Host/);
  topology.upsertProxyRoute({ routeId: "route-1", fromHostRef: "host:a", toHostRef: "host:b" });
  assert.throws(
    () => topology.upsertProxyRoute({ routeId: "route-1", fromHostRef: "host:b", toHostRef: "host:a" }),
    /Edge identity conflict/
  );
  store.close();
});
