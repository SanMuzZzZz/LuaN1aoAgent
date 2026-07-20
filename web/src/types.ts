export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue | undefined>;

export type Role = "planner" | "executor" | "observer" | "runtime" | string;
export type ViewKey = "trace" | "reasoning" | "operation" | "task";
export type GraphKind = Exclude<ViewKey, "trace">;

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "analyst";
  createdAt: string;
}

export interface AuthResponse {
  user: AuthUser;
}

export interface GraphNode {
  id: string;
  graphKind: string;
  type: string;
  label: string;
  properties: JsonRecord;
  evidenceRefs: string[];
  updatedAt?: string;
}

export interface GraphEdge {
  id?: string;
  from: string;
  to: string;
  type: string;
  properties: JsonRecord;
  evidenceRefs: string[];
  updatedAt?: string;
}

export interface ToolTrace {
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
}

export interface TraceItem {
  id: string;
  eventId: string;
  timestamp: string;
  taskId?: string;
  role: Role;
  eventType: string;
  eventLabel: string;
  stage: string;
  title: string;
  summary: string;
  intentSource: "recorded" | "structured" | "derived";
  detail: string;
  decision?: string;
  action?: string;
  observation?: string;
  next?: string;
  evidenceRefs: string[];
  artifactRefs: string[];
  graphNodeRefs: string[];
  tool?: ToolTrace;
  rawEvent: JsonRecord;
}

export interface ArtifactRecord {
  artifactRef: string;
  taskId?: string;
  kind?: string;
  mediaType?: string;
  path?: string;
  byteLength?: number;
  createdAt?: string;
  preview?: string;
}

export interface RuntimeSession {
  name: string;
  runtimeDir: string;
  relativePath?: string;
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
}

export interface RuntimeState {
  runtimeDir: string;
  loadedAt: string;
  overview: {
    goal?: { id: string; label: string; status?: JsonValue };
    scope?: { id: string; label: string; summary?: JsonValue };
    graph: { nodeCount: number; edgeCount: number; byKind: Record<string, number>; byType: Record<string, number> };
    events: { count: number; byRole: Record<string, number>; byType: Record<string, number> };
    tasks: {
      count: number;
      byStatus: Record<string, number>;
      latest?: TaskSummary;
      items: TaskSummary[];
    };
    artifacts: { count: number; totalBytes: number };
    agents: Record<string, AgentEvent | undefined>;
    latestControlSignal?: JsonRecord;
  };
  traceItems: TraceItem[];
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    source: string;
    summary: JsonRecord;
    sqliteError?: string;
  };
  events: JsonRecord[];
  artifacts: { records: ArtifactRecord[]; summary: { count: number; totalBytes: number } };
}

export interface TaskSummary {
  id: string;
  label: string;
  status: string;
  priority?: JsonValue;
  updatedAt?: string;
}

export interface AgentEvent {
  id?: string;
  role?: string;
  eventType?: string;
  timestamp?: string;
  summary?: string;
}

export interface SessionsResponse {
  rootDir: string;
  loadedAt: string;
  sessions: RuntimeSession[];
  summary: { count: number; totalTasks: number; totalEvents: number };
}
