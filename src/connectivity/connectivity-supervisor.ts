import { resolve } from "node:path";
import type { OperationalTopology } from "../operational-topology.js";
import type { ExecutionLog } from "../stores/execution-log.js";
import {
  ConnectivityStore,
  sanitizeConnectivityValue,
  type ConnectivityDefinition,
  type ConnectivityDesiredState,
  type ConnectivityLease
} from "../stores/connectivity-store.js";
import type { JsonObject, OperationalStatus } from "../types.js";

export type ConnectivityProbeResult = boolean | {
  live: boolean;
  status?: Extract<OperationalStatus, "live" | "degraded" | "stale">;
  details?: JsonObject;
};

export type ConnectivityProbe = (definition: ConnectivityDefinition) => Promise<ConnectivityProbeResult>;

export interface ConnectivityProcessAdapter {
  probe?: ConnectivityProbe;
  start?(definition: ConnectivityDefinition): Promise<string | undefined>;
  stop?(definition: ConnectivityDefinition): Promise<void>;
}

export const NOOP_CONNECTIVITY_PROCESS_ADAPTER: ConnectivityProcessAdapter = {};
export const NOOP_CONNECTIVITY_PROBE: ConnectivityProbe = async () => false;

type ConnectivityEventLog = Pick<ExecutionLog, "append">;
type ConnectivityTopology = Pick<
  OperationalTopology,
  "upsertAgentSession" | "upsertShellSession" | "upsertTunnel" | "upsertProxyRoute"
>;

export class ConnectivitySupervisor {
  private readonly clock: () => Date;
  private readonly probe: ConnectivityProbe;
  private initialization?: Promise<void>;

  constructor(
    readonly store: ConnectivityStore,
    private readonly topology: ConnectivityTopology,
    private readonly executionLog: ConnectivityEventLog,
    options: {
      clock?: () => Date;
      probe?: ConnectivityProbe;
      processAdapter?: ConnectivityProcessAdapter;
    } = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.probe = options.probe ?? options.processAdapter?.probe ?? NOOP_CONNECTIVITY_PROBE;
  }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    const initialization = this.reconcileDefinitions("connectivity_recovered_stale");
    this.initialization = initialization;
    void initialization.catch(() => {
      if (this.initialization === initialization) this.initialization = undefined;
    });
    return initialization;
  }

  async reconcile(): Promise<void> {
    await this.reconcileDefinitions("connectivity_reconciled_stale");
  }

  async transition(
    definitionId: string,
    status: OperationalStatus,
    details: JsonObject = {},
    heartbeat = status === "live" || status === "degraded"
  ): Promise<ConnectivityDefinition> {
    if (status === "closed") {
      this.store.updateDesiredState(definitionId, "closed");
    }
    const definition = this.store.updateStatus(definitionId, status, heartbeat);
    await this.publishStoredTransition(definition, "connectivity_status_changed", details);
    return definition;
  }

  async setDesiredState(definitionId: string, desiredState: ConnectivityDesiredState): Promise<ConnectivityDefinition> {
    const definition = this.store.updateDesiredState(definitionId, desiredState);
    await this.publishStoredTransition(definition, "connectivity_desired_state_changed", {});
    return definition;
  }

  claimSessionLease(sessionId: string, ownerId: string, ttlMs: number): ConnectivityLease | undefined {
    return this.store.claimSessionLease(sessionId, ownerId, ttlMs);
  }

  heartbeatSessionLease(lease: Pick<ConnectivityLease, "id" | "token">, ttlMs: number): ConnectivityLease | undefined {
    return this.store.heartbeatLease(lease.id, lease.token, ttlMs);
  }

  releaseSessionLease(lease: Pick<ConnectivityLease, "id" | "token">): boolean {
    return this.store.releaseLease(lease.id, lease.token);
  }

  finishRun(ownerId: string): number {
    return this.store.releaseOwnerLeases(ownerId);
  }

  async withSessionLease<T>(input: {
    sessionId: string;
    ownerId: string;
    ttlMs: number;
  }, run: (lease: ConnectivityLease) => Promise<T>): Promise<T> {
    const lease = this.claimSessionLease(input.sessionId, input.ownerId, input.ttlMs);
    if (!lease) throw new Error(`Session is already leased: ${input.sessionId}`);
    try {
      return await run(lease);
    } finally {
      this.releaseSessionLease(lease);
    }
  }

  private async reconcileDefinitions(staleEventType: string): Promise<void> {
    const recovered = this.store.markObservedStatusesStale();
    const published = new Set(recovered.map((definition) => definition.id));
    for (const definition of recovered) {
      await this.publishStoredTransition(definition, staleEventType, {});
    }
    for (const stored of this.store.listDefinitions()) {
      if (stored.desiredState === "stopped") {
        if (!published.has(stored.id)) {
          const definition = this.store.updateStatus(stored.id, "stale");
          await this.publishStoredTransition(definition, staleEventType, {});
        }
        continue;
      }
      if (stored.desiredState !== "running" || stored.status === "closed") continue;
      let normalized: ReturnType<typeof normalizeProbeResult>;
      try {
        normalized = normalizeProbeResult(await this.probe(stored));
      } catch (error) {
        await this.publishStoredTransition(stored, "connectivity_probe_failed", {
          reason: "connectivity_probe_failed",
          probedAt: this.clock().toISOString(),
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      if (normalized.live) {
        await this.transition(stored.id, normalized.status ?? "live", {
          reason: "connectivity_probe_succeeded",
          probedAt: this.clock().toISOString(),
          ...normalized.details
        }, true);
      }
    }
  }

  private async publishStoredTransition(
    definition: ConnectivityDefinition,
    eventType: string,
    details: JsonObject
  ): Promise<void> {
    const topologyRef = this.updateTopology(definition);
    await this.executionLog.append({
      role: "runtime",
      eventType,
      summary: `${definition.kind} ${definition.externalId} is ${definition.status}`,
      payload: {
        connectivityId: definition.id,
        topologyRef,
        kind: definition.kind,
        externalId: definition.externalId,
        desiredState: definition.desiredState,
        status: definition.status,
        lastHeartbeat: definition.lastHeartbeat,
        processRef: definition.processRef,
        controlRef: definition.controlRef,
        credentialRef: definition.credentialRef,
        ...(sanitizeConnectivityValue(details) as JsonObject)
      }
    });
  }

  private updateTopology(definition: ConnectivityDefinition): string {
    const properties: JsonObject = {
      connectivityId: definition.id,
      desiredState: definition.desiredState,
      processRef: definition.processRef,
      controlRef: definition.controlRef,
      credentialRef: definition.credentialRef,
      lastHeartbeat: definition.lastHeartbeat,
      ...definition.definition
    };
    if (definition.kind === "session") {
      if (!definition.hostRef) throw new Error(`Session ${definition.id} requires hostRef`);
      const input = {
        sessionId: definition.externalId,
        hostRef: definition.hostRef,
        status: definition.status,
        properties
      };
      return definition.sessionType === "shell"
        ? this.topology.upsertShellSession(input)
        : this.topology.upsertAgentSession(input);
    }
    if (!definition.fromHostRef || !definition.toHostRef) {
      throw new Error(`${definition.kind} ${definition.id} requires fromHostRef and toHostRef`);
    }
    return definition.kind === "tunnel"
      ? this.topology.upsertTunnel({
          tunnelId: definition.externalId,
          fromHostRef: definition.fromHostRef,
          toHostRef: definition.toHostRef,
          status: definition.status,
          properties
        })
      : this.topology.upsertProxyRoute({
          routeId: definition.externalId,
          fromHostRef: definition.fromHostRef,
          toHostRef: definition.toHostRef,
          status: definition.status,
          properties
        });
  }
}

export class ConnectivitySupervisorRegistry {
  private readonly entries = new Map<string, Promise<ConnectivitySupervisor>>();

  constructor(
    private readonly create: (runtimeDir: string) => Promise<ConnectivitySupervisor> | ConnectivitySupervisor,
    private readonly dispose?: (supervisor: ConnectivitySupervisor) => void | Promise<void>
  ) {}

  get(runtimeDir: string): Promise<ConnectivitySupervisor> {
    const key = resolve(runtimeDir);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = Promise.resolve(this.create(key)).then(async (supervisor) => {
        try {
          await supervisor.initialize();
          return supervisor;
        } catch (error) {
          await this.dispose?.(supervisor);
          throw error;
        }
      });
      this.entries.set(key, entry);
      void entry.catch(() => this.entries.delete(key));
    }
    return entry;
  }

  has(runtimeDir: string): boolean {
    return this.entries.has(resolve(runtimeDir));
  }

  get size(): number {
    return this.entries.size;
  }

  async close(runtimeDir: string): Promise<void> {
    const key = resolve(runtimeDir);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    const result = await Promise.allSettled([entry]);
    if (result[0].status === "fulfilled") await this.dispose?.(result[0].value);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    const supervisors = await Promise.allSettled(entries);
    await Promise.allSettled(supervisors.flatMap((result) =>
      result.status === "fulfilled" && this.dispose ? [this.dispose(result.value)] : []
    ));
  }
}

function normalizeProbeResult(result: ConnectivityProbeResult): {
  live: boolean;
  status?: Extract<OperationalStatus, "live" | "degraded" | "stale">;
  details?: JsonObject;
} {
  return typeof result === "boolean" ? { live: result } : result;
}
