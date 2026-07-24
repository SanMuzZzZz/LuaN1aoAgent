import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebAuthError, WebAuthService, type WebUser } from "./web-auth.js";
import { SecurityAgentController } from "./controller.js";
import { loadLocalEnvFile } from "./llm-config.js";
import {
  bootstrapAgentRuntime,
  createAgentTrafficProxyRegistry,
  type AgentRuntimeLifecycle
} from "./agent-runtime-bootstrap.js";
import {
  ConnectivitySupervisor,
  ConnectivitySupervisorRegistry
} from "./connectivity/connectivity-supervisor.js";
import {
  TrafficProxyClient,
  TrafficProxyControlError,
  type TrafficHeaderEntry,
  type TrafficProxyContext,
  type TrafficReplayInput,
  type TrafficReplayResult
} from "./connectivity/traffic-proxy-client.js";
import { TrafficProxyManager } from "./connectivity/traffic-proxy-manager.js";
import { SessionBroker, type SshSessionDefinition } from "./connectivity/session-broker.js";
import { TunnelManager, type SshForward, type SshTunnelDefinition } from "./connectivity/tunnel-manager.js";
import { OperationalTopology } from "./operational-topology.js";
import { ConnectivityStore, type ConnectivityDefinition } from "./stores/connectivity-store.js";
import { ExecutionLog } from "./stores/execution-log.js";
import { SQLiteGraphStore } from "./stores/graph-store.js";
import { discoverRuntimeSessionDirs } from "./runtime-session-discovery.js";
import { RuntimePathPolicy, RuntimePathPolicyError } from "./runtime-path-policy.js";
import {
  clearCsrfCookie,
  createCsrfToken,
  csrfCookie,
  csrfCookieName,
  hasCapability,
  requireRuntimeAccess,
  validateMutationRequest,
  WebSecurityError
} from "./web-security.js";
import {
  selectExactToolCallId,
  selectTraceIntent,
  summarizePlannerCommands,
  summarizeTraceAction,
  traceActionHeading,
  traceNextStep,
  type TraceIntentSource,
  type TraceToolCall
} from "./web-trace-presentation.js";

type JsonRecord = Record<string, unknown>;

type WebNode = {
  id: string;
  graphKind: string;
  type: string;
  label: string;
  properties: JsonRecord;
  evidenceRefs: string[];
  updatedAt?: string;
};

type WebEdge = {
  id?: string;
  from: string;
  to: string;
  type: string;
  properties: JsonRecord;
  evidenceRefs: string[];
  updatedAt?: string;
};

type WebEvent = {
  id: string;
  taskId?: string;
  role: string;
  eventType: string;
  timestamp: string;
  summary?: string;
  payload: JsonRecord;
  artifactRefs?: string[];
};

type TraceItem = {
  id: string;
  eventId: string;
  timestamp: string;
  taskId?: string;
  role: string;
  eventType: string;
  eventLabel: string;
  stage: string;
  title: string;
  summary: string;
  intentSource: TraceIntentSource;
  detail: string;
  decision?: string;
  action?: string;
  observation?: string;
  next?: string;
  commandDetails?: string[];
  evidenceRefs: string[];
  artifactRefs: string[];
  graphNodeRefs: string[];
  tool?: ToolTrace;
  rawEvent: JsonRecord;
};

type ToolTrace = {
  toolCallId: string;
  toolName: string;
  command?: string;
  status: string;
  isError: boolean;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  updateCount: number;
  eventCount: number;
  result: string;
  resultPreview: string;
  lifecycle: Array<{ eventType: string; timestamp: string; summary?: string }>;
};

type ArtifactRecord = {
  artifactRef: string;
  taskId?: string;
  kind?: string;
  mediaType?: string;
  path?: string;
  byteLength?: number;
  createdAt?: string;
  preview?: string;
};

type RuntimeSession = {
  name: string;
  runtimeDir: string;
  relativePath: string;
  isRoot: boolean;
  updatedAt?: string;
  source: string;
  nodeCount: number;
  edgeCount: number;
  taskCount: number;
  eventCount: number;
  artifactCount: number;
  goal?: string;
  latestTask?: string;
  latestTaskStatus?: string;
  running?: boolean;
};

type ActiveRun = {
  runtimeDir: string;
  runtimeInput: string;
  goal: string;
  scope: string;
  startedAt: string;
  controller: SecurityAgentController;
  agentRuntime: AgentRuntimeLifecycle;
  connectivitySupervisor: ConnectivitySupervisor;
  completion?: Promise<void>;
};

const args = parseArgs(process.argv.slice(2));
loadLocalEnvFile(process.env);
const host = args.host ?? (process.env.WEB_HOST?.trim() || "127.0.0.1");
const port = parseWebPort(args.port ?? process.env.WEB_PORT ?? "8787");
const cwd = process.cwd();
const staticRoot = resolve(cwd, "web", "dist");
const defaultRuntimeDir = args["runtime-dir"] ?? ".agent-runtime";
const authService = new WebAuthService(resolve(cwd, args["auth-db"] ?? ".agent-runtime/web-auth.sqlite"));
const runtimePathPolicy = await RuntimePathPolicy.create(defaultRuntimeDir, { baseDir: cwd });
const sessionCookieName = "luanniao_session";
const MAX_CONCURRENT_TRAFFIC_REPLAYS = 4;
let activeTrafficReplays = 0;
const activeRuns = new Map<string, ActiveRun>();
const connectivityManagers = new Map<string, {
  store: ConnectivityStore;
  graphStore: SQLiteGraphStore;
  tunnels: TunnelManager;
  sessions: SessionBroker;
}>();
const connectivitySupervisorResources = new WeakMap<ConnectivitySupervisor, {
  store: ConnectivityStore;
  graphStore: SQLiteGraphStore;
  executionLog: ExecutionLog;
}>();
const connectivityRegistry = new ConnectivitySupervisorRegistry((runtimeDir) => {
  const databasePath = join(runtimeDir, "state.sqlite");
  const store = new ConnectivityStore(databasePath);
  const graphStore = new SQLiteGraphStore(databasePath, join(runtimeDir, "graph-deltas.jsonl"));
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"), databasePath);
  const supervisor = new ConnectivitySupervisor(store, new OperationalTopology(graphStore), executionLog);
  connectivitySupervisorResources.set(supervisor, { store, graphStore, executionLog });
  return supervisor;
}, (supervisor) => {
  const resources = connectivitySupervisorResources.get(supervisor);
  if (!resources) return;
  connectivitySupervisorResources.delete(supervisor);
  resources.executionLog.close();
  resources.graphStore.close();
  resources.store.close();
});
const trafficProxyRegistry = createAgentTrafficProxyRegistry();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
    if (url.pathname.startsWith("/api/")) {
      validateMutationRequest(request, readCookie(request, csrfCookieName));
    }
    if (url.pathname.startsWith("/api/auth/")) {
      await handleAuthRequest(request, response, url.pathname);
      return;
    }

    let user: WebUser | undefined;
    if (url.pathname.startsWith("/api/")) {
      user = authService.authenticate(readCookie(request, sessionCookieName));
      if (!user) {
        await sendJson(response, { error: { code: "unauthorized", message: "请先登录" } }, 401);
        return;
      }
    }
    if (url.pathname === "/api/state") {
      requireRuntimeAccess(user!, "viewer:metadata");
      const runtimeDir = url.searchParams.get("runtimeDir") ?? defaultRuntimeDir;
      const state = await readRuntimeState(runtimeDir);
      await sendJson(response, hasCapability(user!, "admin:credential") ? state : redactCredentialRefs(state));
      return;
    }
    if (url.pathname === "/api/sessions") {
      requireRuntimeAccess(user!, "viewer:metadata");
      const rootDir = url.searchParams.get("rootDir") ?? defaultRuntimeDir;
      await sendJson(response, await readRuntimeSessions(rootDir));
      return;
    }
    if (url.pathname === "/api/runs") {
      if (request.method === "POST") {
        requireRuntimeAccess(user!, "operator:mutate");
        await handleStartRun(request, response);
        return;
      }
      if (request.method === "GET") {
        requireRuntimeAccess(user!, "viewer:metadata");
        await sendJson(response, listActiveRuns());
        return;
      }
      await sendJson(response, { error: { code: "method_not_allowed", message: "仅支持 GET/POST" } }, 405);
      return;
    }
    if (url.pathname === "/api/runs/stop") {
      if (request.method !== "POST") {
        await sendJson(response, { error: { code: "method_not_allowed", message: "仅支持 POST" } }, 405);
        return;
      }
      requireRuntimeAccess(user!, "operator:mutate");
      await handleStopRun(request, response);
      return;
    }
    if (url.pathname === "/api/connectivity") {
      if (request.method !== "GET") {
        await sendJson(response, { error: { code: "method_not_allowed", message: "仅支持 GET" } }, 405);
        return;
      }
      requireRuntimeAccess(user!, "viewer:metadata");
      await sendJson(response, await readConnectivity(url, hasCapability(user!, "admin:credential")));
      return;
    }
    if (url.pathname === "/api/connectivity/tunnels" || url.pathname === "/api/connectivity/sessions") {
      if (request.method !== "POST") {
        await sendJson(response, { error: { code: "method_not_allowed", message: "仅支持 POST" } }, 405);
        return;
      }
      requireRuntimeAccess(user!, "connectivity:manage");
      await handleCreateConnectivity(request, response, url.pathname.endsWith("/tunnels") ? "tunnel" : "session");
      return;
    }
    const connectivityActionRoute = /^\/api\/connectivity\/([^/]+)\/(start|stop|close)$/.exec(url.pathname);
    if (connectivityActionRoute) {
      if (request.method !== "POST") {
        await sendJson(response, { error: { code: "method_not_allowed", message: "仅支持 POST" } }, 405);
        return;
      }
      requireRuntimeAccess(user!, "connectivity:manage");
      await handleConnectivityAction(request, response, decodeURIComponent(connectivityActionRoute[1]), connectivityActionRoute[2] as "start" | "stop" | "close");
      return;
    }
    if (url.pathname === "/api/traffic/history") {
      if (request.method !== "GET") {
        await sendJson(response, { error: { code: "method_not_allowed", message: "仅支持 GET" } }, 405);
        return;
      }
      requireRuntimeAccess(user!, "traffic:read-sensitive");
      await sendJson(response, await readTrafficHistory(url));
      return;
    }
    if (url.pathname === "/api/traffic/ca") {
      if (request.method !== "GET") {
        await sendJson(response, { error: { code: "method_not_allowed", message: "仅支持 GET" } }, 405);
        return;
      }
      requireRuntimeAccess(user!, "traffic:read-sensitive");
      await sendPublicCa(response, url);
      return;
    }
    const trafficReplayRoute = /^\/api\/traffic\/history\/(\d+)\/replay$/.exec(url.pathname);
    if (trafficReplayRoute) {
      if (request.method !== "POST") {
        await sendJson(response, { error: { code: "method_not_allowed", message: "仅支持 POST" } }, 405);
        return;
      }
      requireRuntimeAccess(user!, "traffic:replay");
      await handleTrafficReplay(request, response, user!, Number(trafficReplayRoute[1]));
      return;
    }
    const trafficRoute = /^\/api\/traffic\/history\/(\d+)(\/body)?$/.exec(url.pathname);
    if (trafficRoute) {
      if (request.method !== "GET") {
        await sendJson(response, { error: { code: "method_not_allowed", message: "仅支持 GET" } }, 405);
        return;
      }
      requireRuntimeAccess(user!, "traffic:read-sensitive");
      await sendJson(response, await readTrafficExchange(url, Number(trafficRoute[1]), Boolean(trafficRoute[2])));
      return;
    }
    if (url.pathname === "/api/artifact") {
      requireRuntimeAccess(user!, "traffic:read-sensitive");
      const runtimeDir = url.searchParams.get("runtimeDir") ?? defaultRuntimeDir;
      const artifactRef = url.searchParams.get("artifactRef") ?? "";
      await sendJson(response, await readArtifactContent(runtimeDir, artifactRef));
      return;
    }
    await sendStatic(url.pathname, response);
  } catch (error) {
    if (error instanceof WebAuthError || error instanceof WebSecurityError) {
      await sendJson(response, { error: { code: error.code, message: error.message } }, error.statusCode);
      return;
    }
    if (error instanceof RuntimePathPolicyError) {
      const statusCode = error.code === "runtime_path_not_found" ? 404 : error.code === "runtime_path_outside_root" ? 403 : 400;
      await sendJson(response, { error: { code: error.code, message: error.message } }, statusCode);
      return;
    }
    if (error instanceof HttpError) {
      await sendJson(response, { error: { code: error.code, message: error.message } }, error.statusCode);
      return;
    }
    console.error("[web request failed]", error instanceof Error ? error.message : String(error));
    await sendJson(response, { error: { code: "internal_error", message: "服务器内部错误" } }, 500);
  }
});

class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

server.listen(port, host, () => {
  console.log(`Luanniao Agent Trace listening on http://${host}:${port}`);
  console.log(`Runtime dir: ${runtimePathPolicy.rootDir}`);
  if (!isLoopbackHost(host)) {
    console.error("Warning: web workbench is bound beyond loopback; traffic-proxy data and runtime artifacts are reachable to anyone who can authenticate. Only do this on a trusted network.");
  }
});

let shutdownPromise: Promise<void> | undefined;
const shutdown = (signal: NodeJS.Signals): Promise<void> => {
  if (shutdownPromise) {
    server.closeAllConnections();
    return shutdownPromise;
  }
  shutdownPromise = (async () => {
    console.log(`Received ${signal}; stopping web server and active runs`);
    const serverClosed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    const runs = [...activeRuns.values()];
    await Promise.allSettled(runs.map((run) => run.controller.requestStop(`Received ${signal}`)));
    await Promise.allSettled(runs.map((run) => withTimeout(run.completion ?? Promise.resolve(), 5_000)));
    await Promise.allSettled([
      ...runs.map((run) => cleanupRun(run)),
      closeConnectivityManagers(),
      connectivityRegistry.closeAll()
    ]);
    await trafficProxyRegistry.closeAll();
    authService.close();
    server.closeAllConnections();
    await withTimeout(serverClosed, 2_000).catch(() => undefined);
  })().finally(() => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  });
  return shutdownPromise;
};
const onSigint = () => { void shutdown("SIGINT"); };
const onSigterm = () => { void shutdown("SIGTERM"); };
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

async function handleAuthRequest(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (pathname === "/api/auth/csrf" && request.method === "GET") {
    const token = createCsrfToken();
    await sendJson(response, { csrfToken: token }, 200, { "Set-Cookie": csrfCookie(token, request) });
    return;
  }

  if (pathname === "/api/auth/me" && request.method === "GET") {
    const user = authService.authenticate(readCookie(request, sessionCookieName));
    if (!user) {
      await sendJson(response, { error: { code: "unauthorized", message: "登录状态已失效" } }, 401);
      return;
    }
    await sendJson(response, { user });
    return;
  }

  if (pathname === "/api/auth/register" && request.method === "POST") {
    const body = await readJsonBody(request);
    const result = await authService.register({
      username: stringValue(body.username, ""),
      displayName: stringValue(body.displayName, ""),
      password: stringValue(body.password, "")
    });
    await sendJson(response, { user: result.user }, 201, { "Set-Cookie": sessionCookie(result.token, request) });
    return;
  }

  if (pathname === "/api/auth/login" && request.method === "POST") {
    const body = await readJsonBody(request);
    const result = await authService.login({
      username: stringValue(body.username, ""),
      password: stringValue(body.password, "")
    });
    await sendJson(response, { user: result.user }, 200, { "Set-Cookie": sessionCookie(result.token, request) });
    return;
  }

  if (pathname === "/api/auth/logout" && request.method === "POST") {
    authService.logout(readCookie(request, sessionCookieName));
    await sendJson(response, { ok: true }, 200, {
      "Set-Cookie": [clearSessionCookie(request), clearCsrfCookie(request)]
    });
    return;
  }

  await sendJson(response, { error: { code: "not_found", message: "认证接口不存在" } }, 404);
}

type WebConnection = {
  id: string;
  externalId: string;
  kind: ConnectivityDefinition["kind"];
  direction: string;
  transport: string;
  managed: boolean;
  desiredState: ConnectivityDefinition["desiredState"];
  observedState: ConnectivityDefinition["status"];
  lastHeartbeat?: string;
  error?: string;
  available: boolean;
  credentialRef?: string;
  graphUrl?: string;
};

async function readConnectivity(url: URL, includeCredentialRef: boolean): Promise<JsonRecord> {
  const runtimeInput = url.searchParams.get("runtimeDir") ?? defaultRuntimeDir;
  const runtimeDir = await runtimePathPolicy.resolveRuntime(runtimeInput, "existing");
  const databasePath = join(runtimeDir, "state.sqlite");
  if (!existsSync(databasePath)) {
    return { runtimeDir: runtimeInput, loadedAt: new Date().toISOString(), connections: [] };
  }
  const store = new ConnectivityStore(databasePath);
  try {
    return {
      runtimeDir: runtimeInput,
      loadedAt: new Date().toISOString(),
      connections: store.listDefinitions().map((definition) => webConnection(definition, runtimeInput, includeCredentialRef))
    };
  } finally {
    store.close();
  }
}

async function handleCreateConnectivity(
  request: IncomingMessage,
  response: ServerResponse,
  kind: "tunnel" | "session"
): Promise<void> {
  const body = await readJsonBody(request);
  rejectSensitiveConnectivityInput(body);
  const runtimeInput = requiredBodyString(body, "runtimeDir");
  const runtimeDir = await runtimePathPolicy.resolveRuntime(runtimeInput, "existing");
  const managers = connectivityManagerFor(runtimeDir);
  try {
    const definition = kind === "tunnel"
      ? managers.tunnels.define(validateWebTunnel(body))
      : managers.sessions.defineSsh(validateWebSession(body));
    await sendJson(response, webConnection(definition, runtimeInput), 201);
  } catch (error) {
    throw connectivityInputError(error);
  }
}

async function handleConnectivityAction(
  request: IncomingMessage,
  response: ServerResponse,
  id: string,
  action: "start" | "stop" | "close"
): Promise<void> {
  const body = await readJsonBody(request);
  rejectSensitiveConnectivityInput(body);
  assertExactKeys(body, ["runtimeDir"]);
  const runtimeInput = requiredBodyString(body, "runtimeDir");
  const runtimeDir = await runtimePathPolicy.resolveRuntime(runtimeInput, "existing");
  const managers = connectivityManagerFor(runtimeDir);
  const current = managers.store.getDefinition(id);
  if (!current) throw new HttpError(404, "connectivity_not_found", "连接不存在");
  if (!isManagedConnection(current)) throw new HttpError(409, "connectivity_unmanaged", "该连接不受 Web 生命周期管理");
  try {
    let updated: ConnectivityDefinition;
    if (current.kind === "tunnel") {
      if (action === "start") {
        managers.store.updateDesiredState(id, "running");
        updated = await managers.tunnels.start(id);
      } else {
        updated = await managers.tunnels.stop(id, action === "close");
      }
    } else {
      updated = managers.store.updateDesiredState(id, action === "close" ? "closed" : action === "stop" ? "stopped" : "running");
    }
    await sendJson(response, webConnection(updated, runtimeInput));
  } catch (error) {
    throw connectivityInputError(error, 409);
  }
}

function connectivityManagerFor(runtimeDir: string): {
  store: ConnectivityStore;
  graphStore: SQLiteGraphStore;
  tunnels: TunnelManager;
  sessions: SessionBroker;
} {
  const existing = connectivityManagers.get(runtimeDir);
  if (existing) return existing;
  const databasePath = join(runtimeDir, "state.sqlite");
  const store = new ConnectivityStore(databasePath);
  const graphStore = new SQLiteGraphStore(databasePath, join(runtimeDir, "graph-deltas.jsonl"));
  const topology = new OperationalTopology(graphStore);
  const managers = {
    store,
    graphStore,
    tunnels: new TunnelManager(store, topology, runtimeDir),
    sessions: new SessionBroker(store, topology, runtimeDir)
  };
  connectivityManagers.set(runtimeDir, managers);
  return managers;
}

function webConnection(definition: ConnectivityDefinition, runtimeInput: string, includeCredentialRef = true): WebConnection {
  const transport = typeof definition.definition.transport === "string"
    ? definition.definition.transport
    : typeof definition.definition.adapter === "string" ? definition.definition.adapter : "raw";
  const failure = definition.definition.lastFailureReason;
  const direction = definition.kind === "tunnel"
    ? `${definition.fromHostRef ?? "?"} → ${definition.toHostRef ?? "?"}`
    : definition.kind === "session" ? `host: ${definition.hostRef ?? "?"}` : "route";
  const graphKind = "operation";
  return {
    id: definition.id,
    externalId: definition.externalId,
    kind: definition.kind,
    direction,
    transport,
    managed: isManagedConnection(definition),
    desiredState: definition.desiredState,
    observedState: definition.status,
    lastHeartbeat: definition.lastHeartbeat,
    error: typeof failure === "string" ? failure : undefined,
    available: definition.desiredState === "running" && definition.status === "live",
    ...(includeCredentialRef && definition.credentialRef ? { credentialRef: definition.credentialRef } : {}),
    graphUrl: `?runtimeDir=${encodeURIComponent(runtimeInput)}&view=${graphKind}&nodeId=${encodeURIComponent(definition.id)}`
  };
}

function isManagedConnection(definition: ConnectivityDefinition): boolean {
  const transport = definition.definition.transport ?? definition.definition.adapter;
  return (definition.kind === "tunnel" || definition.kind === "session")
    && transport === "ssh"
    && definition.definition.unmanaged !== true;
}

function validateWebTunnel(body: JsonRecord): SshTunnelDefinition {
  assertExactKeys(body, ["runtimeDir", "externalId", "fromHostRef", "toHostRef", "host", "port", "user", "credentialRef", "desiredState", "controlMaster", "forwards"]);
  if (!Array.isArray(body.forwards) || body.forwards.length === 0 || body.forwards.length > 32) {
    throw new HttpError(400, "invalid_connectivity", "forwards 必须包含 1 到 32 项");
  }
  const forwards = body.forwards.map((value, index) => validateWebForward(value, index));
  const desiredState = body.desiredState === undefined ? undefined : body.desiredState;
  if (desiredState !== undefined && desiredState !== "running" && desiredState !== "stopped") {
    throw new HttpError(400, "invalid_connectivity", "desiredState 无效");
  }
  return {
    externalId: requiredBodyString(body, "externalId"),
    fromHostRef: requiredBodyString(body, "fromHostRef"),
    toHostRef: requiredBodyString(body, "toHostRef"),
    host: requiredBodyString(body, "host"),
    port: optionalPort(body.port, "port"),
    user: optionalBodyString(body, "user"),
    credentialRef: optionalBodyString(body, "credentialRef"),
    controlMaster: optionalBoolean(body.controlMaster, "controlMaster"),
    desiredState,
    forwards
  };
}

function validateWebForward(value: unknown, index: number): SshForward {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_connectivity", `forwards[${index}] 无效`);
  }
  const forward = value as JsonRecord;
  assertExactKeys(forward, ["mode", "bindHost", "bindPort", "targetHost", "targetPort"]);
  const mode = forward.mode;
  if (mode !== "local" && mode !== "remote" && mode !== "dynamic") {
    throw new HttpError(400, "invalid_connectivity", `forwards[${index}].mode 无效`);
  }
  const common = {
    bindHost: optionalBodyString(forward, "bindHost"),
    bindPort: requiredPort(forward.bindPort, `forwards[${index}].bindPort`)
  };
  if (mode === "dynamic") return { mode, ...common };
  return {
    mode,
    ...common,
    targetHost: requiredBodyString(forward, "targetHost"),
    targetPort: requiredPort(forward.targetPort, `forwards[${index}].targetPort`)
  };
}

function validateWebSession(body: JsonRecord): SshSessionDefinition {
  assertExactKeys(body, ["runtimeDir", "externalId", "sessionType", "hostRef", "host", "port", "user", "credentialRef", "concurrencySafe"]);
  if (body.sessionType !== undefined && body.sessionType !== "agent" && body.sessionType !== "shell") {
    throw new HttpError(400, "invalid_connectivity", "sessionType 无效");
  }
  return {
    externalId: requiredBodyString(body, "externalId"),
    sessionType: body.sessionType as "agent" | "shell" | undefined,
    hostRef: requiredBodyString(body, "hostRef"),
    host: requiredBodyString(body, "host"),
    port: optionalPort(body.port, "port"),
    user: optionalBodyString(body, "user"),
    credentialRef: optionalBodyString(body, "credentialRef"),
    concurrencySafe: optionalBoolean(body.concurrencySafe, "concurrencySafe")
  };
}

function rejectSensitiveConnectivityInput(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:secret|token|password|passphrase|private.?key|api.?key|access.?key|authorization|cookie)/i.test(key)) {
      throw new HttpError(400, "inline_credential_forbidden", "仅允许 credentialRef，不得提交凭据正文");
    }
    rejectSensitiveConnectivityInput(child);
  }
}

function assertExactKeys(body: JsonRecord, allowed: readonly string[]): void {
  const unexpected = Object.keys(body).find((key) => !allowed.includes(key));
  if (unexpected) throw new HttpError(400, "invalid_connectivity", `不支持字段 ${unexpected}`);
}

function requiredBodyString(body: JsonRecord, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\0\r\n]/.test(value)) {
    throw new HttpError(400, "invalid_connectivity", `${key} 无效`);
  }
  return value.trim();
}

function optionalBodyString(body: JsonRecord, key: string): string | undefined {
  return body[key] === undefined ? undefined : requiredBodyString(body, key);
}

function requiredPort(value: unknown, key: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new HttpError(400, "invalid_connectivity", `${key} 无效`);
  }
  return Number(value);
}

function optionalPort(value: unknown, key: string): number | undefined {
  return value === undefined ? undefined : requiredPort(value, key);
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, "invalid_connectivity", `${key} 无效`);
  return value;
}

function connectivityInputError(error: unknown, statusCode = 400): HttpError {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error && /not found/i.test(error.message) ? "连接不存在" : "连接配置或状态无效";
  return new HttpError(message === "连接不存在" ? 404 : statusCode, message === "连接不存在" ? "connectivity_not_found" : "invalid_connectivity", message);
}

async function trafficManagerForUrl(url: URL): Promise<TrafficProxyManager> {
  const runtimeInput = url.searchParams.get("runtimeDir") ?? defaultRuntimeDir;
  const runtimeDir = await runtimePathPolicy.resolveRuntime(runtimeInput, "existing");
  try {
    return await trafficProxyRegistry.getExisting(runtimeDir)
      ?? await trafficProxyRegistry.get(runtimeDir);
  } catch {
    throw new HttpError(503, "traffic_proxy_unavailable", "流量代理暂不可用");
  }
}

type WebReplayOverrides = {
  runtimeDir: string;
  method?: string;
  url?: string;
  headers?: TrafficHeaderEntry[];
  body?: { encoding: "base64"; data: string };
  routeRef?: string;
  sessionRef?: string;
  taskRef?: string;
  runRef?: string;
};

type ReplayHttpError = {
  statusCode: number;
  code: string;
  message: string;
  errorCode: string;
  result?: TrafficReplayResult;
};

async function handleTrafficReplay(
  request: IncomingMessage,
  response: ServerResponse,
  user: WebUser,
  exchangeId: number
): Promise<void> {
  if (!Number.isSafeInteger(exchangeId) || exchangeId <= 0) {
    throw new HttpError(400, "invalid_request", "exchange id 无效");
  }
  const input = validateReplayBody(await readJsonBody(request));
  const runtimeDir = await runtimePathPolicy.resolveRuntime(input.runtimeDir, "existing");
  const runtime = toRuntimeInput(runtimeDir);
  const actor = { actorId: user.id, actorUsername: user.username };
  const auditBase = {
    ...actor,
    sourceExchangeId: exchangeId,
    runtime,
    ...(input.taskRef === undefined ? {} : { taskRef: input.taskRef }),
    ...(input.runRef === undefined ? {} : { runRef: input.runRef })
  };
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"), join(runtimeDir, "state.sqlite"));
  let acquired = false;
  try {
    await executionLog.append({
      role: "runtime",
      eventType: "traffic_replay_requested",
      summary: "Traffic replay requested",
      payload: auditBase
    });
    if (activeTrafficReplays >= MAX_CONCURRENT_TRAFFIC_REPLAYS) {
      throw new HttpError(429, "traffic_replay_limit_exceeded", "并发 replay 请求过多，请稍后重试");
    }
    activeTrafficReplays += 1;
    acquired = true;

    let manager: TrafficProxyManager;
    try {
      manager = await trafficProxyRegistry.getExisting(runtimeDir)
        ?? await trafficProxyRegistry.get(runtimeDir);
    } catch {
      throw new HttpError(503, "traffic_proxy_unavailable", "流量代理暂不可用");
    }
    let runtimeRef = manager.runtimeRef;
    if (!runtimeRef) {
      const hello = await manager.client.hello();
      runtimeRef = hello.runtime_ref;
      manager.runtimeRef = runtimeRef;
    }
    const routeRef = input.routeRef ?? "web-replay";
    const sessionRef = input.sessionRef ?? "";
    const context: TrafficProxyContext = {
      runtime_ref: runtimeRef,
      task_ref: input.taskRef ?? "",
      run_ref: input.runRef ?? "",
      attribution: `web-user:${user.id}:${user.username}`,
      route_ref: routeRef,
      session_ref: sessionRef
    };
    const replayInput: TrafficReplayInput = {
      exchange_id: exchangeId,
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(input.body === undefined ? {} : { body: input.body }),
      route_ref: routeRef,
      session_ref: sessionRef,
      context
    };
    const result = await manager.client.replay(replayInput);
    const responseBody = replayResultBody(result);
    await executionLog.append({
      role: "runtime",
      eventType: "traffic_replay_succeeded",
      summary: "Traffic replay succeeded",
      payload: { ...auditBase, runtimeRef, exchangeId: result.exchange_id, replayOf: result.replay_of }
    });
    await sendJson(response, responseBody);
  } catch (error) {
    const mapped = mapReplayError(error);
    await executionLog.append({
      role: "runtime",
      eventType: "traffic_replay_failed",
      summary: "Traffic replay failed",
      payload: {
        ...auditBase,
        errorCode: mapped.errorCode,
        ...(mapped.result ? { exchangeId: mapped.result.exchange_id, replayOf: mapped.result.replay_of } : {})
      }
    });
    await sendJson(response, {
      error: { code: mapped.code, message: mapped.message },
      errorCode: mapped.errorCode,
      ...(mapped.result ? { exchangeId: mapped.result.exchange_id, replayOf: mapped.result.replay_of } : {})
    }, mapped.statusCode);
  } finally {
    if (acquired) activeTrafficReplays -= 1;
    await executionLog.drain();
    executionLog.close();
  }
}

function validateReplayBody(body: JsonRecord): WebReplayOverrides {
  assertOnlyKeys(body, ["runtimeDir", "method", "url", "headers", "body", "route_ref", "session_ref", "task_ref", "run_ref"]);
  const runtimeDir = requiredReplayText(body.runtimeDir, "runtimeDir", 1024);
  const method = optionalReplayText(body.method, "method", 32);
  if (method !== undefined && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method)) {
    throw new HttpError(400, "invalid_request", "method 格式无效");
  }
  const url = optionalReplayText(body.url, "url", 4096);
  const routeRef = optionalReplayText(body.route_ref, "route_ref", 512, true);
  const sessionRef = optionalReplayText(body.session_ref, "session_ref", 512, true);
  const taskRef = optionalReplayText(body.task_ref, "task_ref", 512, true);
  const runRef = optionalReplayText(body.run_ref, "run_ref", 512, true);

  let headers: TrafficHeaderEntry[] | undefined;
  if (body.headers !== undefined) {
    if (!Array.isArray(body.headers) || body.headers.length > 100) {
      throw new HttpError(400, "invalid_request", "headers 必须是最多 100 项的数组");
    }
    headers = body.headers.map((entry, index) => {
      if (!isRecord(entry)) throw new HttpError(400, "invalid_request", "header 项必须是对象");
      assertOnlyKeys(entry, ["name", "value", "ordinal"]);
      const name = requiredReplayText(entry.name, "header.name", 256);
      const value = requiredReplayText(entry.value, "header.value", 4096, true);
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
        throw new HttpError(400, "invalid_request", "header.name 格式无效");
      }
      const ordinal = entry.ordinal === undefined ? index : entry.ordinal;
      if (!Number.isSafeInteger(ordinal) || (ordinal as number) < 0 || (ordinal as number) > 100_000) {
        throw new HttpError(400, "invalid_request", "header.ordinal 无效");
      }
      return { name, value, ordinal: ordinal as number };
    });
  }

  let replayBody: { encoding: "base64"; data: string } | undefined;
  if (body.body !== undefined) {
    if (!isRecord(body.body)) throw new HttpError(400, "invalid_request", "body override 必须是对象");
    assertOnlyKeys(body.body, ["encoding", "data"]);
    if (body.body.encoding !== "base64" || typeof body.body.data !== "string") {
      throw new HttpError(400, "invalid_request", "body 必须使用 base64 encoding 和字符串 data");
    }
    if (body.body.data.length > 16 * 1024 || !validBase64(body.body.data)) {
      throw new HttpError(400, "invalid_request", "body.data 不是有效或允许大小内的 base64");
    }
    replayBody = { encoding: "base64", data: body.body.data };
  }
  return {
    runtimeDir,
    ...(method === undefined ? {} : { method }),
    ...(url === undefined ? {} : { url }),
    ...(headers === undefined ? {} : { headers }),
    ...(replayBody === undefined ? {} : { body: replayBody }),
    ...(routeRef === undefined ? {} : { routeRef }),
    ...(sessionRef === undefined ? {} : { sessionRef }),
    ...(taskRef === undefined ? {} : { taskRef }),
    ...(runRef === undefined ? {} : { runRef })
  };
}

function assertOnlyKeys(record: JsonRecord, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknown) throw new HttpError(400, "invalid_request", `未知字段: ${unknown}`);
}

function requiredReplayText(value: unknown, name: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(400, "invalid_request", `${name} 无效`);
  }
  return value;
}

function optionalReplayText(value: unknown, name: string, maxLength: number, allowEmpty = false): string | undefined {
  return value === undefined ? undefined : requiredReplayText(value, name, maxLength, allowEmpty);
}

function validBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function replayResultBody(result: TrafficReplayResult): JsonRecord {
  return {
    exchangeId: result.exchange_id,
    replayOf: result.replay_of,
    status: result.status,
    ...(result.error_code ? { errorCode: result.error_code } : {})
  };
}

function mapReplayError(error: unknown): ReplayHttpError {
  if (error instanceof HttpError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message, errorCode: error.code };
  }
  if (error instanceof TrafficProxyControlError) {
    const result = replayErrorResult(error.result);
    const errorCode = error.errorCode;
    if (errorCode === "source_not_found") {
      return { statusCode: 404, code: "traffic_replay_source_not_found", message: "原始流量记录不存在", errorCode, result };
    }
    if (errorCode === "source_not_replayable") {
      return { statusCode: 409, code: "traffic_replay_source_not_replayable", message: "原始流量记录不可 replay", errorCode, result };
    }
    if (errorCode === "replay_busy") {
      return { statusCode: 429, code: "traffic_replay_sidecar_busy", message: "流量代理 replay 繁忙，请稍后重试", errorCode, result };
    }
    if (["body_too_large", "headers_too_large", "traffic_proxy_request_too_large"].includes(errorCode)) {
      return { statusCode: 413, code: "traffic_replay_payload_too_large", message: "Replay 请求内容过大", errorCode, result };
    }
    if (["invalid_context", "invalid_request", "invalid_method", "invalid_url", "invalid_header", "forbidden_header", "host_conflict", "self_loop", "invalid_body"].includes(errorCode)) {
      return { statusCode: 400, code: "traffic_replay_invalid", message: "Replay 请求被流量代理拒绝", errorCode, result };
    }
    if (errorCode === "traffic_proxy_timeout" || errorCode === "timeout") {
      return { statusCode: 504, code: "traffic_replay_timeout", message: "Replay 请求超时", errorCode, result };
    }
    return { statusCode: 502, code: "traffic_replay_failed", message: "Replay 执行失败", errorCode, result };
  }
  return { statusCode: 502, code: "traffic_replay_failed", message: "Replay 执行失败", errorCode: "traffic_replay_failed" };
}

function replayErrorResult(value: unknown): TrafficReplayResult | undefined {
  if (!isRecord(value)) return undefined;
  if (!Number.isSafeInteger(value.exchange_id) || (value.exchange_id as number) <= 0 || !Number.isSafeInteger(value.replay_of) || (value.replay_of as number) <= 0 || typeof value.status !== "number") return undefined;
  return {
    exchange_id: value.exchange_id as number,
    replay_of: value.replay_of as number,
    status: value.status,
    ...(typeof value.error_code === "string" ? { error_code: value.error_code } : {})
  };
}

async function readTrafficHistory(url: URL): Promise<unknown> {
  const manager = await trafficManagerForUrl(url);
  const cursor = boundedQuery(url, "cursor", 512);
  const limit = integerQuery(url, "limit", 50, 1, 100);
  const statusValue = url.searchParams.get("status");
  const filter = {
    ...optionalFilter(url, "runtime_ref"),
    ...optionalFilter(url, "task_ref"),
    ...optionalFilter(url, "run_ref"),
    ...optionalFilter(url, "route_ref"),
    ...optionalFilter(url, "session_ref"),
    ...optionalFilter(url, "started_after"),
    ...optionalFilter(url, "started_before"),
    ...optionalFilter(url, "mode"),
    ...optionalFilter(url, "method"),
    ...optionalFilter(url, "host"),
    ...optionalFilter(url, "connect_ref"),
    ...optionalFilter(url, "error"),
    ...(statusValue === null ? {} : { status: integerValue(statusValue, "status", 0, 999) })
  };
  try {
    return await manager.client.historyList({ ...(cursor ? { cursor } : {}), limit, filter });
  } catch {
    throw new HttpError(502, "traffic_history_error", "无法读取流量历史");
  }
}

async function readTrafficExchange(url: URL, exchangeId: number, body: boolean): Promise<unknown> {
  if (!Number.isSafeInteger(exchangeId) || exchangeId <= 0) throw new HttpError(400, "invalid_request", "exchange id 无效");
  const manager = await trafficManagerForUrl(url);
  try {
    if (!body) return await manager.client.historyGet(exchangeId);
    const side = url.searchParams.get("side");
    if (side !== "request" && side !== "response") throw new HttpError(400, "invalid_request", "side 必须为 request 或 response");
    const byteLimit = integerQuery(url, "byteLimit", 256 * 1024, 1, 256 * 1024);
    return await manager.client.historyBody(exchangeId, side, byteLimit);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "traffic_history_error", "无法读取流量记录");
  }
}

async function sendPublicCa(response: ServerResponse, url: URL): Promise<void> {
  const manager = await trafficManagerForUrl(url);
  let certificate: string;
  try {
    certificate = await readFile(manager.caCertPath, "utf8");
  } catch {
    throw new HttpError(404, "ca_certificate_not_found", "公共 CA 证书不可用");
  }
  if (!certificate.includes("-----BEGIN CERTIFICATE-----") || certificate.includes("PRIVATE KEY")) {
    throw new HttpError(500, "ca_certificate_invalid", "公共 CA 证书无效");
  }
  response.writeHead(200, {
    "Content-Type": "application/x-pem-file",
    "Content-Disposition": "attachment; filename=traffic-proxy-ca.crt",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(certificate);
}

function optionalFilter(url: URL, name: string): Record<string, string> {
  const value = boundedQuery(url, name, 512);
  return value ? { [name]: value } : {};
}

function boundedQuery(url: URL, name: string, maxLength: number): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  if (!value) return undefined;
  if (value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, "invalid_request", `${name} 参数无效`);
  return value;
}

function integerQuery(url: URL, name: string, fallback: number, min: number, max: number): number {
  const value = url.searchParams.get(name);
  return value === null ? fallback : integerValue(value, name, min, max);
}

function integerValue(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new HttpError(400, "invalid_request", `${name} 参数无效`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new HttpError(400, "invalid_request", `${name} 参数无效`);
  return parsed;
}

async function handleStartRun(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJsonBody(request);
  const goal = stringValue(body.goal, "").trim();
  const scope = stringValue(body.scope, "").trim();
  if (!goal || !scope) {
    await sendJson(response, { error: { code: "invalid_request", message: "goal 和 scope 不能为空" } }, 400);
    return;
  }
  if (goal.length > 4000 || scope.length > 4000) {
    await sendJson(response, { error: { code: "invalid_request", message: "goal/scope 长度不能超过 4000 字符" } }, 400);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
  const runtimeDir = await runtimePathPolicy.resolveRuntime(
    join(runtimePathPolicy.rootDir, "sessions", `${timestamp}-web-${randomUUID().slice(0, 8)}`),
    "create"
  );
  let agentRuntime: AgentRuntimeLifecycle | undefined;
  let run: ActiveRun | undefined;
  try {
    agentRuntime = await bootstrapAgentRuntime({
      cwd,
      runtimeDir,
      routeRef: "web-run",
      trafficProxyRegistry
    });
    const { controller } = agentRuntime;
    const connectivitySupervisor = await connectivityRegistry.get(runtimeDir);

    run = {
      runtimeDir,
      runtimeInput: toRuntimeInput(runtimeDir),
      goal,
      scope,
      startedAt: new Date().toISOString(),
      controller,
      agentRuntime,
      connectivitySupervisor
    };
    activeRuns.set(runtimeDir, run);

    const options: Parameters<SecurityAgentController["runUntilDone"]>[0] = { userGoal: goal, scopeSummary: scope };
    const maxRunTimeMs = optionalPositiveNumber(body.maxRunTimeMs);
    const maxParallelTasks = optionalPositiveNumber(body.maxParallelTasks);
    const maxPlannerCycles = optionalPositiveNumber(body.maxPlannerCycles);
    if (maxRunTimeMs !== undefined) options.maxRunTimeMs = maxRunTimeMs;
    if (maxParallelTasks !== undefined) options.maxParallelTasks = maxParallelTasks;
    if (maxPlannerCycles !== undefined) options.maxPlannerCycles = maxPlannerCycles;

    const activeRun = run;
    activeRun.completion = controller.runUntilDone(options)
      .then((result) => {
        console.log(`[web run finished] ${activeRun.runtimeInput}: completed=${result.completed} reason=${result.stoppedReason ?? "-"}`);
      })
      .catch((error: unknown) => {
        console.error(`[web run failed] ${activeRun.runtimeInput}:`, error instanceof Error ? error.message : error);
      })
      .finally(() => cleanupRun(activeRun));

    await sendJson(response, {
      runtimeDir: activeRun.runtimeInput,
      name: basename(runtimeDir),
      goal,
      scope,
      startedAt: activeRun.startedAt,
      running: true
    }, 201);
  } catch (error) {
    activeRuns.delete(runtimeDir);
    if (run) await cleanupRun(run);
    else {
      await Promise.allSettled([
        agentRuntime?.close() ?? Promise.resolve(),
        connectivityRegistry.close(runtimeDir)
      ]);
    }
    throw error;
  }
}

function listActiveRuns(): JsonRecord {
  return {
    loadedAt: new Date().toISOString(),
    runs: [...activeRuns.values()].map((run) => ({
      runtimeDir: run.runtimeInput,
      name: basename(run.runtimeDir),
      goal: run.goal,
      scope: run.scope,
      startedAt: run.startedAt,
      running: true
    }))
  };
}

async function handleStopRun(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJsonBody(request);
  const input = stringValue(body.runtimeDir, "").trim();
  if (!input) {
    await sendJson(response, { error: { code: "invalid_request", message: "runtimeDir 不能为空" } }, 400);
    return;
  }
  const runtimeDir = await runtimePathPolicy.resolveRuntime(input, "create");
  const run = activeRuns.get(runtimeDir);
  if (!run) {
    await sendJson(response, { error: { code: "run_not_found", message: "任务未在运行中，或不属于本 Web 进程" } }, 404);
    return;
  }
  void run.controller.requestStop("Stopped from web UI").catch(() => undefined);
  await sendJson(response, { ok: true, runtimeDir: run.runtimeInput, stopping: true });
}

const runCleanupPromises = new WeakMap<ActiveRun, Promise<void>>();

function cleanupRun(run: ActiveRun): Promise<void> {
  const existing = runCleanupPromises.get(run);
  if (existing) return existing;
  const cleanup = (async () => {
    activeRuns.delete(run.runtimeDir);
    try {
      run.connectivitySupervisor.finishRun(run.controller.runId);
    } catch {
      // Continue closing independent resources.
    }
    await Promise.allSettled([
      withTimeout(run.agentRuntime.close(), 12_000),
      withTimeout(connectivityRegistry.close(run.runtimeDir), 5_000)
    ]);
  })();
  runCleanupPromises.set(run, cleanup);
  return cleanup;
}

async function closeConnectivityManagers(): Promise<void> {
  const entries = [...connectivityManagers.entries()];
  connectivityManagers.clear();
  await Promise.allSettled(entries.map(async ([, managers]) => {
    const tunnels = managers.store.listDefinitions().filter((definition) =>
      definition.kind === "tunnel" && isManagedConnection(definition) && definition.status !== "closed"
    );
    await Promise.allSettled(tunnels.map((definition) => withTimeout(managers.tunnels.stop(definition.id), 2_000)));
    managers.graphStore.close();
    managers.store.close();
  }));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error: unknown) => { clearTimeout(timer); rejectPromise(error); }
    );
  });
}

function redactCredentialRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCredentialRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) =>
    /^credential_?ref$/i.test(key) ? [] : [[key, redactCredentialRefs(child)]]
  ));
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function readRuntimeState(runtimeDirInput: string): Promise<JsonRecord> {
  const runtimeDir = await runtimePathPolicy.resolveRuntime(runtimeDirInput, "existing");
  const [events, graphDeltas, artifacts] = await Promise.all([
    readJsonl<WebEvent>(join(runtimeDir, "execution.jsonl"), 700),
    readJsonl<JsonRecord>(join(runtimeDir, "graph-deltas.jsonl"), 260),
    readJsonl<ArtifactRecord>(join(runtimeDir, "artifacts", "index.jsonl"), 240)
  ]);
  const graph = readGraph(runtimeDir, graphDeltas);
  const traceItems = buildTraceItems(events);
  return {
    runtimeDir,
    loadedAt: new Date().toISOString(),
    overview: summarizeRuntime(events, graph.nodes, graph.edges, artifacts),
    traceItems,
    graph,
    events: events.map(compactExecutionEvent),
    artifacts: {
      records: artifacts.map(compactArtifact),
      summary: {
        count: artifacts.length,
        totalBytes: artifacts.reduce((sum, item) => sum + numberValue(item.byteLength), 0)
      }
    }
  };
}

const MAX_ARTIFACT_TEXT_BYTES = 512 * 1024;
const MAX_ARTIFACT_IMAGE_BYTES = 8 * 1024 * 1024;

async function readArtifactContent(runtimeDirInput: string, artifactRef: string): Promise<JsonRecord> {
  if (!/^artifact:[\w-]+$/i.test(artifactRef)) {
    throw new HttpError(400, "invalid_request", "artifactRef 格式不正确");
  }
  const runtimeDir = await runtimePathPolicy.resolveRuntime(runtimeDirInput, "existing");
  const artifactsRoot = await runtimePathPolicy.resolveRuntimeChild(runtimeDir, "artifacts", "create");
  const records = await readJsonl<ArtifactRecord>(join(artifactsRoot, "index.jsonl"), 100_000);
  const record = records.find((item) => item.artifactRef === artifactRef);
  if (!record?.path) {
    throw new HttpError(404, "artifact_not_found", "Artifact 不存在或不在当前索引中");
  }
  let filePath: string;
  try {
    filePath = await runtimePathPolicy.resolveRuntimeChild(artifactsRoot, resolve(cwd, record.path), "existing");
  } catch (error) {
    if (error instanceof RuntimePathPolicyError && error.code === "runtime_path_outside_root") {
      throw new HttpError(403, "artifact_path_forbidden", "Artifact 路径超出 runtime 目录");
    }
    throw error;
  }
  const info = await statMaybe(filePath);
  if (!info) {
    throw new HttpError(404, "artifact_not_found", "Artifact 内容文件已丢失");
  }
  const isImage = stringValue(record.mediaType, "").startsWith("image/");
  const limit = isImage ? MAX_ARTIFACT_IMAGE_BYTES : MAX_ARTIFACT_TEXT_BYTES;
  const truncated = info.size > limit;
  const buffer = Buffer.alloc(Math.min(info.size, limit));
  const handle = await open(filePath, "r");
  try {
    await handle.read(buffer, 0, buffer.length, 0);
  } finally {
    await handle.close();
  }
  return {
    artifactRef,
    taskId: record.taskId,
    kind: record.kind,
    mediaType: record.mediaType,
    byteLength: info.size,
    truncated,
    encoding: isImage ? "base64" : "utf8",
    content: isImage ? buffer.toString("base64") : buffer.toString("utf8")
  };
}

async function readRuntimeSessions(rootDirInput: string): Promise<JsonRecord> {
  const rootDir = await runtimePathPolicy.resolveRuntime(rootDirInput, "existing");
  const candidates = await discoverRuntimeSessionDirs(rootDir);

  const sessions = (await mapWithConcurrency(candidates, 8, (dir) => readRuntimeSession(rootDir, dir)))
    .filter((session): session is RuntimeSession => Boolean(session))
    .sort((left, right) => timestampMs(right.updatedAt ?? "") - timestampMs(left.updatedAt ?? ""));

  return {
    rootDir,
    loadedAt: new Date().toISOString(),
    sessions,
    summary: {
      count: sessions.length,
      totalTasks: sessions.reduce((sum, item) => sum + item.taskCount, 0),
      totalEvents: sessions.reduce((sum, item) => sum + item.eventCount, 0)
    }
  };
}

async function readRuntimeSession(rootDir: string, runtimeDir: string): Promise<RuntimeSession | undefined> {
  const [databaseStat, executionStat, graphDeltaStat, artifactIndexStat] = await Promise.all([
    statMaybe(join(runtimeDir, "state.sqlite")),
    statMaybe(join(runtimeDir, "execution.jsonl")),
    statMaybe(join(runtimeDir, "graph-deltas.jsonl")),
    statMaybe(join(runtimeDir, "artifacts", "index.jsonl"))
  ]);
  if (!databaseStat && !executionStat && !graphDeltaStat && !artifactIndexStat) return undefined;

  const graphMeta = await readRuntimeSessionGraphMeta(runtimeDir);
  const updatedAtMs = Math.max(
    databaseStat?.mtimeMs ?? 0,
    executionStat?.mtimeMs ?? 0,
    graphDeltaStat?.mtimeMs ?? 0,
    artifactIndexStat?.mtimeMs ?? 0
  );
  const [eventCount, artifactCount] = await Promise.all([
    countJsonlLines(join(runtimeDir, "execution.jsonl")),
    countJsonlLines(join(runtimeDir, "artifacts", "index.jsonl"))
  ]);

  return {
    name: runtimeDir === rootDir ? `${basename(rootDir)} / 当前根` : basename(runtimeDir),
    runtimeDir: toRuntimeInput(runtimeDir),
    relativePath: runtimeDir === rootDir ? "" : relative(rootDir, runtimeDir).split(sep).join("/"),
    isRoot: runtimeDir === rootDir,
    updatedAt: updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : undefined,
    source: graphMeta.source,
    nodeCount: graphMeta.nodeCount,
    edgeCount: graphMeta.edgeCount,
    taskCount: graphMeta.taskCount,
    eventCount,
    artifactCount,
    goal: graphMeta.goal,
    latestTask: graphMeta.latestTask,
    latestTaskStatus: graphMeta.latestTaskStatus,
    running: activeRuns.has(runtimeDir)
  };
}

async function readRuntimeSessionGraphMeta(runtimeDir: string): Promise<{
  source: string;
  nodeCount: number;
  edgeCount: number;
  taskCount: number;
  goal?: string;
  latestTask?: string;
  latestTaskStatus?: string;
}> {
  const databasePath = join(runtimeDir, "state.sqlite");
  if (existsSync(databasePath)) {
    try {
      const database = new DatabaseSync(databasePath);
      try {
        const nodeRow = asRecord(database.prepare(`
          SELECT
            COUNT(*) AS nodeCount,
            SUM(CASE WHEN type = 'Task' THEN 1 ELSE 0 END) AS taskCount
          FROM nodes
        `).get());
        const edgeRow = asRecord(database.prepare("SELECT COUNT(*) AS edgeCount FROM edges").get());
        const goalRow = asRecord(database.prepare(`
          SELECT label
          FROM nodes
          WHERE type = 'Goal'
          ORDER BY updated_at DESC
          LIMIT 1
        `).get());
        const taskRow = asRecord(database.prepare(`
          SELECT label, properties_json
          FROM nodes
          WHERE type = 'Task'
          ORDER BY updated_at DESC
          LIMIT 1
        `).get());
        const taskProperties = parseJsonObject(taskRow.properties_json);
        return {
          source: "sqlite",
          nodeCount: numberValue(nodeRow.nodeCount),
          edgeCount: numberValue(edgeRow.edgeCount),
          taskCount: numberValue(nodeRow.taskCount),
          goal: stringValue(goalRow.label, ""),
          latestTask: stringValue(taskRow.label, ""),
          latestTaskStatus: stringValue(taskProperties.status, "")
        };
      } finally {
        database.close();
      }
    } catch {
      // Fall through to graph-deltas so a broken SQLite file does not hide a session.
    }
  }
  const graphDeltas = await readJsonl<JsonRecord>(join(runtimeDir, "graph-deltas.jsonl"), 260);
  const graph = graphFromDeltas(graphDeltas);
  const tasks = graph.nodes.filter((node) => node.type === "Task");
  const goal = graph.nodes.find((node) => node.type === "Goal");
  return {
    source: graph.source,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    taskCount: tasks.length,
    goal: goal?.label,
    latestTask: tasks[0]?.label,
    latestTaskStatus: stringValue(tasks[0]?.properties.status, "")
  };
}

function readGraph(runtimeDir: string, graphDeltas: JsonRecord[]): {
  nodes: WebNode[];
  edges: WebEdge[];
  summary: JsonRecord;
  source: string;
  sqliteError?: string;
} {
  const databasePath = join(runtimeDir, "state.sqlite");
  if (existsSync(databasePath)) {
    try {
      const database = new DatabaseSync(databasePath);
      try {
        const nodes = database.prepare(`
          SELECT id, graph_kind, type, label, properties_json, evidence_refs_json, updated_at
          FROM nodes
          ORDER BY updated_at DESC
          LIMIT 1200
        `).all().map(normalizeNode);
        const edges = database.prepare(`
          SELECT id, from_id, to_id, type, properties_json, evidence_refs_json, updated_at
          FROM edges
          ORDER BY updated_at DESC
          LIMIT 2400
        `).all().map(normalizeEdge);
        return { nodes, edges, summary: summarizeGraph(nodes, edges), source: "sqlite" };
      } finally {
        database.close();
      }
    } catch (error) {
      return graphFromDeltas(graphDeltas, error instanceof Error ? error.message : String(error));
    }
  }
  return graphFromDeltas(graphDeltas);
}

function graphFromDeltas(graphDeltas: JsonRecord[], sqliteError?: string): {
  nodes: WebNode[];
  edges: WebEdge[];
  summary: JsonRecord;
  source: string;
  sqliteError?: string;
} {
  const nodesById = new Map<string, WebNode>();
  const edgesById = new Map<string, WebEdge>();
  for (const entry of graphDeltas) {
    const delta = isRecord(entry.delta) ? entry.delta : entry;
    for (const item of arrayValue(delta.nodes)) {
      if (isRecord(item) && typeof item.id === "string") {
        nodesById.set(item.id, {
          id: item.id,
          graphKind: stringValue(item.graphKind ?? item.graph_kind, "unknown"),
          type: stringValue(item.type, "unknown"),
          label: stringValue(item.label, item.id),
          properties: isRecord(item.properties) ? item.properties : {},
          evidenceRefs: stringArray(item.evidenceRefs)
        });
      }
    }
    for (const item of arrayValue(delta.edges)) {
      if (isRecord(item)) {
        const edge: WebEdge = {
          id: stringValue(item.id, ""),
          from: stringValue(item.from ?? item.from_id, ""),
          to: stringValue(item.to ?? item.to_id, ""),
          type: stringValue(item.type, "unknown"),
          properties: isRecord(item.properties) ? item.properties : {},
          evidenceRefs: stringArray(item.evidenceRefs)
        };
        if (edge.from && edge.to) {
          edgesById.set(edge.id || `${edge.from}::${edge.type}::${edge.to}`, edge);
        }
      }
    }
  }
  const nodes = [...nodesById.values()];
  const edges = [...edgesById.values()];
  return { nodes, edges, summary: summarizeGraph(nodes, edges), source: "graph-deltas", sqliteError };
}

function normalizeNode(row: unknown): WebNode {
  const record = asRecord(row);
  return {
    id: stringValue(record.id, ""),
    graphKind: stringValue(record.graph_kind, "unknown"),
    type: stringValue(record.type, "unknown"),
    label: stringValue(record.label, ""),
    properties: parseJsonObject(record.properties_json),
    evidenceRefs: parseJsonArray(record.evidence_refs_json),
    updatedAt: stringValue(record.updated_at, "")
  };
}

function normalizeEdge(row: unknown): WebEdge {
  const record = asRecord(row);
  return {
    id: stringValue(record.id, ""),
    from: stringValue(record.from_id, ""),
    to: stringValue(record.to_id, ""),
    type: stringValue(record.type, "unknown"),
    properties: parseJsonObject(record.properties_json),
    evidenceRefs: parseJsonArray(record.evidence_refs_json),
    updatedAt: stringValue(record.updated_at, "")
  };
}

function summarizeRuntime(
  events: WebEvent[],
  nodes: WebNode[],
  edges: WebEdge[],
  artifacts: ArtifactRecord[]
): JsonRecord {
  const goal = nodes.find((node) => node.type === "Goal");
  const scope = nodes.find((node) => node.type === "Scope");
  const tasks = nodes.filter((node) => node.type === "Task");
  const taskItems = tasks.slice(0, 30).map((node) => ({
    id: node.id,
    label: node.label,
    status: stringValue(node.properties.status, "open"),
    priority: node.properties.priority,
    updatedAt: node.updatedAt
  }));
  const eventsByRole = countBy(events, (event) => event.role || "unknown");
  const eventsByType = countBy(events, (event) => event.eventType || "unknown");
  const taskStatus = countBy(tasks, (node) => stringValue(node.properties.status, "open"));
  const latestByRole: JsonRecord = {};
  for (const role of ["planner", "executor", "observer", "runtime"]) {
    const latest = [...events].reverse().find((event) => event.role === role);
    latestByRole[role] = latest ? compactExecutionEvent(latest) : undefined;
  }
  return {
    goal: goal ? { id: goal.id, label: goal.label, status: goal.properties.status } : undefined,
    scope: scope ? { id: scope.id, label: scope.label, summary: scope.properties.summary } : undefined,
    graph: summarizeGraph(nodes, edges),
    events: { count: events.length, byRole: eventsByRole, byType: eventsByType },
    tasks: { count: tasks.length, byStatus: taskStatus, latest: taskItems[0], items: taskItems },
    artifacts: { count: artifacts.length, totalBytes: artifacts.reduce((sum, item) => sum + numberValue(item.byteLength), 0) },
    agents: latestByRole,
    latestControlSignal: findLatestControlSignal(events)
  };
}

function summarizeGraph(nodes: WebNode[], edges: WebEdge[]): JsonRecord {
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    byKind: countBy(nodes, (node) => node.graphKind || "unknown"),
    byType: countBy(nodes, (node) => node.type || "unknown")
  };
}

function buildTraceItems(events: WebEvent[]): TraceItem[] {
  const toolGroups = new Map<string, WebEvent[]>();
  for (const event of events) {
    const toolCallId = getToolCallId(event);
    if (!toolCallId) continue;
    const group = toolGroups.get(toolCallId) ?? [];
    group.push(event);
    toolGroups.set(toolCallId, group);
  }

  const emittedToolCalls = new Set<string>();
  const consumedEventIds = new Set<string>();
  const traceItems: TraceItem[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (consumedEventIds.has(event.id)) continue;
    if (event.eventType === "assistant_intent") {
      const toolCallId = findIntentToolCallId(events, index, toolGroups);
      const toolEvents = toolCallId ? toolGroups.get(toolCallId) ?? [] : [];
      const actionEvents = collectAgentActionEvents(events, index, toolEvents);
      for (const actionEvent of actionEvents) consumedEventIds.add(actionEvent.id);
      if (toolCallId) emittedToolCalls.add(toolCallId);
      traceItems.push(toAgentActionTraceItem(event, actionEvents, toolEvents));
      continue;
    }
    const toolCallId = getToolCallId(event);
    if (!toolCallId) {
      if (shouldSkipTraceEvent(event)) continue;
      traceItems.push(toTraceItem(event));
      continue;
    }
    if (event.role === "runtime") continue;
    if (emittedToolCalls.has(toolCallId)) continue;
    traceItems.push(toToolTraceItem(toolGroups.get(toolCallId) ?? [event]));
    emittedToolCalls.add(toolCallId);
  }
  return traceItems;
}

function findIntentToolCallId(events: WebEvent[], intentIndex: number, toolGroups: Map<string, WebEvent[]>): string | undefined {
  const intent = events[intentIndex];
  const payload = isRecord(intent.payload) ? intent.payload : {};
  const calls = intentToolCalls(payload);
  const exactToolCallId = selectExactToolCallId(calls, new Set(toolGroups.keys()));
  if (exactToolCallId) return exactToolCallId;
  const expectedToolName = firstText(...calls.map((call) => call.name));
  for (let index = intentIndex + 1; index < Math.min(events.length, intentIndex + 14); index += 1) {
    const event = events[index];
    if (event.role === intent.role && event.taskId === intent.taskId && event.eventType === "assistant_intent") break;
    if (event.role !== intent.role || event.taskId !== intent.taskId) continue;
    if (timestampMs(event.timestamp) - timestampMs(intent.timestamp) > 15_000) break;
    const toolCallId = getToolCallId(event);
    if (!toolCallId || !isToolStartEvent(event.eventType)) continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const toolName = toolNameFromPayload(payload);
    if (!expectedToolName || !toolName || expectedToolName === toolName) return toolCallId;
  }
  return undefined;
}

function collectAgentActionEvents(events: WebEvent[], intentIndex: number, toolEvents: WebEvent[]): WebEvent[] {
  const intent = events[intentIndex];
  const collected = new Map<string, WebEvent>([[intent.id, intent]]);
  for (const event of toolEvents) collected.set(event.id, event);
  const terminalTime = Math.max(timestampMs(intent.timestamp), ...toolEvents.map((event) => timestampMs(event.timestamp)));
  for (let index = intentIndex + 1; index < Math.min(events.length, intentIndex + 18); index += 1) {
    const event = events[index];
    if (event.role === intent.role && event.taskId === intent.taskId && event.eventType === "assistant_intent") break;
    if (event.role !== intent.role || event.taskId !== intent.taskId) continue;
    if (timestampMs(event.timestamp) - terminalTime > 5_000) break;
    if (isAgentActionDetailEvent(event.eventType)) collected.set(event.id, event);
  }
  return [...collected.values()].sort((left, right) => timestampMs(left.timestamp) - timestampMs(right.timestamp));
}

function toAgentActionTraceItem(intent: WebEvent, actionEvents: WebEvent[], toolEvents: WebEvent[]): TraceItem {
  const intentPayload = isRecord(intent.payload) ? intent.payload : {};
  const relatedPayloads = actionEvents.map((event) => (isRecord(event.payload) ? event.payload : {}));
  const toolItem = toolEvents.length ? toToolTraceItem(toolEvents) : undefined;
  const calls = intentToolCalls(intentPayload);
  const firstCall = calls[0];
  const callArgs = firstCall?.arguments ?? {};
  const role = intent.role || "executor";
  const intentPresentation = selectTraceIntent({
    role,
    recordedText: intentPayload.text,
    call: firstCall,
    relatedReasons: [
      ...relatedPayloads.map((payload) => firstRecord(payload.plannerDecision)?.reason),
      ...relatedPayloads.map((payload) => firstRecord(payload.controlSignal)?.reason)
    ]
  });
  const action = summarizeTraceAction(firstCall) || toolItem?.action;
  const heading = traceActionHeading(role, firstCall);
  const commandDetails = firstCall?.name === "planner_submit"
    ? summarizePlannerCommands(
      callArgs.commands
      ?? relatedPayloads.map((payload) => firstRecord(payload.plannerDecision)?.commands).find(Array.isArray)
    )
    : [];
  const lastEvent = actionEvents[actionEvents.length - 1] ?? intent;
  const evidenceRefs = uniqueStrings(actionEvents.flatMap((event) => eventEvidenceRefs(event)));
  const artifactRefs = uniqueStrings(actionEvents.flatMap((event) => event.artifactRefs ?? []));
  const taskId = firstText(intent.taskId, toolItem?.taskId);
  return {
    id: `trace:action:${intent.id}`,
    eventId: intent.id,
    timestamp: lastEvent.timestamp,
    taskId,
    role,
    eventType: "agent_action",
    eventLabel: heading.eventLabel,
    stage: toolItem?.tool?.isError ? "动作失败" : toolItem?.tool?.status === "running" ? "执行中" : "思考与行动",
    title: heading.title,
    summary: intentPresentation.text,
    intentSource: intentPresentation.source,
    detail: actionEvents.map((event) => eventTypeLabel(event.role, event.eventType)).join(" → "),
    decision: firstText(callArgs.decision, ...relatedPayloads.map((payload) => firstRecord(payload.plannerDecision)?.decision), ...relatedPayloads.map((payload) => firstRecord(payload.controlSignal)?.decision)),
    action,
    observation: toolItem?.observation,
    next: toolItem?.next,
    commandDetails: commandDetails.length ? commandDetails : undefined,
    evidenceRefs,
    artifactRefs,
    graphNodeRefs: uniqueStrings([taskId, ...evidenceRefs]),
    tool: toolItem?.tool,
    rawEvent: {
      id: `action:${intent.id}`,
      kind: "aggregated_trace_step",
      taskId,
      role,
      eventType: "agent_action",
      timestamp: lastEvent.timestamp,
      intentSource: intentPresentation.source,
      intent: intentPresentation.text,
      action,
      sourceEvents: actionEvents.map(compactExecutionEvent)
    }
  };
}

function toToolTraceItem(events: WebEvent[]): TraceItem {
  const sortedEvents = [...events].sort((left, right) => timestampMs(left.timestamp) - timestampMs(right.timestamp));
  const firstEvent = sortedEvents[0];
  const lastEvent = sortedEvents[sortedEvents.length - 1];
  const startEvent = sortedEvents.find((event) => isToolStartEvent(event.eventType)) ?? firstEvent;
  const endEvent = [...sortedEvents].reverse().find((event) => isToolEndEvent(event.eventType));
  const payloads = sortedEvents.map((event) => (isRecord(event.payload) ? event.payload : {}));
  const primaryPayload = payloads.find((payload) => stringValue(payload.toolName, "")) ?? {};
  const resultPayload = endEvent && isRecord(endEvent.payload) ? endEvent.payload : [...payloads].reverse().find((payload) => extractToolResult(payload));
  const toolCallId = getToolCallId(firstEvent) ?? "unknown-tool-call";
  const toolName = firstText(...payloads.map(toolNameFromPayload), "unknown");
  const args = firstRecord(...payloads.map((payload) => payload.args)) ?? {};
  const call: TraceToolCall = { id: toolCallId, name: toolName, arguments: args };
  const command = firstText(...payloads.map((payload) => {
    const payloadArgs = isRecord(payload.args) ? payload.args : undefined;
    return payloadArgs?.command;
  }));
  const action = summarizeTraceAction(call) || toolName;
  const result = truncate(extractToolResult(resultPayload ?? {}) || extractToolResult(primaryPayload), 3200);
  const updateCount = sortedEvents.filter((event) => event.eventType === "tool_execution_update").length;
  const isError = payloads.some((payload) => payload.isError === true || messageRecord(payload)?.isError === true);
  const startedAt = startEvent.timestamp;
  const endedAt = endEvent?.timestamp;
  const durationMs = endedAt ? Math.max(0, timestampMs(endedAt) - timestampMs(startedAt)) : undefined;
  const tool: ToolTrace = {
    toolCallId,
    toolName,
    command,
    status: endEvent ? (isError ? "failed" : "completed") : "running",
    isError,
    startedAt,
    endedAt,
    durationMs,
    updateCount,
    eventCount: sortedEvents.length,
    result,
    resultPreview: truncate(result || "暂无工具结果输出", 1100),
    lifecycle: sortedEvents.map((event) => ({
      eventType: event.eventType,
      timestamp: event.timestamp,
      summary: event.summary
    }))
  };
  const taskId = firstText(...sortedEvents.map((event) => event.taskId));
  const role = firstText(...sortedEvents.map((event) => event.role), "executor");
  const intentPresentation = selectTraceIntent({ role, call });
  const heading = traceActionHeading(role, call);
  const artifactRefs = uniqueStrings(sortedEvents.flatMap((event) => stringArray(event.artifactRefs)));
  return {
    id: `trace:tool:${toolCallId}`,
    eventId: toolCallId,
    timestamp: lastEvent.timestamp,
    taskId,
    role,
    eventType: "tool_execution",
    eventLabel: heading.eventLabel,
    stage: isError ? "工具失败" : endEvent ? "工具动作" : "工具运行中",
    title: heading.title,
    summary: intentPresentation.text,
    intentSource: intentPresentation.source,
    detail: [
      `生命周期：${sortedEvents.map((event) => toolLifecycleLabel(event.eventType)).join(" → ")}`,
      durationMs !== undefined ? `耗时：${durationMs}ms` : "",
      `状态：${tool.status}`
    ].filter(Boolean).join(" · "),
    action,
    observation: tool.resultPreview,
    next: traceNextStep(role, call, Boolean(endEvent)),
    evidenceRefs: [],
    artifactRefs,
    graphNodeRefs: uniqueStrings([taskId]),
    tool,
    rawEvent: {
      id: `tool:${toolCallId}`,
      kind: "aggregated_tool_execution",
      taskId,
      role,
      eventType: "tool_execution",
      timestamp: lastEvent.timestamp,
      intentSource: intentPresentation.source,
      intent: intentPresentation.text,
      action,
      payload: {
        toolCallId,
        toolName: tool.toolName,
        command,
        status: tool.status,
        isError,
        startedAt,
        endedAt,
        durationMs,
        updateCount,
        eventCount: sortedEvents.length,
        result: tool.resultPreview
      },
      sourceEvents: sortedEvents.map(compactExecutionEvent)
    }
  };
}

function toTraceItem(event: WebEvent): TraceItem {
  const payload = isRecord(event.payload) ? event.payload : {};
  const taskResult = isRecord(payload.taskResult) ? payload.taskResult : undefined;
  const plannerDecision = isRecord(payload.plannerDecision) ? payload.plannerDecision : undefined;
  const taskEnvelope = isRecord(payload.taskEnvelope) ? payload.taskEnvelope : undefined;
  const controlSignal = firstRecord(payload.controlSignal, isRecord(payload.observerProjection) ? payload.observerProjection.controlSignal : undefined);
  const role = event.role || "runtime";
  const evidenceRefs = uniqueStrings([
    ...stringArray(taskResult?.evidenceRefs),
    ...stringArray(controlSignal?.evidenceRefs),
    ...stringArray(plannerDecision?.basedOnRefs).filter((ref) => ref.startsWith("evidence:"))
  ]);
  const artifactRefs = uniqueStrings([
    ...stringArray(event.artifactRefs),
    ...stringArray(taskResult?.artifactRefs)
  ]);
  const graphNodeRefs = uniqueStrings([
    event.taskId,
    stringValue(taskEnvelope?.scopeRef, ""),
    ...stringArray(taskEnvelope?.targetRefs),
    ...stringArray(plannerDecision?.basedOnRefs),
    ...evidenceRefs
  ]);
  const stage = inferStage(event);
  const action = inferAction(payload);
  const readableSummary = readableEventSummary(event, payload);
  const observation = inferObservation(payload, readableSummary);
  const decision = inferDecision(payload);
  const next = inferNext(payload);
  const summary = summarizeEvent(event, payload, plannerDecision, taskEnvelope, taskResult, controlSignal);
  const detail = inferDetail(payload, readableSummary);
  const commandDetails = summarizePlannerCommands(plannerDecision?.commands);
  const intentSource: TraceIntentSource = extractMessageText(payload)
    ? "recorded"
    : plannerDecision || taskResult || controlSignal
      ? "structured"
      : "derived";
  return {
    id: `trace:${event.id}`,
    eventId: event.id,
    timestamp: event.timestamp,
    taskId: event.taskId,
    role,
    eventType: event.eventType,
    eventLabel: eventTypeLabel(event.role, event.eventType),
    stage,
    title: inferTitle(event),
    summary,
    intentSource,
    detail,
    decision,
    action,
    observation,
    next,
    commandDetails: commandDetails.length ? commandDetails : undefined,
    evidenceRefs,
    artifactRefs,
    graphNodeRefs,
    rawEvent: compactExecutionEvent(event)
  };
}

function inferStage(event: WebEvent): string {
  const eventType = event.eventType || "";
  if (event.role === "planner") {
    if (eventType.includes("task_created") || eventType.includes("create")) return "规划决策";
    return "思考摘要";
  }
  if (event.role === "executor") {
    if (eventType === "agent_start") return "执行启动";
    if (eventType === "agent_end") return "执行结束";
    if (eventType === "turn_end") return "轮次结束";
    if (eventType === "message_end") {
      const payload = isRecord(event.payload) ? event.payload : {};
      const message = messageRecord(payload);
      if (messageToolCalls(message).length > 0) return "决策摘要";
      return stringValue(message?.stopReason, "") === "stop" ? "任务总结" : "执行摘要";
    }
    if (eventType.includes("tool_execution_start")) return "动作";
    if (eventType.includes("tool_execution_update")) return "工具结果";
    if (eventType.includes("tool_execution_end") || eventType.includes("task_completed")) return "任务结果";
    return "执行推理";
  }
  if (event.role === "observer") {
    if (eventType.includes("projection")) return "证据投影";
    return "观察";
  }
  if (eventType.includes("heartbeat")) return "调度心跳";
  if (eventType.includes("failed") || eventType.includes("abort")) return "异常";
  return "调度";
}

function inferTitle(event: WebEvent): string {
  const roleName = roleLabel(event.role);
  const eventType = event.eventType || "";
  if (event.role === "planner" && eventType === "task_created") return "Planner 创建任务";
  if (event.role === "executor" && eventType === "agent_start") return "Executor 开始执行";
  if (event.role === "executor" && eventType === "agent_end") return "Executor 执行结束";
  if (event.role === "executor" && eventType === "message_end") return "Executor 输出摘要";
  if (event.role === "executor" && eventType.includes("tool_execution_start")) return "Executor 调用工具";
  if (event.role === "executor" && eventType.includes("tool_execution_update")) return "Executor 接收工具输出";
  if (event.role === "executor" && eventType.includes("tool_execution_end")) return "Executor 完成工具调用";
  if (event.role === "executor" && eventType === "task_completed") return "Executor 完成任务";
  if (event.role === "observer") return "Observer 观察与投影";
  if (event.role === "runtime") return "Runtime 调度事件";
  return `${roleName} · ${eventType}`;
}

function summarizeEvent(
  event: WebEvent,
  payload: JsonRecord,
  plannerDecision?: JsonRecord,
  taskEnvelope?: JsonRecord,
  taskResult?: JsonRecord,
  controlSignal?: JsonRecord
): string {
  return firstText(
    taskResult?.summary,
    plannerDecision?.reason,
    taskEnvelope?.goal,
    controlSignal?.reason,
    extractMessageText(payload),
    payload.partialResult,
    readableEventSummary(event, payload),
    event.summary,
    extractText(payload),
    "暂无摘要"
  );
}

function inferDetail(payload: JsonRecord, fallback?: string): string {
  const taskEnvelope = isRecord(payload.taskEnvelope) ? payload.taskEnvelope : undefined;
  const taskResult = isRecord(payload.taskResult) ? payload.taskResult : undefined;
  const args = isRecord(payload.args) ? payload.args : undefined;
  const toolCallSummary = extractToolCallSummary(payload);
  const parts = [
    taskEnvelope?.goal ? `目标：${stringValue(taskEnvelope.goal, "")}` : "",
    args?.command ? `命令：${stringValue(args.command, "")}` : "",
    toolCallSummary ? `计划调用：${toolCallSummary}` : "",
    taskResult?.status ? `状态：${stringValue(taskResult.status, "")}` : "",
    fallback && fallback !== "message_end" ? fallback : ""
  ].filter(Boolean);
  return truncate(parts.join(" · ") || extractText(payload) || "等待更多运行信息", 520);
}

function inferAction(payload: JsonRecord): string | undefined {
  const toolName = stringValue(payload.toolName, "");
  const args = isRecord(payload.args) ? payload.args : undefined;
  const toolCallSummary = extractToolCallSummary(payload);
  if (toolCallSummary) return truncate(toolCallSummary, 260);
  if (!toolName && !args) return undefined;
  const command = stringValue(args?.command, "");
  return truncate([toolName ? `工具 ${toolName}` : "", command].filter(Boolean).join(" · "), 260);
}

function inferDecision(payload: JsonRecord): string | undefined {
  const plannerDecision = isRecord(payload.plannerDecision) ? payload.plannerDecision : undefined;
  const controlSignal = firstRecord(payload.controlSignal, isRecord(payload.observerProjection) ? payload.observerProjection.controlSignal : undefined);
  return firstText(plannerDecision?.decision, controlSignal?.decision, undefined);
}

function inferObservation(payload: JsonRecord, fallback?: string): string | undefined {
  const taskResult = isRecord(payload.taskResult) ? payload.taskResult : undefined;
  return firstText(extractToolResult(payload), extractMessageText(payload), payload.partialResult, taskResult?.summary, fallback);
}

function inferNext(payload: JsonRecord): string | undefined {
  const taskResult = isRecord(payload.taskResult) ? payload.taskResult : undefined;
  const controlSignal = firstRecord(payload.controlSignal, isRecord(payload.observerProjection) ? payload.observerProjection.controlSignal : undefined);
  return firstText(taskResult?.suggestedNextGoal, controlSignal?.decision);
}

function eventTypeLabel(role: string, eventType: string): string {
  const key = `${role}:${eventType}`;
  const labels: Record<string, string> = {
    "planner:task_created": "创建任务",
    "executor:agent_start": "执行器启动",
    "executor:agent_end": "执行器结束",
    "executor:message_end": "输出摘要",
    "executor:tool_execution_start": "工具调用开始",
    "executor:tool_execution_update": "工具输出更新",
    "executor:tool_execution_end": "工具调用完成",
    "executor:tool_execution": "工具动作",
    "executor:turn_end": "执行轮次结束",
    "executor:task_completed": "任务完成",
    "observer:agent_start": "观察器启动",
    "observer:agent_end": "观察器结束",
    "observer:evidence_projected": "证据投影",
    "observer:control_signal": "控制信号",
    "runtime:heartbeat": "运行心跳",
    "runtime:budget": "预算更新",
    "runtime:error": "运行异常"
  };
  return labels[key] ?? labels[`runtime:${eventType}`] ?? eventType.replaceAll("_", " ");
}

function toolLifecycleLabel(eventType: string): string {
  const labels: Record<string, string> = {
    tool_execution_start: "开始",
    tool_execution_update: "输出",
    tool_execution_end: "完成",
    message_end: "结果回传"
  };
  return labels[eventType] ?? eventTypeLabel("executor", eventType);
}

function readableEventSummary(event: WebEvent, payload: JsonRecord): string {
  if (event.eventType === "agent_start") return `${roleLabel(event.role)} 已开始处理当前任务。`;
  if (event.eventType === "agent_end") return `${roleLabel(event.role)} 已结束当前任务处理。`;
  if (event.eventType === "turn_end") return "一个执行轮次已结束，等待下一步调度。";
  if (event.eventType === "task_completed") return "当前任务已完成，结果已写入运行态。";
  if (event.eventType === "message_end") return extractMessageText(payload);
  return eventTypeLabel(event.role, event.eventType);
}

function getToolCallId(event: WebEvent): string | undefined {
  const payload = isRecord(event.payload) ? event.payload : {};
  const toolCallId = stringValue(payload.toolCallId, "");
  if (event.eventType?.startsWith("tool_execution") || ["tool_started", "tool_finished", "runtime_control"].includes(event.eventType)) {
    return toolCallId || undefined;
  }
  if (event.eventType === "message_end") {
    const message = messageRecord(payload);
    if (stringValue(message?.role, "") === "toolResult") {
      return stringValue(message?.toolCallId, "") || toolCallId || undefined;
    }
  }
  return undefined;
}

function shouldSkipTraceEvent(event: WebEvent): boolean {
  if (event.role === "runtime") return true;
  if ([
    "agent_start",
    "agent_end",
    "turn_end",
    "turn_usage",
    "assistant_intent",
    "tool_started",
    "tool_finished",
    "runtime_control",
    "planner_apply_commands",
    "supervisor_check_succeeded",
    "projection_job_succeeded",
    "projection_job_failed",
    "provider_error"
  ].includes(event.eventType)) {
    return true;
  }
  if (event.eventType !== "message_end") return false;
  const payload = isRecord(event.payload) ? event.payload : {};
  const message = messageRecord(payload);
  const role = stringValue(message?.role, "");
  if (role === "user" || role === "toolResult") return true;
  if (role === "assistant") {
    return !extractMessageText(payload) && messageToolCalls(message).length > 0;
  }
  return !extractMessageText(payload);
}

function isToolStartEvent(eventType: string): boolean {
  return eventType === "tool_started" || eventType === "tool_execution_start";
}

function isToolEndEvent(eventType: string): boolean {
  return eventType === "tool_finished" || eventType === "runtime_control" || eventType === "tool_execution_end";
}

function isAgentActionDetailEvent(eventType: string): boolean {
  return [
    "tool_started",
    "tool_finished",
    "runtime_control",
    "turn_usage",
    "planner_apply_commands",
    "supervisor_check_succeeded",
    "task_completed",
    "task_partial",
    "task_blocked",
    "task_failed"
  ].includes(eventType);
}

function intentToolCalls(payload: JsonRecord): TraceToolCall[] {
  return arrayValue(payload.toolCalls)
    .filter(isRecord)
    .map((call) => ({
      id: stringValue(call.id, "") || undefined,
      name: stringValue(call.name, ""),
      arguments: isRecord(call.arguments) ? call.arguments : {}
    }));
}

function eventEvidenceRefs(event: WebEvent): string[] {
  const payload = isRecord(event.payload) ? event.payload : {};
  const args = isRecord(payload.args) ? payload.args : {};
  const plannerDecision = firstRecord(payload.plannerDecision);
  const controlSignal = firstRecord(payload.controlSignal);
  return uniqueStrings([
    ...stringArray(args.evidenceRefs),
    ...stringArray(plannerDecision?.basedOnRefs).filter((ref) => ref.startsWith("evidence:") || ref.startsWith("event:")),
    ...stringArray(controlSignal?.evidenceRefs)
  ]);
}

function extractToolResult(payload: JsonRecord): string {
  const message = messageRecord(payload);
  for (const value of [payload.result, payload.partialResult, payload.output, payload.stdout, payload.stderr, message]) {
    const text = toolContentText(value).trim();
    if (text) return text;
  }
  return "";
}

function extractMessageText(payload: JsonRecord): string {
  const message = messageRecord(payload);
  if (!message) return "";
  const content = arrayValue(message.content);
  const text = content
    .map((item) => {
      if (!isRecord(item) || item.type !== "text") return "";
      return stringValue(item.text, "");
    })
    .filter(Boolean)
    .join("\n\n");
  return truncate(text, 1200);
}

function extractToolCallSummary(payload: JsonRecord): string {
  const calls = messageToolCalls(messageRecord(payload));
  return calls
    .map((call) => {
      const name = stringValue(call.name, "tool");
      const argumentsRecord = isRecord(call.arguments) ? call.arguments : {};
      const command = stringValue(argumentsRecord.command, "");
      return command ? `${name}: ${command}` : name;
    })
    .join("；");
}

function messageRecord(payload: JsonRecord): JsonRecord | undefined {
  return firstRecord(payload.message);
}

function messageToolCalls(message: JsonRecord | undefined): JsonRecord[] {
  return arrayValue(message?.content).filter((item): item is JsonRecord => isRecord(item) && item.type === "toolCall");
}

function toolNameFromPayload(payload: JsonRecord): string {
  return firstLongText(payload.toolName, messageRecord(payload)?.toolName);
}

function toolContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toolContentText).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  const direct = firstLongText(value.text, value.preview, value.stdout, value.stderr, value.output, value.summary);
  if (direct) return direct;
  if (isRecord(value.text)) {
    const nestedText = toolContentText(value.text);
    if (nestedText) return nestedText;
  }
  if (Array.isArray(value.content)) {
    return value.content.map(toolContentText).filter(Boolean).join("\n");
  }
  return "";
}

function timestampMs(value: string): number {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function findLatestControlSignal(events: WebEvent[]): JsonRecord | undefined {
  for (const event of [...events].reverse()) {
    const payload = isRecord(event.payload) ? event.payload : {};
    const controlSignal = firstRecord(payload.controlSignal, isRecord(payload.observerProjection) ? payload.observerProjection.controlSignal : undefined);
    if (controlSignal) return controlSignal;
  }
  return undefined;
}

function compactExecutionEvent(event: WebEvent): JsonRecord {
  return {
    id: event.id,
    taskId: event.taskId,
    role: event.role,
    eventType: event.eventType,
    eventLabel: eventTypeLabel(event.role, event.eventType),
    timestamp: event.timestamp,
    summary: event.summary,
    artifactRefs: event.artifactRefs,
    payload: compactJson(event.payload, 0)
  };
}

function compactArtifact(record: ArtifactRecord): ArtifactRecord {
  return {
    artifactRef: record.artifactRef,
    taskId: record.taskId,
    kind: record.kind,
    mediaType: record.mediaType,
    path: record.path,
    byteLength: record.byteLength,
    createdAt: record.createdAt,
    preview: truncate(record.preview ?? "", 900)
  };
}

function compactJson(value: unknown, depth: number): unknown {
  if (typeof value === "string") return truncate(value, 1200);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 18).map((item) => compactJson(item, depth + 1));
  if (depth > 5) return "[truncated:depth]";
  const output: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (["thinking", "thinkingSignature", "messages"].includes(key)) continue;
    output[key] = compactJson(item, depth + 1);
  }
  return output;
}

async function readJsonl<T>(filePath: string, limit: number): Promise<T[]> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0).slice(-limit);
    const parsed: T[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as T);
      } catch {
        // Skip corrupted tail lines so one bad event does not blank the dashboard.
      }
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function countJsonlLines(filePath: string): Promise<number> {
  try {
    let count = 0;
    let pending = "";
    for await (const chunk of createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024 })) {
      const text = pending + chunk;
      const lines = text.split("\n");
      pending = lines.pop() ?? "";
      count += lines.reduce((sum, line) => sum + Number(line.trim().length > 0), 0);
    }
    return count + Number(pending.trim().length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function statMaybe(filePath: string) {
  try {
    return await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function toRuntimeInput(runtimeDir: string): string {
  const relativePath = relative(cwd, runtimeDir);
  if (!relativePath || relativePath === "") return ".";
  if (relativePath.startsWith("..")) return runtimeDir;
  return relativePath.split(sep).join("/");
}

async function sendStatic(pathname: string, response: ServerResponse): Promise<void> {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(staticRoot, `.${decodeURIComponent(requestedPath)}`);
  if (!isInside(filePath, staticRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-store" });
    response.end(await readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    throw error;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.length;
    if (byteLength > 32 * 1024) throw new WebAuthError("请求体过大", 413, "payload_too_large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(parsed)) throw new Error("body must be an object");
    return parsed;
  } catch {
    throw new WebAuthError("请求内容不是有效的 JSON 对象", 400, "invalid_json");
  }
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) return decodeURIComponent(valueParts.join("="));
  }
  return undefined;
}

function sessionCookie(token: string, request: IncomingMessage): string {
  const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`;
}

function clearSessionCookie(request: IncomingMessage): string {
  const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

async function sendJson(
  response: ServerResponse,
  data: unknown,
  statusCode = 200,
  headers: Record<string, string | string[]> = {}
): Promise<void> {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(data, null, 2));
}

function parseArgs(rawArgs: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg.startsWith("--")) {
      const value = rawArgs[index + 1];
      if (value && !value.startsWith("--")) {
        parsed[arg.slice(2)] = value;
        index += 1;
      }
    }
  }
  return parsed;
}

function parseWebPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid web server port: ${value} (expected an integer between 1 and 65535)`);
  }
  return port;
}

function isLoopbackHost(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".woff2": return "font/woff2";
    case ".ico": return "image/x-icon";
    default: return "application/octet-stream";
  }
}

function isInside(filePath: string, root: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return filePath === root || filePath.startsWith(normalizedRoot);
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return truncate(value, 480);
  if (!isRecord(value)) return "";
  const directText = stringValue(value.text ?? value.summary ?? value.reason ?? value.content, "");
  if (directText) return truncate(directText, 480);
  if (Array.isArray(value.content)) {
    const textItem = value.content.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
    if (isRecord(textItem)) return truncate(stringValue(textItem.text, ""), 480);
  }
  return "";
}

function parseJsonObject(value: unknown): JsonRecord {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    return stringArray(JSON.parse(value));
  } catch {
    return [];
  }
}

function firstRecord(...values: unknown[]): JsonRecord | undefined {
  return values.find(isRecord);
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return truncate(value.trim(), 520);
  }
  return "";
}

function firstLongText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function roleLabel(role: string): string {
  switch (role) {
    case "planner": return "Planner";
    case "executor": return "Executor";
    case "observer": return "Observer";
    case "runtime": return "Runtime";
    default: return role || "Unknown";
  }
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
