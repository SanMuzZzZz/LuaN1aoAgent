import { createHash } from "node:crypto";
import type { GraphEdge, GraphNode } from "./types.js";

const SESSION_TYPES = new Set(["AgentSession", "ShellSession", "Session"]);

export function operationIdentityKeys(nodes: GraphNode[], edges: GraphEdge[]): Map<string, string> {
  const operationNodes = new Map(nodes
    .filter((node) => node.graphKind === "operation")
    .map((node) => [node.id, node]));
  const keys = new Map<string, string>();

  for (const node of operationNodes.values()) {
    const direct = directOperationIdentityKey(node);
    if (direct) {
      keys.set(node.id, direct);
    }
  }

  const parentEdges = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const current = parentEdges.get(edge.to) ?? [];
    current.push(edge);
    parentEdges.set(edge.to, current);
  }

  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    for (const node of operationNodes.values()) {
      if (keys.has(node.id)) {
        continue;
      }
      const contextual = contextualOperationIdentityKey(node, parentEdges.get(node.id) ?? [], keys);
      if (contextual) {
        keys.set(node.id, contextual);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return keys;
}

export function stableOperationIdentityId(identityKey: string): string {
  return `op:${createHash("sha256").update(identityKey).digest("hex").slice(0, 24)}`;
}

export function stableSessionNodeId(node: Pick<GraphNode, "type" | "properties">): string | undefined {
  if (!SESSION_TYPES.has(node.type)) {
    return undefined;
  }
  const value = node.type === "AgentSession"
    ? node.properties.sessionId ?? node.properties.agentSessionId
    : node.type === "ShellSession"
      ? node.properties.sessionId ?? node.properties.shellSessionId
      : node.properties.sessionId ?? node.properties.agentSessionId ?? node.properties.shellSessionId;
  const identity = typeof value === "string" ? value.trim() : "";
  return identity ? `${sessionPrefix(node.type)}:${encodeURIComponent(identity)}` : undefined;
}

function directOperationIdentityKey(node: GraphNode): string | undefined {
  if (node.type === "Host") {
    const host = normalizedHost(
      node.properties.host ?? node.properties.hostname ?? node.properties.ip ?? node.properties.url ?? node.label
    );
    return host ? `host:${host}` : undefined;
  }
  if (SESSION_TYPES.has(node.type)) {
    return stableSessionNodeId(node);
  }
  if (node.type === "Port") {
    const host = normalizedHost(node.properties.host ?? node.properties.hostname);
    const port = normalizedPort(node.properties.port) ?? portFromLabel(node.label);
    const protocol = normalizedProtocol(node.properties.protocol) ?? protocolFromLabel(node.label) ?? "tcp";
    return host && port ? `port:host:${host}:${port}/${protocol}` : undefined;
  }
  if (node.type === "Service") {
    const endpoint = normalizedUrl(node.properties.url);
    const host = endpoint?.hostname ?? normalizedHost(node.properties.host ?? node.properties.hostname);
    const port = endpoint?.port || normalizedPort(node.properties.port) || defaultPort(endpoint?.protocol);
    const service = serviceFromNode(node);
    return host && port && service ? `service:host:${host}:${port}/${service}` : undefined;
  }
  if (node.type === "WebEndpoint") {
    const endpoint = normalizedUrl(node.properties.url);
    const host = endpoint?.hostname ?? normalizedHost(node.properties.host ?? node.properties.hostname);
    const port = endpoint?.port || normalizedPort(node.properties.port) || defaultPort(endpoint?.protocol);
    const protocol = normalizedProtocol(endpoint?.protocol ?? node.properties.protocol ?? node.properties.scheme);
    const path = normalizedPath(endpoint?.pathname ?? node.properties.path) ?? pathFromLabel(node.label);
    const method = normalizedMethod(node.properties.method) ?? methodFromLabel(node.label) ?? "GET";
    return host && port && protocol && path
      ? `endpoint:${protocol}://host:${host}:${port}:${method}:${path}`
      : undefined;
  }
  if (node.type === "Parameter") {
    const endpoint = normalizedUrl(node.properties.endpoint ?? node.properties.url);
    const host = endpoint?.hostname ?? normalizedHost(node.properties.host ?? node.properties.hostname);
    const port = endpoint?.port || normalizedPort(node.properties.port) || defaultPort(endpoint?.protocol);
    const protocol = normalizedProtocol(endpoint?.protocol ?? node.properties.protocol ?? node.properties.scheme);
    const path = normalizedPath(endpoint?.pathname ?? node.properties.path);
    const name = normalizedName(node.properties.name);
    const location = normalizedName(node.properties.location ?? node.properties.in);
    return name && location && host && port && protocol && path
      ? `parameter:${protocol}://host:${host}:${port}:${path}:${location}:${name}`
      : undefined;
  }
  return undefined;
}

function contextualOperationIdentityKey(
  node: GraphNode,
  parentEdges: GraphEdge[],
  keys: Map<string, string>
): string | undefined {
  if (node.type === "Port") {
    const parent = parentIdentity(parentEdges, "has_port", keys);
    const port = normalizedPort(node.properties.port) ?? portFromLabel(node.label);
    const protocol = normalizedProtocol(node.properties.protocol) ?? protocolFromLabel(node.label) ?? "tcp";
    return parent && port ? `port:${parent}:${port}/${protocol}` : undefined;
  }
  if (node.type === "Service") {
    const parent = parentIdentity(parentEdges, "runs_service", keys);
    const service = serviceFromNode(node);
    const endpoint = parent ? endpointFromPortIdentity(parent) : undefined;
    return endpoint && service ? `service:${endpoint.hostKey}:${endpoint.port}/${service}` : undefined;
  }
  if (node.type === "WebEndpoint") {
    const parent = parentIdentity(parentEdges, "exposes_endpoint", keys);
    const method = normalizedMethod(node.properties.method) ?? methodFromLabel(node.label) ?? "GET";
    const path = normalizedPath(node.properties.path) ?? pathFromLabel(node.label);
    const service = parent ? endpointFromServiceIdentity(parent) : undefined;
    return service && path
      ? `endpoint:${service.protocol}://${service.hostKey}:${service.port}:${method}:${path}`
      : undefined;
  }
  if (node.type === "Parameter") {
    const parent = parentIdentity(parentEdges, "has_parameter", keys);
    const name = normalizedName(node.properties.name) ?? parameterNameFromLabel(node.label);
    const location = normalizedName(node.properties.location ?? node.properties.in) ?? "unknown";
    const endpoint = parent ? endpointFromEndpointIdentity(parent) : undefined;
    return endpoint && name
      ? `parameter:${endpoint.protocol}://${endpoint.hostKey}:${endpoint.port}:${endpoint.path}:${location}:${name}`
      : undefined;
  }
  return undefined;
}

function parentIdentity(edges: GraphEdge[], type: string, keys: Map<string, string>): string | undefined {
  for (const edge of edges) {
    if (edge.type === type) {
      const identity = keys.get(edge.from);
      if (identity) {
        return identity;
      }
    }
  }
  return undefined;
}

function endpointFromPortIdentity(identity: string): { hostKey: string; port: string } | undefined {
  const match = identity.match(/^port:(host:.+):(\d+)\/[^/]+$/);
  return match ? { hostKey: match[1]!, port: match[2]! } : undefined;
}

function endpointFromServiceIdentity(identity: string): {
  hostKey: string;
  port: string;
  protocol: string;
} | undefined {
  const match = identity.match(/^service:(host:.+):(\d+)\/([^/]+)$/);
  return match ? { hostKey: match[1]!, port: match[2]!, protocol: match[3]! } : undefined;
}

function endpointFromEndpointIdentity(identity: string): {
  protocol: string;
  hostKey: string;
  port: string;
  path: string;
} | undefined {
  const match = identity.match(/^endpoint:([^:]+):\/\/(host:.+):(\d+):[A-Z]+:(\/.*)$/);
  return match
    ? { protocol: match[1]!, hostKey: match[2]!, port: match[3]!, path: match[4]! }
    : undefined;
}

function sessionPrefix(type: string): string {
  return type === "AgentSession" ? "agent-session" : type === "ShellSession" ? "shell-session" : "session";
}

function normalizedUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  try {
    return new URL(value.trim());
  } catch {
    return undefined;
  }
}

function normalizedHost(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  const parsed = normalizedUrl(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
  const host = parsed?.hostname || trimmed.replace(/^\[|\]$/g, "").split(":")[0];
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return normalized || undefined;
}

function normalizedPort(value: unknown): string | undefined {
  const port = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return /^\d{1,5}$/.test(port) && Number(port) <= 65535 ? String(Number(port)) : undefined;
}

function normalizedProtocol(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const protocol = value.trim().toLowerCase().replace(/:$/, "");
  return protocol || undefined;
}

function normalizedMethod(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const method = value.trim().toUpperCase();
  return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method) ? method : undefined;
}

function normalizedPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const path = value.trim().split(/[?#]/, 1)[0].replace(/\/{2,}/g, "/");
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizedName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function defaultPort(protocol: string | undefined): string | undefined {
  return protocol === "https:" || protocol === "https" ? "443"
    : protocol === "http:" || protocol === "http" ? "80"
      : undefined;
}

function portFromLabel(label: string): string | undefined {
  return normalizedPort(label.match(/\b(\d{1,5})\b/)?.[1]);
}

function protocolFromLabel(label: string): string | undefined {
  return normalizedProtocol(label.match(/\b(tcp|udp)\b/i)?.[1]);
}

function serviceFromNode(node: GraphNode): string | undefined {
  const configured = normalizedProtocol(node.properties.service ?? node.properties.protocol);
  if (configured) {
    return configured;
  }
  return normalizedProtocol(node.label.match(/^([a-z][a-z0-9+.-]*)\b/i)?.[1]);
}

function methodFromLabel(label: string): string | undefined {
  return normalizedMethod(label.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i)?.[1]);
}

function pathFromLabel(label: string): string | undefined {
  return normalizedPath(label.match(/(?:^|\s)(\/[^\s→]*)/)?.[1]);
}

function parameterNameFromLabel(label: string): string | undefined {
  return normalizedName(label.match(/^([^\s:(]+)/)?.[1]);
}
