import type { SQLiteGraphStore } from "./stores/graph-store.js";
import type { GraphEdge, GraphNode, JsonObject, OperationalStatus } from "./types.js";

const SESSION_TYPES = new Set(["AgentSession", "ShellSession", "Session"]);
const SENSITIVE_PROPERTY = /(?:secret|token|password|credential|body|cookie|authorization|privatekey)/i;

export type SessionTopologyInput = {
  sessionId: string;
  hostRef: string;
  label?: string;
  status?: OperationalStatus;
  properties?: JsonObject;
  evidenceRefs?: string[];
};

export type OperationalEdgeInput = {
  fromHostRef: string;
  toHostRef: string;
  status?: OperationalStatus;
  properties?: JsonObject;
  evidenceRefs?: string[];
};

export type TunnelTopologyInput = OperationalEdgeInput & { tunnelId: string };
export type ProxyRouteTopologyInput = OperationalEdgeInput & { routeId: string };

export class OperationalTopology {
  private readonly clock: () => Date;
  private readonly ttlMs: number;

  constructor(
    private readonly graphStore: SQLiteGraphStore,
    options: { clock?: () => Date; ttlMs?: number } = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
  }

  upsertAgentSession(input: SessionTopologyInput): string {
    return this.upsertSession("AgentSession", input);
  }

  upsertShellSession(input: SessionTopologyInput): string {
    return this.upsertSession("ShellSession", input);
  }

  upsertTunnel(input: TunnelTopologyInput): string {
    return this.upsertHostEdge("tunnels_to", "tunnelId", input.tunnelId, input);
  }

  upsertProxyRoute(input: ProxyRouteTopologyInput): string {
    return this.upsertHostEdge("proxy_route", "routeId", input.routeId, input);
  }

  transitionStatus(ref: string, status: OperationalStatus, properties: JsonObject = {}): void {
    const snapshot = this.operationSnapshot();
    const node = snapshot.nodes.find((candidate) => candidate.id === ref);
    if (node) {
      this.assertTransition(node.properties.status, status, ref);
      this.graphStore.upsertDelta({
        sourceEventIds: [],
        nodes: [{
          ...node,
          properties: this.statusProperties(node.properties, status, properties)
        }],
        edges: []
      });
      return;
    }
    const edge = snapshot.edges.find((candidate) => edgeIdentity(candidate) === ref);
    if (!edge) {
      throw new Error(`Operational topology ref not found: ${ref}`);
    }
    this.assertTransition(edge.properties?.status, status, ref);
    this.graphStore.upsertDelta({
      sourceEventIds: [],
      nodes: [],
      edges: [{
        ...edge,
        properties: this.statusProperties(edge.properties ?? {}, status, properties)
      }]
    });
  }

  effectiveStatus(ref: string): OperationalStatus | undefined {
    const snapshot = this.operationSnapshot();
    const entity = snapshot.nodes.find((candidate) => candidate.id === ref)
      ?? snapshot.edges.find((candidate) => edgeIdentity(candidate) === ref);
    if (!entity) {
      return undefined;
    }
    const properties = entity.properties ?? {};
    const status = operationalStatus(properties.status) ?? "live";
    if (status === "closed" || status === "stale") {
      return status;
    }
    const expiry = timestamp(properties.expiresAt);
    const activity = timestamp(properties.lastSeenAt ?? properties.updatedAt ?? properties.createdAt);
    if ((expiry !== undefined && this.clock().getTime() >= expiry)
      || (activity !== undefined && this.clock().getTime() - activity >= this.ttlMs)) {
      return "stale";
    }
    return status;
  }

  availableSessionRefs(): string[] {
    return this.graphStore.query("sessions", [], 10_000).nodes
      .filter((node) => SESSION_TYPES.has(node.type))
      .filter((node) => {
        const status = this.effectiveStatus(node.id);
        return status === "live" || status === "degraded";
      })
      .map((node) => node.id)
      .sort();
  }

  private upsertSession(type: "AgentSession" | "ShellSession", input: SessionTopologyInput): string {
    const sessionId = requiredIdentity(input.sessionId, "sessionId");
    this.requireHost(input.hostRef);
    const prefix = type === "AgentSession" ? "agent-session" : "shell-session";
    const nodeId = stableOperationalId(prefix, sessionId);
    const existing = this.findNode(nodeId);
    const status = input.status ?? operationalStatus(existing?.properties.status) ?? "live";
    this.assertTransition(existing?.properties.status, status, nodeId);
    const now = this.clock().toISOString();
    const properties = this.statusProperties(existing?.properties ?? {}, status, {
      ...sanitizeProperties(input.properties ?? {}),
      sessionId,
      [type === "AgentSession" ? "agentSessionId" : "shellSessionId"]: sessionId,
      lastSeenAt: now,
      expiresAt: new Date(this.clock().getTime() + this.ttlMs).toISOString()
    });
    this.graphStore.upsertDelta({
      sourceEventIds: [],
      nodes: [{
        id: nodeId,
        graphKind: "operation",
        type,
        label: input.label?.trim() || `${type} ${sessionId}`,
        properties,
        evidenceRefs: input.evidenceRefs ?? []
      }],
      edges: [{
        id: `session-on:${encodeURIComponent(nodeId)}`,
        from: nodeId,
        to: input.hostRef,
        type: "session_on",
        properties: { status },
        evidenceRefs: input.evidenceRefs ?? []
      }]
    });
    return nodeId;
  }

  private upsertHostEdge(
    type: "tunnels_to" | "proxy_route",
    identityKey: "tunnelId" | "routeId",
    identityValue: string,
    input: OperationalEdgeInput
  ): string {
    const identity = requiredIdentity(identityValue, identityKey);
    this.requireHost(input.fromHostRef);
    this.requireHost(input.toHostRef);
    const edgeId = stableOperationalId(type === "tunnels_to" ? "tunnel" : "proxy-route", identity);
    const existing = this.operationSnapshot().edges.find((edge) => edgeIdentity(edge) === edgeId);
    const status = input.status ?? operationalStatus(existing?.properties?.status) ?? "live";
    this.assertTransition(existing?.properties?.status, status, edgeId);
    this.graphStore.upsertDelta({
      sourceEventIds: [],
      nodes: [],
      edges: [{
        id: edgeId,
        from: input.fromHostRef,
        to: input.toHostRef,
        type,
        properties: this.statusProperties(existing?.properties ?? {}, status, {
          ...sanitizeProperties(input.properties ?? {}),
          [identityKey]: identity,
          lastSeenAt: this.clock().toISOString(),
          expiresAt: new Date(this.clock().getTime() + this.ttlMs).toISOString()
        }),
        evidenceRefs: input.evidenceRefs ?? []
      }]
    });
    return edgeId;
  }

  private statusProperties(
    existing: JsonObject,
    status: OperationalStatus,
    additions: JsonObject
  ): JsonObject {
    const now = this.clock().toISOString();
    return {
      ...sanitizeProperties(existing),
      ...sanitizeProperties(additions),
      status,
      updatedAt: now,
      ...(status === "closed" ? { closedAt: now } : {})
    };
  }

  private assertTransition(currentValue: unknown, next: OperationalStatus, ref: string): void {
    const current = operationalStatus(currentValue);
    if (current === "closed" && next !== "closed") {
      throw new Error(`Closed operational topology cannot be reopened: ${ref}`);
    }
  }

  private requireHost(ref: string): GraphNode {
    const node = this.findNode(ref);
    if (!node || node.type !== "Host") {
      throw new Error(`Operational topology requires an existing Host: ${ref}`);
    }
    return node;
  }

  private findNode(ref: string): GraphNode | undefined {
    return this.graphStore.query("operation", [ref], 10).nodes.find((node) => node.id === ref);
  }

  private operationSnapshot(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return this.graphStore.query("operation", [], 10_000);
  }
}

export function stableOperationalId(prefix: string, value: string): string {
  return `${prefix}:${encodeURIComponent(requiredIdentity(value, prefix))}`;
}

export function sanitizeProperties(value: JsonObject): JsonObject {
  return sanitizeValue(value) as JsonObject;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(Object.entries(value as JsonObject)
    .filter(([key]) => !SENSITIVE_PROPERTY.test(key))
    .map(([key, nested]) => [key, sanitizeValue(nested)]));
}

function requiredIdentity(value: string, name: string): string {
  const identity = value.trim();
  if (!identity) {
    throw new Error(`${name} must not be empty`);
  }
  return identity;
}

function edgeIdentity(edge: GraphEdge): string {
  return edge.id ?? `${edge.from}::${edge.type}::${edge.to}`;
}

function operationalStatus(value: unknown): OperationalStatus | undefined {
  return value === "live" || value === "degraded" || value === "stale" || value === "closed"
    ? value
    : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
