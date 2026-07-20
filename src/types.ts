export type AgentRole = "planner" | "executor" | "observer";

export type GraphKind = "reasoning" | "operation" | "task";

export type ReasoningNodeType =
  | "Evidence"
  | "Hypothesis"
  | "Vulnerability"
  | "Exploit";

export type OperationNodeType =
  | "Host"
  | "Port"
  | "Service"
  | "WebEndpoint"
  | "Parameter"
  | "Credential"
  | "Session"
  | "File"
  | "Process";

export type TaskNodeType =
  | "Goal"
  | "Task"
  | "Milestone"
  | "Blocker"
  | "Scope";

export type GraphNodeType =
  | ReasoningNodeType
  | OperationNodeType
  | TaskNodeType;

export type EdgeType =
  | "supports"
  | "contradicts"
  | "confirms"
  | "promoted_to"
  | "exploited_by"
  | "produces_evidence"
  | "observed_on"
  | "affects"
  | "has_port"
  | "runs_service"
  | "exposes_endpoint"
  | "has_parameter"
  | "authenticates_to"
  | "creates_session"
  | "session_on"
  | "contains_file"
  | "spawns_process"
  | "decomposes_to"
  | "depends_on"
  | "within_scope"
  | "produces_milestone"
  | "blocked_by"
  | "unblocked_by"
  | "requires_evidence";

export type JsonObject = Record<string, unknown>;

export type GraphNode = {
  id: string;
  graphKind: GraphKind;
  type: GraphNodeType | string;
  label: string;
  properties: JsonObject;
  evidenceRefs?: string[];
};

export type GraphEdge = {
  from: string;
  to: string;
  type: EdgeType | string;
  evidenceRefs?: string[];
  properties?: JsonObject;
};

export type GraphDelta = {
  sourceEventIds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type TaskEnvelope = {
  taskId: string;
  goal: string;
  targetRefs: string[];
  scopeRef: string;
  constraints: string[];
  successCriteria: string[];
  availableSessionRefs?: string[];
  dependsOnTaskRefs?: string[];
  parentTaskId?: string;
  parallelGroup?: string;
  budget?: {
    maxTurns?: number;
  };
};

export type TaskBudget = NonNullable<TaskEnvelope["budget"]>;

export type TaskResultStatus = "completed" | "partial" | "blocked" | "failed";

export type TaskResult = {
  taskId: string;
  status: TaskResultStatus;
  summary: string;
  evidenceRefs: string[];
  artifactRefs: string[];
  blockerReason?: string;
  suggestedNextGoal?: string;
  checkpointReason?: string;
  retryable?: boolean;
  attempt?: number;
  resumeCursor?: string;
  lastEventId?: string;
};

export type TaskGraphStatus = "open" | "partial" | "completed" | "blocked" | "failed" | "archived";

export type PlannerDecisionType = "apply_commands" | "need_user_input";

export type PlannerDecision = {
  decision: PlannerDecisionType;
  commands?: PlannerCommand[];
  reason: string;
  basedOnRefs: string[];
};

export type PlannerTaskSpec = {
  id: string;
  goal: string;
  targetRefs: string[];
  scopeRef: string;
  constraints: string[];
  successCriteria: string[];
  budget?: TaskBudget;
  priority: number;
  parentTaskId?: string;
  dependsOnTaskRefs?: string[];
  parallelGroup?: string;
};

export type PlannerTaskPatch = {
  goal?: string;
  constraints?: string[];
  successCriteria?: string[];
  budget?: TaskBudget;
  priority?: number;
  parallelGroup?: string;
};

type PlannerCommandBasis = {
  basedOnRefs?: string[];
  reason?: string;
};

export type PlannerCommand =
  | ({
      kind: "create_tasks";
      tasks: PlannerTaskSpec[];
    } & PlannerCommandBasis)
  | ({
      kind: "patch_task";
      taskId: string;
      patch: PlannerTaskPatch;
    } & PlannerCommandBasis)
  | ({
      kind: "replace_dependencies";
      taskId: string;
      dependencyTaskIds: string[];
    } & PlannerCommandBasis)
  | ({
      kind: "set_task_status";
      taskId: string;
      status: TaskGraphStatus;
    } & PlannerCommandBasis)
  | ({
      kind: "set_node_status";
      nodeId: string;
      status: string;
    } & PlannerCommandBasis);

export type ControlSignalDecision =
  | "continue"
  | "checkpoint"
  | "stop_executor"
  | "need_planner"
  | "need_user_input";

export type ControlSignal = {
  decision: ControlSignalDecision;
  reason: string;
  evidenceRefs: string[];
  confidence?: "low" | "medium" | "high";
  budgetExtension?: {
    maxTurnsDelta?: number;
    reason?: string;
  };
};

export type RuntimeAbortKind =
  | "budget_abort"
  | "observer_abort"
  | "controller_abort";

export type RuntimeAbortContext = {
  kind: RuntimeAbortKind;
  reason: string;
  controlSignal?: ControlSignal;
};

export type ObserverProjection = {
  graphDelta: GraphDelta;
  controlSignal: ControlSignal;
};

export type ObserverMode = "supervise" | "project";

export type ExecutionEvent = {
  id: string;
  seq?: number;
  epochId?: string;
  taskId?: string;
  role: AgentRole | "runtime";
  eventType: string;
  timestamp: string;
  summary?: string;
  payload: JsonObject;
  artifactRefs?: string[];
};

export type ExecutionEpochState = "created" | "running" | "closing" | "closed";

export type ExecutionEpochTerminationReason =
  | "executor_submitted"
  | "supervisor_checkpoint"
  | "budget_exhausted"
  | "time_slice_exhausted"
  | "provider_error"
  | "timeout"
  | "shutdown";

export type ExecutionEpochRecord = {
  epochId: string;
  taskId: string;
  attempt: number;
  state: ExecutionEpochState;
  terminationReason?: ExecutionEpochTerminationReason;
  startedAt: string;
  closedAt?: string;
  startSeq?: number;
  endSeq?: number;
};

export type ProjectionState = {
  taskId: string;
  committedSeq: number;
  desiredSeq: number;
  generation: number;
  activeGeneration?: number;
  priority: number;
  updatedAt: string;
};

export type ProjectionClaim = {
  taskId: string;
  fromSeq: number;
  toSeq: number;
  generation: number;
};

export type ArtifactRecord = {
  artifactRef: string;
  taskId?: string;
  kind: "http_body" | "screenshot" | "stdout" | "stderr" | "poc" | "json" | "text" | "other";
  mediaType: string;
  path: string;
  byteLength: number;
  createdAt: string;
  preview: string;
  contentHash?: string;
};

export type GraphView = "planner" | "reasoning" | "operation" | "task" | "sessions";

export type GraphSnapshot = {
  view: GraphView;
  nodes: GraphNode[];
  edges: GraphEdge[];
  summary: JsonObject;
};

export type PlannerTaskLedgerItem = {
  taskId: string;
  status: string;
  goal: string;
  resultSummary?: string;
  checkpointReason?: string;
  resumeCursor?: string;
  blockerReason?: string;
  suggestedNextGoal?: string;
  retryable?: boolean;
  attempt?: number;
  priority?: number;
  dependsOnTaskRefs?: string[];
};

export type PlannerDigestItem = {
  id: string;
  graphKind: GraphKind;
  type: string;
  label: string;
  status?: string;
  score: number;
  reasons: string[];
  edgeCount: number;
  evidenceRefCount: number;
  properties: JsonObject;
};

export type PlannerDecisionView = {
  view: "planner_decision";
  taskLedger: PlannerTaskLedgerItem[];
  reasoningDigest: PlannerDigestItem[];
  operationDigest: PlannerDigestItem[];
  blockers: PlannerDigestItem[];
  graphSummary: JsonObject;
  runtimeTail?: Array<{
    taskId: string;
    committedSeq: number;
    desiredSeq: number;
    digest: string;
  }>;
  retrievalHints: {
    tools: Array<"graph_query" | "graph_trace">;
    note: string;
  };
};
