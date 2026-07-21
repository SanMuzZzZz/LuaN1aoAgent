import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebAuthError, WebAuthService } from "./web-auth.js";
import { SecurityAgentController } from "./controller.js";
import { discoverRuntimeSessionDirs } from "./runtime-session-discovery.js";
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
};

const args = parseArgs(process.argv.slice(2));
const host = args.host ?? "127.0.0.1";
const port = Number(args.port ?? 8787);
const cwd = process.cwd();
const staticRoot = resolve(cwd, "web", "dist");
const defaultRuntimeDir = args["runtime-dir"] ?? ".agent-runtime";
const authService = new WebAuthService(resolve(cwd, args["auth-db"] ?? ".agent-runtime/web-auth.sqlite"));
const sessionCookieName = "luanniao_session";
const activeRuns = new Map<string, ActiveRun>();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
    if (url.pathname.startsWith("/api/auth/")) {
      await handleAuthRequest(request, response, url.pathname);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const user = authService.authenticate(readCookie(request, sessionCookieName));
      if (!user) {
        await sendJson(response, { error: { code: "unauthorized", message: "请先登录" } }, 401);
        return;
      }
    }
    if (url.pathname === "/api/state") {
      const runtimeDir = url.searchParams.get("runtimeDir") ?? defaultRuntimeDir;
      await sendJson(response, await readRuntimeState(runtimeDir));
      return;
    }
    if (url.pathname === "/api/sessions") {
      const rootDir = url.searchParams.get("rootDir") ?? defaultRuntimeDir;
      await sendJson(response, await readRuntimeSessions(rootDir));
      return;
    }
    if (url.pathname === "/api/runs") {
      if (request.method === "POST") {
        await handleStartRun(request, response);
        return;
      }
      if (request.method === "GET") {
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
      await handleStopRun(request, response);
      return;
    }
    if (url.pathname === "/api/artifact") {
      const runtimeDir = url.searchParams.get("runtimeDir") ?? defaultRuntimeDir;
      const artifactRef = url.searchParams.get("artifactRef") ?? "";
      await sendJson(response, await readArtifactContent(runtimeDir, artifactRef));
      return;
    }
    await sendStatic(url.pathname, response);
  } catch (error) {
    if (error instanceof WebAuthError) {
      await sendJson(response, { error: { code: error.code, message: error.message } }, error.statusCode);
      return;
    }
    if (error instanceof HttpError) {
      await sendJson(response, { error: { code: error.code, message: error.message } }, error.statusCode);
      return;
    }
    await sendJson(response, { error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) } }, 500);
  }
});

class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

server.listen(port, host, () => {
  console.log(`Luanniao Agent Trace listening on http://${host}:${port}`);
  console.log(`Runtime dir: ${resolve(cwd, defaultRuntimeDir)}`);
});

async function handleAuthRequest(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
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
    await sendJson(response, { ok: true }, 200, { "Set-Cookie": clearSessionCookie(request) });
    return;
  }

  await sendJson(response, { error: { code: "not_found", message: "认证接口不存在" } }, 404);
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
  const runtimeDir = join(cwd, ".agent-runtime", "sessions", `${timestamp}-web-${randomUUID().slice(0, 8)}`);
  const controller = new SecurityAgentController({ cwd, runtimeDir });
  await controller.initialize();

  const run: ActiveRun = {
    runtimeDir,
    runtimeInput: toRuntimeInput(runtimeDir),
    goal,
    scope,
    startedAt: new Date().toISOString(),
    controller
  };
  activeRuns.set(runtimeDir, run);

  const options: Parameters<SecurityAgentController["runUntilDone"]>[0] = { userGoal: goal, scopeSummary: scope };
  const maxRunTimeMs = optionalPositiveNumber(body.maxRunTimeMs);
  const maxParallelTasks = optionalPositiveNumber(body.maxParallelTasks);
  const maxPlannerCycles = optionalPositiveNumber(body.maxPlannerCycles);
  if (maxRunTimeMs !== undefined) options.maxRunTimeMs = maxRunTimeMs;
  if (maxParallelTasks !== undefined) options.maxParallelTasks = maxParallelTasks;
  if (maxPlannerCycles !== undefined) options.maxPlannerCycles = maxPlannerCycles;

  void controller.runUntilDone(options)
    .then((result) => {
      console.log(`[web run finished] ${run.runtimeInput}: completed=${result.completed} reason=${result.stoppedReason ?? "-"}`);
    })
    .catch((error: unknown) => {
      console.error(`[web run failed] ${run.runtimeInput}:`, error instanceof Error ? error.message : error);
    })
    .finally(async () => {
      activeRuns.delete(runtimeDir);
      await controller.close().catch(() => undefined);
    });

  await sendJson(response, {
    runtimeDir: run.runtimeInput,
    name: basename(runtimeDir),
    goal,
    scope,
    startedAt: run.startedAt,
    running: true
  }, 201);
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
  const run = activeRuns.get(resolve(cwd, input));
  if (!run) {
    await sendJson(response, { error: { code: "run_not_found", message: "任务未在运行中，或不属于本 Web 进程" } }, 404);
    return;
  }
  void run.controller.requestStop("Stopped from web UI").catch(() => undefined);
  await sendJson(response, { ok: true, runtimeDir: run.runtimeInput, stopping: true });
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function readRuntimeState(runtimeDirInput: string): Promise<JsonRecord> {
  const runtimeDir = resolve(cwd, runtimeDirInput);
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
  const runtimeDir = resolve(cwd, runtimeDirInput);
  const artifactsRoot = resolve(runtimeDir, "artifacts");
  const records = await readJsonl<ArtifactRecord>(join(artifactsRoot, "index.jsonl"), 100_000);
  const record = records.find((item) => item.artifactRef === artifactRef);
  if (!record?.path) {
    throw new HttpError(404, "artifact_not_found", "Artifact 不存在或不在当前索引中");
  }
  const filePath = resolve(record.path);
  if (filePath !== artifactsRoot && !filePath.startsWith(`${artifactsRoot}${sep}`)) {
    throw new HttpError(403, "forbidden", "Artifact 路径超出 runtime 目录");
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

async function readRuntimeSessions(rootDirInput: string): Promise<JsonRecord> {  const rootDir = resolve(cwd, rootDirInput);
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
          edgesById.set(`${edge.from}::${edge.type}::${edge.to}`, edge);
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
    "planner_need_user_input",
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
  headers: Record<string, string> = {}
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
