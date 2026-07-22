import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ConnectivityStore } from "../src/stores/connectivity-store.js";

function runtimeDatabase(): { runtimeDir: string; databasePath: string } {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-connectivity-store-"));
  return { runtimeDir, databasePath: join(runtimeDir, "state.sqlite") };
}

class LockObservingConnectivityStore extends ConnectivityStore {
  private observer?: DatabaseSync;
  private observations: boolean[] = [];

  observeLocksWith(observer: DatabaseSync): void {
    this.observer = observer;
  }

  takeLockObservations(): boolean[] {
    const observations = this.observations;
    this.observations = [];
    return observations;
  }

  override getDefinition(id: string) {
    if (this.observer) {
      try {
        this.observer.exec("BEGIN IMMEDIATE; ROLLBACK;");
        this.observations.push(false);
      } catch (error) {
        if (!(error instanceof Error) || !/database is locked/i.test(error.message)) throw error;
        this.observations.push(true);
      }
    }
    return super.getDefinition(id);
  }
}

test("connectivity definitions keep stable IDs and never persist embedded secrets", () => {
  const { databasePath } = runtimeDatabase();
  const store = new ConnectivityStore(databasePath);
  const first = store.upsertDefinition({
    kind: "session",
    externalId: "ssh/session 1",
    hostRef: "host:a",
    processRef: "pid:42",
    controlRef: "socket:control",
    credentialRef: "credential:operator",
    definition: {
      transport: "ssh",
      password: "do-not-store",
      nested: { authToken: "do-not-store", apiKey: "do-not-store", port: 22 },
      accessKey: "do-not-store",
      privateKey: "do-not-store",
      clientSecret: "do-not-store"
    }
  });
  const second = store.upsertDefinition({
    kind: "session",
    externalId: "ssh/session 1",
    hostRef: "host:a",
    definition: { transport: "ssh", safe: true }
  });

  assert.equal(first.id, "connectivity-session:ssh%2Fsession%201");
  assert.equal(second.id, first.id);
  assert.equal(second.desiredState, "running");
  assert.equal(store.listDefinitions().length, 1);
  assert.equal(second.credentialRef, "credential:operator");
  assert.deepEqual(second.definition, { transport: "ssh", safe: true });
  store.close();

  const databaseBytes = new DatabaseSync(databasePath, { readOnly: true });
  const rows = databaseBytes.prepare("SELECT * FROM connectivity_definitions").all();
  databaseBytes.close();
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes("do-not-store"), false);
  for (const sensitiveKey of ["password", "apiKey", "accessKey", "privateKey", "clientSecret"]) {
    assert.equal(serialized.includes(sensitiveKey), false);
  }
});

test("connectivity schema is idempotent and compatible with existing runtime tables", () => {
  const { databasePath } = runtimeDatabase();
  const existing = new DatabaseSync(databasePath);
  existing.exec("CREATE TABLE execution_events (seq INTEGER PRIMARY KEY, marker TEXT); INSERT INTO execution_events VALUES (1, 'kept');");
  existing.close();

  const first = new ConnectivityStore(databasePath);
  first.upsertDefinition({ kind: "route", externalId: "route-1", fromHostRef: "host:a", toHostRef: "host:b" });
  first.close();
  const second = new ConnectivityStore(databasePath);
  assert.equal(second.listDefinitions().length, 1);
  second.close();

  const check = new DatabaseSync(databasePath, { readOnly: true });
  const preserved = check.prepare("SELECT * FROM execution_events").get() as { seq: number; marker: string };
  assert.equal(preserved.seq, 1);
  assert.equal(preserved.marker, "kept");
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  check.close();
  assert.ok(tables.some(({ name }) => name === "connectivity_definitions"));
  assert.ok(tables.some(({ name }) => name === "connectivity_leases"));
});

test("legacy live desired-state schema migrates in place without losing definitions, leases, indexes, or other tables", () => {
  const { databasePath } = runtimeDatabase();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE execution_events (seq INTEGER PRIMARY KEY, marker TEXT);
    CREATE INDEX idx_execution_events_marker ON execution_events(marker);
    INSERT INTO execution_events VALUES (1, 'kept');
    CREATE TABLE connectivity_definitions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('session', 'tunnel', 'route')),
      external_id TEXT NOT NULL,
      desired_state TEXT NOT NULL CHECK(desired_state IN ('live', 'closed')),
      status TEXT NOT NULL CHECK(status IN ('live', 'degraded', 'stale', 'closed')),
      session_type TEXT,
      host_ref TEXT,
      from_host_ref TEXT,
      to_host_ref TEXT,
      concurrency_safe INTEGER NOT NULL DEFAULT 0,
      process_ref TEXT,
      control_ref TEXT,
      credential_ref TEXT,
      definition_json TEXT NOT NULL,
      last_heartbeat TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(kind, external_id)
    );
    CREATE INDEX idx_connectivity_legacy_external_id ON connectivity_definitions(external_id);
    CREATE TABLE connectivity_leases (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      claimed_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES connectivity_definitions(id) ON DELETE CASCADE
    );
    INSERT INTO connectivity_definitions VALUES (
      'connectivity-session:legacy', 'session', 'legacy', 'live', 'degraded', 'agent', 'host:a',
      NULL, NULL, 0, 'pid:1', 'control:1', 'credential:1',
      '{"transport":"ssh","password":"must-not-survive","nested":{"apiToken":"must-not-survive","port":22}}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO connectivity_leases VALUES (
      'lease:legacy', 'connectivity-session:legacy', 'run:legacy', 'hashed-token',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
    );
  `);
  legacy.close();

  const store = new ConnectivityStore(databasePath);
  const definition = store.getDefinition("connectivity-session:legacy");
  assert.equal(definition?.desiredState, "running");
  assert.equal(definition?.status, "degraded");
  assert.deepEqual(definition?.definition, { transport: "ssh", nested: { port: 22 } });
  assert.deepEqual(store.listLeases().map((lease) => lease.id), ["lease:legacy"]);
  store.close();

  const check = new DatabaseSync(databasePath);
  const schema = (check.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connectivity_definitions'").get() as { sql: string }).sql;
  assert.match(schema, /'running', 'stopped', 'closed'/);
  assert.throws(() => check.prepare(`
    INSERT INTO connectivity_definitions (
      id, kind, external_id, desired_state, status, concurrency_safe, definition_json, created_at, updated_at
    ) VALUES ('bad-live', 'route', 'bad-live', 'live', 'stale', 0, '{}', 'now', 'now')
  `).run(), /CHECK constraint failed/);
  const indexes = check.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
  assert.ok(indexes.some(({ name }) => name === "idx_connectivity_legacy_external_id"));
  assert.ok(indexes.some(({ name }) => name === "idx_execution_events_marker"));
  assert.deepEqual(check.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal((check.prepare("SELECT marker FROM execution_events WHERE seq = 1").get() as { marker: string }).marker, "kept");
  check.close();

  const reopened = new ConnectivityStore(databasePath);
  assert.equal(reopened.getDefinition("connectivity-session:legacy")?.desiredState, "running");
  assert.equal(reopened.listLeases().length, 1);
  reopened.close();
});

test("unsafe session leases support exclusion, heartbeat, release, and expiry", () => {
  const { databasePath } = runtimeDatabase();
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new ConnectivityStore(databasePath, { clock: () => now });
  const session = store.upsertDefinition({ kind: "session", externalId: "shell-1", hostRef: "host:a" });

  const first = store.claimSessionLease(session.id, "run:a", 1_000);
  assert.ok(first);
  assert.equal(store.claimSessionLease(session.id, "run:b", 1_000), undefined);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const columns = database.prepare("PRAGMA table_info(connectivity_leases)").all() as Array<{ name: string }>;
  const persistedLease = database.prepare("SELECT * FROM connectivity_leases WHERE id = ?").get(first.id);
  database.close();
  assert.ok(columns.some(({ name }) => name === "token_hash"));
  assert.equal(columns.some(({ name }) => name === "token"), false);
  assert.equal(JSON.stringify(persistedLease).includes(first.token), false);

  now = new Date("2026-01-01T00:00:00.800Z");
  const heartbeat = store.heartbeatLease(first.id, first.token, 1_000);
  assert.equal(heartbeat?.token, first.token);
  assert.equal(heartbeat?.expiresAt, "2026-01-01T00:00:01.800Z");
  now = new Date("2026-01-01T00:00:01.200Z");
  assert.equal(store.expireLeases(), 0);
  assert.equal(store.releaseLease(first.id, first.token), true);

  const released = store.claimSessionLease(session.id, "run:b", 500);
  assert.ok(released);
  now = new Date("2026-01-01T00:00:01.700Z");
  assert.equal(store.expireLeases(), 1);
  assert.ok(store.claimSessionLease(session.id, "run:c", 500));
  store.close();
});

test("concurrency-safe sessions allow parallel leases and owner cleanup is scoped", () => {
  const { databasePath } = runtimeDatabase();
  const store = new ConnectivityStore(databasePath);
  const session = store.upsertDefinition({
    kind: "session",
    externalId: "multiplexed",
    hostRef: "host:a",
    concurrencySafe: true
  });
  assert.ok(store.claimSessionLease(session.id, "run:a", 1_000));
  assert.ok(store.claimSessionLease(session.id, "run:b", 1_000));
  assert.equal(store.releaseOwnerLeases("run:a"), 1);
  assert.deepEqual(store.listLeases().map((lease) => lease.ownerId), ["run:b"]);
  store.close();
});

test("terminal-state mutations and lease claims read definitions after acquiring the write lock", () => {
  const { databasePath } = runtimeDatabase();
  const store = new LockObservingConnectivityStore(databasePath);
  const route = store.upsertDefinition({
    kind: "route",
    externalId: "locked-route",
    fromHostRef: "host:a",
    toHostRef: "host:b"
  });
  const session = store.upsertDefinition({
    kind: "session",
    externalId: "locked-session",
    hostRef: "host:a"
  });
  const observer = new DatabaseSync(databasePath);
  observer.exec("PRAGMA busy_timeout = 0;");
  store.observeLocksWith(observer);

  store.updateStatus(route.id, "live");
  assert.deepEqual(store.takeLockObservations(), [true, true]);
  store.updateDesiredState(route.id, "stopped");
  assert.deepEqual(store.takeLockObservations(), [true, true]);
  store.upsertDefinition({ kind: "route", externalId: "locked-route", desiredState: "running" });
  assert.deepEqual(store.takeLockObservations(), [true, true]);
  assert.ok(store.claimSessionLease(session.id, "run:locked", 1_000));
  assert.deepEqual(store.takeLockObservations(), [true]);

  observer.close();
  store.close();
});
