import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConnectivitySupervisor,
  ConnectivitySupervisorRegistry,
  type ConnectivityProcessAdapter
} from "../src/connectivity/connectivity-supervisor.js";
import { OperationalTopology } from "../src/operational-topology.js";
import { ConnectivityStore } from "../src/stores/connectivity-store.js";
import { SQLiteGraphStore } from "../src/stores/graph-store.js";

function runtimeDir(prefix = "luanniao-connectivity-supervisor-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function graphWithHosts(dir: string): SQLiteGraphStore {
  const graph = new SQLiteGraphStore(join(dir, "state.sqlite"), join(dir, "graph-deltas.jsonl"));
  graph.upsertDelta({
    sourceEventIds: [],
    nodes: [
      { id: "host:a", graphKind: "operation", type: "Host", label: "A", properties: {} },
      { id: "host:b", graphKind: "operation", type: "Host", label: "B", properties: {} }
    ],
    edges: []
  });
  return graph;
}

function recordingLog(events: Array<{ eventType: string; payload: Record<string, unknown> }>, onAppend?: () => void) {
  return {
    async append(input: { eventType: string; payload: Record<string, unknown> }) {
      onAppend?.();
      events.push(input);
      return {} as never;
    }
  };
}

test("startup recovery publishes stale before a successful probe restores live", async () => {
  const dir = runtimeDir();
  const graph = graphWithHosts(dir);
  const seed = new ConnectivityStore(join(dir, "state.sqlite"));
  const definition = seed.upsertDefinition({
    kind: "session",
    externalId: "agent-1",
    hostRef: "host:a",
    status: "live"
  });
  seed.close();

  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const probeStatuses: string[] = [];
  const store = new ConnectivityStore(join(dir, "state.sqlite"));
  const adapter: ConnectivityProcessAdapter = {
    async probe(candidate) {
      probeStatuses.push(candidate.status);
      return true;
    }
  };
  const supervisor = new ConnectivitySupervisor(
    store,
    new OperationalTopology(graph),
    recordingLog(events) as never,
    { processAdapter: adapter }
  );
  await supervisor.initialize();

  assert.deepEqual(probeStatuses, ["stale"]);
  assert.deepEqual(events.map((event) => event.payload.status), ["stale", "live"]);
  assert.equal(store.getDefinition(definition.id)?.status, "live");
  assert.equal(new OperationalTopology(graph).effectiveStatus("agent-session:agent-1"), "live");
  store.close();
  graph.close();
});

test("startup and reconcile stale degraded observations while stopped definitions are never probed", async () => {
  const dir = runtimeDir();
  const graph = graphWithHosts(dir);
  const store = new ConnectivityStore(join(dir, "state.sqlite"));
  const degraded = store.upsertDefinition({
    kind: "route",
    externalId: "route-degraded",
    fromHostRef: "host:a",
    toHostRef: "host:b",
    status: "degraded"
  });
  const stopped = store.upsertDefinition({
    kind: "session",
    externalId: "stopped-agent",
    hostRef: "host:a",
    desiredState: "stopped",
    status: "live"
  });
  const probeIds: string[] = [];
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const supervisor = new ConnectivitySupervisor(
    store,
    new OperationalTopology(graph),
    recordingLog(events) as never,
    { probe: async (definition) => { probeIds.push(definition.id); return false; } }
  );

  await supervisor.initialize();
  assert.deepEqual(probeIds, [degraded.id]);
  assert.equal(store.getDefinition(degraded.id)?.status, "stale");
  assert.equal(store.getDefinition(stopped.id)?.status, "stale");
  assert.equal(new OperationalTopology(graph).effectiveStatus("proxy-route:route-degraded"), "stale");
  assert.equal(new OperationalTopology(graph).effectiveStatus("agent-session:stopped-agent"), "stale");
  assert.deepEqual(events.map((event) => event.payload.status), ["stale", "stale"]);

  await supervisor.transition(degraded.id, "degraded");
  await supervisor.reconcile();
  assert.deepEqual(probeIds, [degraded.id, degraded.id]);
  assert.equal(store.getDefinition(degraded.id)?.status, "stale");
  assert.equal(store.getDefinition(stopped.id)?.status, "stale");
  store.close();
  graph.close();
});

test("transition ordering is store then topology then execution log", async () => {
  const dir = runtimeDir();
  const graph = graphWithHosts(dir);
  const store = new ConnectivityStore(join(dir, "state.sqlite"));
  const definition = store.upsertDefinition({ kind: "tunnel", externalId: "tun-1", fromHostRef: "host:a", toHostRef: "host:b" });
  const order: string[] = [];
  const topology = {
    upsertAgentSession() { throw new Error("unexpected"); },
    upsertShellSession() { throw new Error("unexpected"); },
    upsertProxyRoute() { throw new Error("unexpected"); },
    upsertTunnel() {
      assert.equal(store.getDefinition(definition.id)?.status, "degraded");
      order.push("topology");
      return "tunnel:tun-1";
    }
  };
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const supervisor = new ConnectivitySupervisor(
    store,
    topology,
    recordingLog(events, () => {
      assert.deepEqual(order, ["topology"]);
      order.push("log");
    }) as never
  );
  await supervisor.transition(definition.id, "degraded");
  assert.deepEqual(order, ["topology", "log"]);
  store.close();
  graph.close();
});

test("setting stopped persists stale before topology and execution log publication", async () => {
  const dir = runtimeDir();
  const graph = graphWithHosts(dir);
  const store = new ConnectivityStore(join(dir, "state.sqlite"));
  const definition = store.upsertDefinition({
    kind: "session",
    externalId: "agent-stop",
    hostRef: "host:a",
    status: "live"
  });
  const order: string[] = [];
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  let probeCalls = 0;
  const topology = {
    upsertAgentSession(input: { status?: string }) {
      assert.equal(store.getDefinition(definition.id)?.desiredState, "stopped");
      assert.equal(store.getDefinition(definition.id)?.status, "stale");
      assert.equal(input.status, "stale");
      order.push("topology");
      return "agent-session:agent-stop";
    },
    upsertShellSession() { throw new Error("unexpected"); },
    upsertProxyRoute() { throw new Error("unexpected"); },
    upsertTunnel() { throw new Error("unexpected"); }
  };
  const supervisor = new ConnectivitySupervisor(
    store,
    topology,
    recordingLog(events, () => {
      assert.equal(order.at(-1), "topology");
      order.push("log");
    }) as never,
    { probe: async () => { probeCalls += 1; return true; } }
  );

  const stopped = await supervisor.setDesiredState(definition.id, "stopped");
  assert.equal(stopped.status, "stale");
  const attemptedLive = await supervisor.transition(definition.id, "live");
  assert.equal(attemptedLive.status, "stale");
  await supervisor.initialize();
  assert.deepEqual(order, ["topology", "log", "topology", "log", "topology", "log"]);
  assert.deepEqual(events.map((event) => event.payload.status), ["stale", "stale", "stale"]);
  assert.equal(probeCalls, 0);
  assert.equal(store.claimSessionLease(definition.id, "run:blocked", 1_000), undefined);
  store.close();
  graph.close();
});

test("closed is terminal and the default adapter has no process side effects", async () => {
  const dir = runtimeDir();
  const graph = graphWithHosts(dir);
  const store = new ConnectivityStore(join(dir, "state.sqlite"));
  const definition = store.upsertDefinition({ kind: "route", externalId: "route-1", fromHostRef: "host:a", toHostRef: "host:b" });
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const supervisor = new ConnectivitySupervisor(store, new OperationalTopology(graph), recordingLog(events) as never);

  await supervisor.initialize();
  assert.equal(events.length, 0);
  await supervisor.transition(definition.id, "closed");
  await assert.rejects(() => supervisor.transition(definition.id, "live"), /cannot be reopened/);
  await assert.rejects(() => supervisor.setDesiredState(definition.id, "running"), /cannot be reopened/);
  assert.throws(() => store.upsertDefinition({
    kind: "route",
    externalId: "route-1",
    desiredState: "running"
  }), /cannot be reopened/);
  assert.equal(store.getDefinition(definition.id)?.desiredState, "closed");
  assert.equal(store.getDefinition(definition.id)?.status, "closed");
  store.close();
  graph.close();
});

test("run cleanup releases only its leases and leaves connectivity live", async () => {
  const dir = runtimeDir();
  const graph = graphWithHosts(dir);
  const store = new ConnectivityStore(join(dir, "state.sqlite"));
  const definition = store.upsertDefinition({
    kind: "session",
    externalId: "shared-agent",
    hostRef: "host:a",
    status: "live",
    concurrencySafe: true
  });
  let probeCalls = 0;
  const supervisor = new ConnectivitySupervisor(
    store,
    new OperationalTopology(graph),
    recordingLog([]) as never,
    { processAdapter: { async probe() { probeCalls += 1; return true; } } }
  );
  const own = supervisor.claimSessionLease(definition.id, "run:own", 1_000);
  const other = supervisor.claimSessionLease(definition.id, "run:other", 1_000);
  assert.ok(own && other);

  assert.equal(supervisor.finishRun("run:own"), 1);
  assert.deepEqual(store.listLeases().map((lease) => lease.ownerId), ["run:other"]);
  assert.equal(store.getDefinition(definition.id)?.status, "live");
  assert.equal(probeCalls, 0);
  store.close();
  graph.close();
});

test("withSessionLease releases on failure without closing the session", async () => {
  const dir = runtimeDir();
  const graph = graphWithHosts(dir);
  const store = new ConnectivityStore(join(dir, "state.sqlite"));
  const definition = store.upsertDefinition({ kind: "session", externalId: "shell-1", hostRef: "host:a", status: "live" });
  const supervisor = new ConnectivitySupervisor(store, new OperationalTopology(graph), recordingLog([]) as never);

  await assert.rejects(
    supervisor.withSessionLease({ sessionId: definition.id, ownerId: "run:1", ttlMs: 1_000 }, async () => {
      throw new Error("run failed");
    }),
    /run failed/
  );
  assert.equal(store.listLeases().length, 0);
  assert.equal(store.getDefinition(definition.id)?.status, "live");
  store.close();
  graph.close();
});

test("initialize shares concurrent work and can retry after failure", async () => {
  const dir = runtimeDir();
  const graph = graphWithHosts(dir);
  const store = new ConnectivityStore(join(dir, "state.sqlite"));
  store.upsertDefinition({
    kind: "route",
    externalId: "retry-initialize",
    fromHostRef: "host:a",
    toHostRef: "host:b",
    status: "live"
  });
  let rejectAppend!: (reason?: unknown) => void;
  let appendCalls = 0;
  let probeCalls = 0;
  const supervisor = new ConnectivitySupervisor(
    store,
    new OperationalTopology(graph),
    {
      append() {
        appendCalls += 1;
        if (appendCalls === 1) {
          return new Promise<never>((_resolve, reject) => { rejectAppend = reject; });
        }
        return Promise.resolve({} as never);
      }
    },
    { probe: async () => { probeCalls += 1; return false; } }
  );

  const first = supervisor.initialize();
  const concurrent = supervisor.initialize();
  assert.equal(concurrent, first);
  assert.equal(appendCalls, 1);
  rejectAppend(new Error("audit unavailable"));
  await assert.rejects(first, /audit unavailable/);

  const retry = supervisor.initialize();
  assert.notEqual(retry, first);
  await retry;
  assert.equal(probeCalls, 1);
  store.close();
  graph.close();
});

test("a failing probe is audited without aborting later probes", async () => {
  const dir = runtimeDir();
  const graph = graphWithHosts(dir);
  const store = new ConnectivityStore(join(dir, "state.sqlite"));
  const failed = store.upsertDefinition({
    kind: "route",
    externalId: "a-failed-probe",
    fromHostRef: "host:a",
    toHostRef: "host:b"
  });
  const succeeded = store.upsertDefinition({
    kind: "route",
    externalId: "b-successful-probe",
    fromHostRef: "host:a",
    toHostRef: "host:b"
  });
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const probed: string[] = [];
  const supervisor = new ConnectivitySupervisor(
    store,
    new OperationalTopology(graph),
    recordingLog(events) as never,
    {
      probe: async (definition) => {
        probed.push(definition.id);
        if (definition.id === failed.id) throw new Error("probe transport failed");
        return true;
      }
    }
  );

  await supervisor.initialize();
  assert.deepEqual(probed, [failed.id, succeeded.id]);
  assert.equal(store.getDefinition(failed.id)?.status, "stale");
  assert.equal(store.getDefinition(succeeded.id)?.status, "live");
  assert.deepEqual(events.map((event) => event.eventType), [
    "connectivity_probe_failed",
    "connectivity_status_changed"
  ]);
  assert.equal(events[0]?.payload.error, "probe transport failed");
  store.close();
  graph.close();
});

test("registry isolates supervisors by canonical runtime directory", async () => {
  const firstDir = runtimeDir("luanniao-connectivity-registry-a-");
  const secondDir = runtimeDir("luanniao-connectivity-registry-b-");
  const created: string[] = [];
  const stores: ConnectivityStore[] = [];
  const graphs: SQLiteGraphStore[] = [];
  const registry = new ConnectivitySupervisorRegistry((dir) => {
    created.push(dir);
    const graph = graphWithHosts(dir);
    const store = new ConnectivityStore(join(dir, "state.sqlite"));
    graphs.push(graph);
    stores.push(store);
    return new ConnectivitySupervisor(store, new OperationalTopology(graph), recordingLog([]) as never);
  });

  const first = await registry.get(firstDir);
  const firstAgain = await registry.get(join(firstDir, "."));
  const second = await registry.get(secondDir);
  assert.equal(firstAgain, first);
  assert.notEqual(second, first);
  assert.equal(registry.size, 2);
  assert.equal(created.length, 2);
  stores.forEach((store) => store.close());
  graphs.forEach((graph) => graph.close());
});
