import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonObject, OperationalStatus } from "../types.js";

export type ConnectivityKind = "session" | "tunnel" | "route";
export type ConnectivityDesiredState = "running" | "stopped" | "closed";

export type ConnectivityDefinitionInput = {
  kind: ConnectivityKind;
  externalId: string;
  desiredState?: ConnectivityDesiredState;
  status?: OperationalStatus;
  sessionType?: "agent" | "shell";
  hostRef?: string;
  fromHostRef?: string;
  toHostRef?: string;
  concurrencySafe?: boolean;
  processRef?: string;
  controlRef?: string;
  credentialRef?: string;
  definition?: JsonObject;
};

export type ConnectivityDefinition = Omit<ConnectivityDefinitionInput, "desiredState" | "status" | "definition"> & {
  id: string;
  desiredState: ConnectivityDesiredState;
  status: OperationalStatus;
  definition: JsonObject;
  lastHeartbeat?: string;
  createdAt: string;
  updatedAt: string;
};

export type ConnectivityLease = {
  id: string;
  sessionId: string;
  ownerId: string;
  token: string;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
};

export type ConnectivityLeaseRecord = Omit<ConnectivityLease, "token">;

type DefinitionRow = {
  id: string;
  kind: ConnectivityKind;
  external_id: string;
  desired_state: ConnectivityDesiredState;
  status: OperationalStatus;
  session_type: "agent" | "shell" | null;
  host_ref: string | null;
  from_host_ref: string | null;
  to_host_ref: string | null;
  concurrency_safe: number;
  process_ref: string | null;
  control_ref: string | null;
  credential_ref: string | null;
  definition_json: string;
  last_heartbeat: string | null;
  created_at: string;
  updated_at: string;
};

type LegacyDefinitionRow = Omit<DefinitionRow, "desired_state"> & {
  desired_state: "live" | "closed";
};

type LeaseRow = {
  id: string;
  session_id: string;
  owner_id: string;
  claimed_at: string;
  heartbeat_at: string;
  expires_at: string;
};

const SENSITIVE_KEY = /(?:secret|token|password|passphrase|private.?key|api.?key|access.?key|authorization|cookie)/i;

export class ConnectivityStore {
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private readonly clock: () => Date;

  constructor(databasePath: string, options: { clock?: () => Date } = {}) {
    this.databasePath = databasePath;
    this.clock = options.clock ?? (() => new Date());
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.initialize();
  }

  close(): void {
    this.database.close();
  }

  upsertDefinition(input: ConnectivityDefinitionInput): ConnectivityDefinition {
    const externalId = required(input.externalId, "externalId");
    const id = stableConnectivityId(input.kind, externalId);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getDefinition(id);
      if (existing?.status === "closed"
        && ((input.status && input.status !== "closed") || (input.desiredState && input.desiredState !== "closed"))) {
        throw new Error(`Closed connectivity definition cannot be reopened: ${id}`);
      }
      const now = this.clock().toISOString();
      const desiredState = input.desiredState ?? existing?.desiredState ?? "running";
      const requestedStatus = input.status ?? existing?.status ?? "stale";
      const status = existing?.status === "closed" || desiredState === "closed"
        ? "closed"
        : desiredState === "stopped" ? "stale" : requestedStatus;
      this.database.prepare(`
        INSERT INTO connectivity_definitions (
          id, kind, external_id, desired_state, status, session_type, host_ref,
          from_host_ref, to_host_ref, concurrency_safe, process_ref, control_ref,
          credential_ref, definition_json, last_heartbeat, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          desired_state = excluded.desired_state,
          status = excluded.status,
          session_type = excluded.session_type,
          host_ref = excluded.host_ref,
          from_host_ref = excluded.from_host_ref,
          to_host_ref = excluded.to_host_ref,
          concurrency_safe = excluded.concurrency_safe,
          process_ref = excluded.process_ref,
          control_ref = excluded.control_ref,
          credential_ref = excluded.credential_ref,
          definition_json = excluded.definition_json,
          updated_at = excluded.updated_at
      `).run(
        id, input.kind, externalId, desiredState, status,
        input.sessionType ?? existing?.sessionType ?? null,
        input.hostRef ?? existing?.hostRef ?? null,
        input.fromHostRef ?? existing?.fromHostRef ?? null,
        input.toHostRef ?? existing?.toHostRef ?? null,
        (input.concurrencySafe ?? existing?.concurrencySafe ?? false) ? 1 : 0,
        input.processRef ?? existing?.processRef ?? null,
        input.controlRef ?? existing?.controlRef ?? null,
        input.credentialRef ?? existing?.credentialRef ?? null,
        JSON.stringify(sanitizeConnectivityValue(input.definition ?? existing?.definition ?? {}) as JsonObject),
        existing?.lastHeartbeat ?? null,
        existing?.createdAt ?? now,
        now
      );
      const definition = this.getDefinition(id)!;
      this.database.exec("COMMIT");
      return definition;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getDefinition(id: string): ConnectivityDefinition | undefined {
    const row = this.database.prepare("SELECT * FROM connectivity_definitions WHERE id = ?")
      .get(id) as DefinitionRow | undefined;
    return row ? definitionFromRow(row) : undefined;
  }

  listDefinitions(kind?: ConnectivityKind): ConnectivityDefinition[] {
    const rows = (kind
      ? this.database.prepare("SELECT * FROM connectivity_definitions WHERE kind = ? ORDER BY id").all(kind)
      : this.database.prepare("SELECT * FROM connectivity_definitions ORDER BY id").all()) as DefinitionRow[];
    return rows.map(definitionFromRow);
  }

  updateStatus(id: string, status: OperationalStatus, heartbeat = false): ConnectivityDefinition {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getDefinition(id);
      if (!current) throw new Error(`Connectivity definition not found: ${id}`);
      if (current.status === "closed" && status !== "closed") {
        throw new Error(`Closed connectivity definition cannot be reopened: ${id}`);
      }
      const persistedStatus = current.desiredState === "stopped" && status !== "closed" ? "stale" : status;
      const now = this.clock().toISOString();
      this.database.prepare(`
        UPDATE connectivity_definitions
        SET status = ?, last_heartbeat = CASE WHEN ? THEN ? ELSE last_heartbeat END, updated_at = ?
        WHERE id = ?
      `).run(persistedStatus, heartbeat && persistedStatus !== "stale" ? 1 : 0, now, now, id);
      const definition = this.getDefinition(id)!;
      this.database.exec("COMMIT");
      return definition;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  updateDesiredState(id: string, desiredState: ConnectivityDesiredState): ConnectivityDefinition {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getDefinition(id);
      if (!current) throw new Error(`Connectivity definition not found: ${id}`);
      if (current.status === "closed" && desiredState !== "closed") {
        throw new Error(`Closed connectivity definition cannot be reopened: ${id}`);
      }
      const status = desiredState === "closed" ? "closed" : desiredState === "stopped" ? "stale" : current.status;
      this.database.prepare(`
        UPDATE connectivity_definitions SET desired_state = ?, status = ?, updated_at = ? WHERE id = ?
      `).run(desiredState, status, this.clock().toISOString(), id);
      const definition = this.getDefinition(id)!;
      this.database.exec("COMMIT");
      return definition;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markObservedStatusesStale(kind?: ConnectivityKind): ConnectivityDefinition[] {
    const ids = (kind
      ? this.database.prepare("SELECT id FROM connectivity_definitions WHERE kind = ? AND status IN ('live', 'degraded') ORDER BY id").all(kind)
      : this.database.prepare("SELECT id FROM connectivity_definitions WHERE status IN ('live', 'degraded') ORDER BY id").all()) as Array<{ id: string }>;
    return ids.map(({ id }) => this.updateStatus(id, "stale"));
  }

  claimSessionLease(sessionId: string, ownerId: string, ttlMs: number): ConnectivityLease | undefined {
    required(ownerId, "ownerId");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("ttlMs must be positive");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const definition = this.getDefinition(sessionId);
      if (!definition || definition.kind !== "session") {
        throw new Error(`Session connectivity definition not found: ${sessionId}`);
      }
      if (definition.status === "closed" || definition.desiredState !== "running") {
        this.database.exec("COMMIT");
        return undefined;
      }
      const now = this.clock();
      this.deleteExpiredLeases(now.toISOString());
      if (!definition.concurrencySafe) {
        const active = this.database.prepare("SELECT id FROM connectivity_leases WHERE session_id = ? LIMIT 1")
          .get(sessionId);
        if (active) {
          this.database.exec("COMMIT");
          return undefined;
        }
      }
      const lease: ConnectivityLease = {
        id: `connectivity-lease:${randomUUID()}`,
        sessionId,
        ownerId,
        token: randomUUID(),
        claimedAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString()
      };
      this.database.prepare(`
        INSERT INTO connectivity_leases (id, session_id, owner_id, token_hash, claimed_at, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(lease.id, lease.sessionId, lease.ownerId, hashLeaseToken(lease.token), lease.claimedAt, lease.heartbeatAt, lease.expiresAt);
      this.database.exec("COMMIT");
      return lease;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeatLease(leaseId: string, token: string, ttlMs: number): ConnectivityLease | undefined {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("ttlMs must be positive");
    const now = this.clock();
    const result = this.database.prepare(`
      UPDATE connectivity_leases SET heartbeat_at = ?, expires_at = ?
      WHERE id = ? AND token_hash = ? AND expires_at > ?
    `).run(now.toISOString(), new Date(now.getTime() + ttlMs).toISOString(), leaseId, hashLeaseToken(token), now.toISOString());
    const record = Number(result.changes) === 1 ? this.getLease(leaseId) : undefined;
    return record ? { ...record, token } : undefined;
  }

  releaseLease(leaseId: string, token: string): boolean {
    return Number(this.database.prepare("DELETE FROM connectivity_leases WHERE id = ? AND token_hash = ?")
      .run(leaseId, hashLeaseToken(token)).changes) === 1;
  }

  releaseOwnerLeases(ownerId: string): number {
    return Number(this.database.prepare("DELETE FROM connectivity_leases WHERE owner_id = ?").run(ownerId).changes);
  }

  expireLeases(): number {
    return this.deleteExpiredLeases(this.clock().toISOString());
  }

  listLeases(sessionId?: string): ConnectivityLeaseRecord[] {
    const rows = (sessionId
      ? this.database.prepare("SELECT * FROM connectivity_leases WHERE session_id = ? ORDER BY claimed_at").all(sessionId)
      : this.database.prepare("SELECT * FROM connectivity_leases ORDER BY claimed_at").all()) as LeaseRow[];
    return rows.map(leaseFromRow);
  }

  private getLease(id: string): ConnectivityLeaseRecord | undefined {
    const row = this.database.prepare("SELECT * FROM connectivity_leases WHERE id = ?").get(id) as LeaseRow | undefined;
    return row ? leaseFromRow(row) : undefined;
  }

  private deleteExpiredLeases(now: string): number {
    return Number(this.database.prepare("DELETE FROM connectivity_leases WHERE expires_at <= ?").run(now).changes);
  }

  private initialize(): void {
    const existing = this.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connectivity_definitions'
    `).get() as { sql: string } | undefined;
    if (existing && /desired_state\s+IN\s*\(\s*'live'\s*,\s*'closed'\s*\)/i.test(existing.sql)) {
      this.migrateLegacyDesiredStateSchema();
    }
    this.database.exec(`
      ${connectivityDefinitionsTableSql("connectivity_definitions", true)}
      CREATE TABLE IF NOT EXISTS connectivity_leases (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        claimed_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES connectivity_definitions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_connectivity_definitions_kind_status
        ON connectivity_definitions(kind, status);
      CREATE INDEX IF NOT EXISTS idx_connectivity_leases_session_expiry
        ON connectivity_leases(session_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_connectivity_leases_owner
        ON connectivity_leases(owner_id);
    `);
  }

  private migrateLegacyDesiredStateSchema(): void {
    const foreignKeys = this.database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    const schemaObjects = this.database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE tbl_name = 'connectivity_definitions' AND type IN ('index', 'trigger') AND sql IS NOT NULL
      ORDER BY type, name
    `).all() as Array<{ sql: string }>;
    if (foreignKeys.foreign_keys) this.database.exec("PRAGMA foreign_keys = OFF");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.database.prepare("SELECT * FROM connectivity_definitions ORDER BY id").all() as LegacyDefinitionRow[];
      this.database.exec(connectivityDefinitionsTableSql("connectivity_definitions_new", false));
      const insert = this.database.prepare(`
        INSERT INTO connectivity_definitions_new (
          id, kind, external_id, desired_state, status, session_type, host_ref,
          from_host_ref, to_host_ref, concurrency_safe, process_ref, control_ref,
          credential_ref, definition_json, last_heartbeat, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        const definition = sanitizeConnectivityValue(JSON.parse(row.definition_json)) as JsonObject;
        insert.run(
          row.id, row.kind, row.external_id, row.desired_state === "live" ? "running" : "closed", row.status,
          row.session_type, row.host_ref, row.from_host_ref, row.to_host_ref, row.concurrency_safe,
          row.process_ref, row.control_ref, row.credential_ref, JSON.stringify(definition), row.last_heartbeat,
          row.created_at, row.updated_at
        );
      }
      this.database.exec("DROP TABLE connectivity_definitions; ALTER TABLE connectivity_definitions_new RENAME TO connectivity_definitions;");
      for (const object of schemaObjects) this.database.exec(object.sql);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      if (foreignKeys.foreign_keys) this.database.exec("PRAGMA foreign_keys = ON");
    }
  }
}

function connectivityDefinitionsTableSql(tableName: string, ifNotExists: boolean): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${tableName} (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('session', 'tunnel', 'route')),
    external_id TEXT NOT NULL,
    desired_state TEXT NOT NULL CHECK(desired_state IN ('running', 'stopped', 'closed')),
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
  );`;
}

export function stableConnectivityId(kind: ConnectivityKind, externalId: string): string {
  return `connectivity-${kind}:${encodeURIComponent(required(externalId, "externalId"))}`;
}

export function sanitizeConnectivityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeConnectivityValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonObject)
    .filter(([key]) => !SENSITIVE_KEY.test(key))
    .map(([key, nested]) => [key, sanitizeConnectivityValue(nested)]));
}

function definitionFromRow(row: DefinitionRow): ConnectivityDefinition {
  return {
    id: row.id,
    kind: row.kind,
    externalId: row.external_id,
    desiredState: row.desired_state,
    status: row.status,
    sessionType: row.session_type ?? undefined,
    hostRef: row.host_ref ?? undefined,
    fromHostRef: row.from_host_ref ?? undefined,
    toHostRef: row.to_host_ref ?? undefined,
    concurrencySafe: Boolean(row.concurrency_safe),
    processRef: row.process_ref ?? undefined,
    controlRef: row.control_ref ?? undefined,
    credentialRef: row.credential_ref ?? undefined,
    definition: JSON.parse(row.definition_json) as JsonObject,
    lastHeartbeat: row.last_heartbeat ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function leaseFromRow(row: LeaseRow): ConnectivityLeaseRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at
  };
}

function hashLeaseToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  return normalized;
}
