import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createExecutorAgentSession, createObserverAgentSession, createPlannerAgentSession, projectSkillsDirs, type SecurityAgentRuntime, type SecurityAgentSession } from "./agents.js";
import { extractJsonObject } from "./json.js";
import { createLlmRuntime, type LlmRuntime } from "./llm-config.js";
import { createExecutorSandbox, type ExecutorSandbox } from "./executor-sandbox.js";
import { summarizeSupervisorTrace } from "./log-summary.js";
import { normalizePlannerDecision } from "./planner-commands.js";
import {
  renderExecutorInput,
  renderExecutorResumeInput,
  renderObserverInput,
  renderPlannerInput,
  renderSupervisorInput,
  PLANNER_RUNTIME_TAIL_MAX_CHARS
} from "./prompts.js";
import {
  attachExecutionLogging,
  classifyLlmErrorKind,
  invokeStructured,
  isRetryableLlmErrorKind,
  promptAndCollect,
  PromptRuntimeError,
  StructuredInvocationError,
  type LlmErrorKind
} from "./pi-runner.js";
import {
  aliasProjectionGraphContext,
  buildProjectionObservations,
  causalObservationDigest,
  capabilityDigest,
  compactProjectionBatchForInput,
  expandProjectionDraft,
  observationDigest,
  renderProjectionGraphContext,
  renderProjectionObservations,
  selectProjectionBatch,
  type ProjectionBatch,
  type ProjectionObservation
} from "./projection.js";
import { ArtifactStore } from "./stores/artifact-store.js";
import { ExecutionLog } from "./stores/execution-log.js";
import {
  GraphValidationError,
  PlannerDecisionConflict,
  SQLiteGraphStore,
  type PlannerTaskBatchCommand
} from "./stores/graph-store.js";
import { RuntimeStore } from "./stores/runtime-store.js";
import type {
  AgentRole,
  ControlSignal,
  ExecutionEpochTerminationReason,
  ExecutionEvent,
  GraphDelta,
  ObserverMode,
  ObserverProjection,
  PlannerCommand,
  PlannerDecisionView,
  PlannerDecision,
  PlannerTaskSpec,
  ProjectionClaim,
  RuntimeAbortContext,
  TaskBudget,
  TaskEnvelope,
  TaskResult,
  TaskResultStatus
} from "./types.js";

type PlannerTaskCommand = Extract<PlannerCommand, { kind: "patch_task" | "replace_dependencies" | "set_task_status" }>;
type PlannerCreateTasksCommand = Extract<PlannerCommand, { kind: "create_tasks" }>;
type PlannerNodeStatusCommand = Extract<PlannerCommand, { kind: "set_node_status" }>;

export const DEFAULT_TASK_BUDGET: Required<TaskBudget> = {
  maxTurns: 12
};
const PLANNER_DECISION_REPAIR_ATTEMPTS = 2;

export const MIN_TASK_BUDGET: Required<TaskBudget> = {
  maxTurns: 10
};

export const MAX_TASK_BUDGET: Required<TaskBudget> = {
  maxTurns: 40
};

export const DEFAULT_RUN_TIME_BUDGET_MS = 900_000;
export const TASK_EPOCH_RUN_TIME_SHARE = 0.5;

const CONTINUE_CONTROL_SIGNAL: ControlSignal = {
  decision: "continue",
  reason: "No runtime intervention required",
  evidenceRefs: [],
  confidence: "medium"
};

const RUNTIME_HEARTBEAT_MS = positiveIntegerEnv("RUNTIME_HEARTBEAT_MS", 60_000);
const SUPERVISOR_IDLE_TIMEOUT_MS = positiveIntegerEnv("SUPERVISOR_IDLE_TIMEOUT_MS", 60_000);
const SUPERVISOR_HARD_TIMEOUT_MS = positiveIntegerEnv(
  "SUPERVISOR_HARD_TIMEOUT_MS",
  positiveIntegerEnv("SUPERVISOR_TIMEOUT_MS", 90_000)
);
const PROJECTOR_IDLE_TIMEOUT_MS = positiveIntegerEnv("PROJECTOR_IDLE_TIMEOUT_MS", 180_000);
const PROJECTOR_HARD_TIMEOUT_MS = positiveIntegerEnv(
  "PROJECTOR_HARD_TIMEOUT_MS",
  positiveIntegerEnv("PROJECTOR_TIMEOUT_MS", 300_000)
);
const PLANNER_IDLE_TIMEOUT_MS = positiveIntegerEnv("PLANNER_IDLE_TIMEOUT_MS", 180_000);
const PLANNER_HARD_TIMEOUT_MS = positiveIntegerEnv(
  "PLANNER_HARD_TIMEOUT_MS",
  positiveIntegerEnv("PLANNER_TIMEOUT_MS", 360_000)
);
const PLANNER_FRESH_SESSION_ATTEMPTS = positiveIntegerEnv(
  "PLANNER_FRESH_SESSION_ATTEMPTS",
  positiveIntegerEnv("PLANNER_PROVIDER_RETRY_ATTEMPTS", 2)
);
const PLANNER_FRESH_SESSION_BACKOFF_MS = positiveIntegerEnv(
  "PLANNER_FRESH_SESSION_BACKOFF_MS",
  positiveIntegerEnv("PLANNER_PROVIDER_RETRY_BACKOFF_MS", 250)
);
const PLANNER_DEFER_BACKOFF_MAX_MS = 5_000;
const PLANNER_MAX_DEFERRED_FAILURES = positiveIntegerEnv("PLANNER_MAX_DEFERRED_FAILURES", 12);
const MISSING_SUBMIT_RETRY_FEEDBACK = "上一次 Planner 调用未产生 planner_submit（输出在达到 max_completion_tokens 上限时被截断）。请直接调用 planner_submit 提交当前最佳决策：先发起工具调用，参数保持简洁（commands 内只保留必要字段），不要在正文输出推理过程。";
const SUPERVISOR_TURN_WINDOW_SIZE = positiveIntegerEnv("SUPERVISOR_TURN_WINDOW_SIZE", 8);
const PROJECTOR_TOOL_WINDOW_SIZE = positiveIntegerEnv("PROJECTOR_TOOL_WINDOW_SIZE", 16);
const TURN_WINDOW_REASON_PREFIX = "turn_window:";
const PROJECT_WINDOW_REASON_PREFIX = "project_window:";
const DEFAULT_MAX_PARALLEL_TASKS = 2;
const BUDGET_EXTENSION_TURNS = 4;
const MAX_BUDGET_EXTENSIONS = 3;
const BUDGET_PRESSURE_TURNS = 2;
const PROJECTION_CANCEL_GRACE_MS = 2_000;
const PROJECTION_DRAIN_TIMEOUT_MS = positiveIntegerEnv(
  "PROJECTION_DRAIN_TIMEOUT_MS",
  PROJECTOR_HARD_TIMEOUT_MS
);
const MAX_ACTIVE_PROJECTION_JOBS = positiveIntegerEnv("MAX_ACTIVE_PROJECTION_JOBS", 2);
const PROJECTOR_ARTIFACT_MANIFEST_LIMIT = 3;
const PROJECTOR_MAX_OBSERVATIONS_PER_JOB = positiveIntegerEnv("PROJECTOR_MAX_OBSERVATIONS_PER_JOB", 16);
const PROJECTOR_INPUT_TARGET_BYTES = positiveIntegerEnv(
  "PROJECTOR_INPUT_TARGET_BYTES",
  positiveIntegerEnv("PROJECTOR_INPUT_HARD_LIMIT_BYTES", 32_000)
);
const PROJECTOR_MAX_RETRIES = 1;
const DEFAULT_PROJECTOR_CATCHUP_DELAY_MS = 45_000;
const DEFAULT_PROJECTOR_CATCHUP_MIN_OBSERVATIONS = 4;
const PROJECTOR_OBSERVATION_ROLES: Array<AgentRole | "runtime"> = ["executor", "runtime"];
const PROJECTOR_OBSERVATION_EVENT_TYPES = [
  "assistant_intent",
  "tool_started",
  "tool_finished",
  "provider_error",
  "task_completed",
  "task_partial",
  "task_blocked",
  "task_failed"
];
const EXECUTOR_CHECKPOINT_GRACE_MS = positiveIntegerEnv("EXECUTOR_CHECKPOINT_GRACE_MS", 120_000);
const EXECUTOR_PROVIDER_RETRY_ATTEMPTS = 2;
const EXECUTOR_PROVIDER_RETRY_BACKOFF_MS = 250;
const EXECUTOR_SESSION_DIR = "executor-sessions";

type ObserverProjectionRequest = {
  reason: string;
  taskEnvelope: TaskEnvelope;
  taskResult?: TaskResult;
  sourceEventIds?: string[];
  queueId?: string;
  queuedAt?: number;
};

type PendingProjectionRequest = ObserverProjectionRequest & {
  queueId: string;
  queuedAt: number;
  sequence: number;
  supersedes?: string[];
  resolve?: (projection: ObserverProjection) => void;
  reject?: (error: unknown) => void;
};

type SupervisorCheckRequest = {
  reason: string;
  taskEnvelope: TaskEnvelope;
  sourceEventIds?: string[];
  taskResult?: TaskResult;
  queueId?: string;
  queuedAt?: number;
};

type TaskSupervisionState = {
  taskId: string;
  phase: "recon" | "exploit" | "verify" | "extract" | "unknown";
  progressDigest: string;
  repeatedPatterns: string[];
  negativeFindings: string[];
  openQuestions: string[];
  recentFingerprints: string[];
};

type ActiveTaskState = {
  epochId: string;
  lifecycleState: "created" | "running" | "closing" | "closed";
  terminationReason?: ExecutionEpochTerminationReason;
  taskEnvelope: TaskEnvelope;
  toolExecutionEndCount: number;
  turnEndCount: number;
  executorStopRequested: boolean;
  controlSignal?: ControlSignal;
  abortContext?: RuntimeAbortContext;
  taskTimer?: NodeJS.Timeout;
  lastObserverProjection?: ObserverProjection;
  executorSession?: SecurityAgentSession;
  dynamicExecutor: boolean;
  attempt: number;
  lastEventId?: string;
  budgetExtensionCount: number;
  budgetStatusSteerKeys: Set<string>;
  budgetDecisionPending?: boolean;
  checkpointGraceTimer?: NodeJS.Timeout;
  runDeadlineAt?: number;
  epochDeadlineAt?: number;
  epochTimeLimitMs?: number;
  supervisionState: TaskSupervisionState;
};

type TaskExecution = {
  taskEnvelope: TaskEnvelope;
  taskResult: TaskResult;
  graphDelta?: GraphDelta;
  controlSignal: ControlSignal;
};

type ExecutorSessionLease = {
  session: SecurityAgentSession;
  dynamicExecutor: boolean;
  resumed: boolean;
  resumeCount: number;
};

export type RetryableProviderFailure = {
  errorKind: LlmErrorKind;
  message: string;
  retryable: boolean;
};

type RunResult = {
  cycles: Array<Awaited<ReturnType<SecurityAgentController["runOnce"]>>>;
  completed: boolean;
  stoppedReason: string;
};

type ActiveRunRecord = {
  invocationId: string;
  startedAt: number;
  maxRunTimeMs: number;
  deadlineAt: number;
  startSeq: number;
  outcome?: RunResult | { completed: false; stoppedReason: string; failed: true };
};

type PiSessionStatsSnapshot = {
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: unknown;
};

export class SecurityAgentController {
  readonly cwd: string;
  readonly runtimeDir: string;
  readonly graphStore: SQLiteGraphStore;
  readonly executionLog: ExecutionLog;
  readonly artifactStore: ArtifactStore;
  readonly runtimeStore: RuntimeStore;
  readonly llmRuntime: LlmRuntime;
  readonly runId = randomUUID();
  private readonly environment?: NodeJS.ProcessEnv;
  private executorSandbox?: ExecutorSandbox;
  private agents?: SecurityAgentRuntime;
  private supervisorInFlight = new Map<string, Promise<ControlSignal>>();
  private activeSupervisorSessions = new Set<SecurityAgentSession>();
  private activePlannerSessions = new Set<SecurityAgentSession>();
  private pendingSupervisorRequests = new Map<string, {
    request: SupervisorCheckRequest;
    resolve: (signal: ControlSignal) => void;
    reject: (error: unknown) => void;
  }>();
  private activeProjectionJobCount = 0;
  private projectionQueueClosed = false;
  private projectionQueueDrainingOnClose = false;
  private projectionCancellationRequested = false;
  private graphStoreClosed = false;
  private projectionJobs = new Set<Promise<ObserverProjection>>();
  private activeProjectorSessions = new Set<SecurityAgentSession>();
  private activeProjectorByTask = new Map<string, SecurityAgentSession>();
  private pendingProjectionRequests = new Map<string, PendingProjectionRequest>();
  private projectionSequence = 0;
  private projectionRetryCountByTask = new Map<string, number>();
  private projectionCatchupTimers = new Map<string, NodeJS.Timeout>();
  private projectionOrphanRefsByTask = new Map<string, string[]>();
  private activeEpochs = new Map<string, ActiveTaskState>();
  private activeEpochIdByTask = new Map<string, string>();
  private taskSupervisionStates = new Map<string, TaskSupervisionState>();
  private stopRequestedReason?: string;
  private isolatedSessionsEnabled = false;
  private structuredInvocationsEnabled = false;
  private activeRun?: ActiveRunRecord;
  private currentUserGoal?: string;

  constructor(input: { cwd: string; runtimeDir?: string; environment?: NodeJS.ProcessEnv }) {
    this.cwd = input.cwd;
    this.runtimeDir = input.runtimeDir ?? join(input.cwd, ".agent-runtime");
    this.environment = input.environment;
    this.graphStore = new SQLiteGraphStore(
      join(this.runtimeDir, "state.sqlite"),
      join(this.runtimeDir, "graph-deltas.jsonl")
    );
    const databasePath = join(this.runtimeDir, "state.sqlite");
    this.executionLog = new ExecutionLog(join(this.runtimeDir, "execution.jsonl"), databasePath);
    this.artifactStore = new ArtifactStore(join(this.runtimeDir, "artifacts"), databasePath);
    this.runtimeStore = new RuntimeStore(databasePath);
    this.llmRuntime = createLlmRuntime();
  }

  async initialize(): Promise<void> {
    await mkdir(this.runtimeDir, { recursive: true });
    this.executorSandbox = await createExecutorSandbox({
      runtimeDir: this.runtimeDir,
      runId: this.runId,
      environment: this.environment,
      additionalReadRoots: projectSkillsDirs(this.cwd)
    });
    await this.executionLog.append({
      role: "runtime",
      eventType: "executor_sandbox_ready",
      summary: `${this.executorSandbox.mode} sandbox ready`,
      payload: {
        runId: this.runId,
        mode: this.executorSandbox.mode,
        backendPath: this.executorSandbox.backendPath,
        root: this.executorSandbox.root,
        allowedReadRoots: this.executorSandbox.allowedReadRoots
      }
    });
    this.isolatedSessionsEnabled = true;
    this.structuredInvocationsEnabled = true;
    if (this.runtimeStore.recoveredProjectionClaims > 0) {
      await this.executionLog.append({
        role: "runtime",
        eventType: "projection_recovered",
        summary: `Recovered ${this.runtimeStore.recoveredProjectionClaims} interrupted projection claim(s)`,
        payload: { recoveredProjectionClaims: this.runtimeStore.recoveredProjectionClaims }
      });
    }
    for (const projectionState of this.runtimeStore.listPendingProjectionTasks()) {
      const taskEnvelope = this.graphStore.getTaskEnvelope(projectionState.taskId);
      if (!taskEnvelope) {
        await this.executionLog.append({
          taskId: projectionState.taskId,
          role: "runtime",
          eventType: "projection_job_discarded",
          summary: "Recovered projection has no task envelope",
          payload: { projectionState }
        });
        continue;
      }
      void this.requestProjection({
        reason: "projection_recovered",
        taskEnvelope
      });
    }
  }

  async runOnce(input: { userGoal: string; scopeSummary: string; maxParallelTasks?: number }): Promise<{
    plannerDecision: PlannerDecision;
    taskEnvelope?: TaskEnvelope;
    taskEnvelopes?: TaskEnvelope[];
    taskResult?: TaskResult;
    taskResults?: TaskResult[];
    graphDelta?: GraphDelta;
    controlSignal?: ControlSignal;
  }> {
    await this.ensureRootGraph(input);
    let plannerDecision!: PlannerDecision;
    let taskEnvelopes: TaskEnvelope[] = [];
    let repairFeedback: string | undefined;
    for (let decisionAttempt = 1; decisionAttempt <= PLANNER_DECISION_REPAIR_ATTEMPTS; decisionAttempt += 1) {
      const invocation = await this.invokePlannerCycle({
        userGoal: input.userGoal,
        scopeSummary: input.scopeSummary,
        repairFeedback
      });
      plannerDecision = invocation.plannerDecision;
      await this.executionLog.append({
        role: "runtime",
        eventType: "planner_prompt_completed",
        summary: plannerDecision.decision,
        payload: {
          plannerPromptId: invocation.plannerPromptId,
          decisionAttempt,
          decision: plannerDecision.decision,
          reason: plannerDecision.reason
        }
      });
      const plannerEvent = await this.executionLog.append({
        role: "planner",
        eventType: `planner_${plannerDecision.decision}`,
        summary: plannerDecision.reason,
        payload: { plannerDecision, decisionAttempt }
      });
      try {
        taskEnvelopes = await this.applyPlannerCommands(
          plannerDecision,
          input.scopeSummary,
          plannerEvent.id,
          invocation.versionSnapshot
        );
        break;
      } catch (error) {
        if (!(error instanceof GraphValidationError) || decisionAttempt >= PLANNER_DECISION_REPAIR_ATTEMPTS) {
          throw error;
        }
        repairFeedback = error instanceof PlannerDecisionConflict
          ? `上一版 Planner 决策因任务版本冲突被拒绝：${error.message}。请基于刷新后的任务状态重新规划。`
          : `上一版 Planner 决策未修改任务图，因图语义校验失败被拒绝：${error.message}。请修正命令；若新证据来自当前 Task 的后继 Task，不要反转依赖，应创建同时依赖相关前驱的新后继 Task。`;
        await this.executionLog.append({
          role: "runtime",
          eventType: error instanceof PlannerDecisionConflict
            ? "planner_decision_conflict"
            : "planner_decision_rejected",
          summary: error.message,
          payload: {
            decisionAttempt,
            ...(error instanceof PlannerDecisionConflict ? { conflicts: error.conflicts } : {}),
            repairFeedback
          }
        });
      }
    }
    if (this.isRootGoalStatus("completed") || this.isRootGoalStatus("blocked")) {
      return {
        plannerDecision,
        taskEnvelope: taskEnvelopes[0],
        taskEnvelopes,
        taskResults: []
      };
    }
    const taskExecutions = await this.runReadyTaskGraph({
      maxParallelTasks: input.maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS
    });
    const firstExecution = taskExecutions[0];
    return {
      plannerDecision,
      taskEnvelope: firstExecution?.taskEnvelope ?? taskEnvelopes[0],
      taskEnvelopes,
      taskResult: firstExecution?.taskResult,
      taskResults: taskExecutions.map((execution) => execution.taskResult),
      graphDelta: firstExecution?.graphDelta,
      controlSignal: firstExecution?.controlSignal
    };
  }

  async runUntilDone(input: {
    userGoal: string;
    scopeSummary: string;
    maxPlannerCycles?: number;
    maxParallelTasks?: number;
    maxRunTimeMs?: number;
  }): Promise<RunResult> {
    const maxPlannerCycles = input.maxPlannerCycles ?? 8;
    const maxParallelTasks = normalizeParallelTaskLimit(input.maxParallelTasks);
    const maxRunTimeMs = normalizeRunTimeBudgetMs(input.maxRunTimeMs);
    const cycles: Array<Awaited<ReturnType<SecurityAgentController["runOnce"]>>> = [];
    const invocationId = `run:${randomUUID()}`;
    const startedAt = Date.now();
    const deadlineAt = startedAt + maxRunTimeMs;
    const runStartedEvent = await this.executionLog.append({
      role: "runtime",
      eventType: "run_started",
      summary: input.userGoal,
      payload: {
        invocationId,
        runId: this.runId,
        userGoal: input.userGoal,
        scopeSummary: input.scopeSummary,
        maxPlannerCycles,
        maxParallelTasks,
        maxRunTimeMs,
        deadlineAt: new Date(deadlineAt).toISOString(),
        structuredInvocationsEnabled: this.structuredInvocationsEnabled,
        runtimeDir: this.runtimeDir,
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        llm: this.llmRuntime.metadata,
        sandbox: this.executorSandbox ? {
          mode: this.executorSandbox.mode,
          backendPath: this.executorSandbox.backendPath,
          root: this.executorSandbox.root
        } : undefined,
        projector: {
          toolWindowSize: PROJECTOR_TOOL_WINDOW_SIZE,
          maxObservationsPerJob: PROJECTOR_MAX_OBSERVATIONS_PER_JOB,
          maxActiveJobs: MAX_ACTIVE_PROJECTION_JOBS,
          idleTimeoutMs: PROJECTOR_IDLE_TIMEOUT_MS,
          hardTimeoutMs: PROJECTOR_HARD_TIMEOUT_MS,
          inputTargetBytes: PROJECTOR_INPUT_TARGET_BYTES
        },
        supervisor: {
          turnWindowSize: SUPERVISOR_TURN_WINDOW_SIZE,
          idleTimeoutMs: SUPERVISOR_IDLE_TIMEOUT_MS,
          hardTimeoutMs: SUPERVISOR_HARD_TIMEOUT_MS
        },
        planner: {
          idleTimeoutMs: PLANNER_IDLE_TIMEOUT_MS,
          hardTimeoutMs: PLANNER_HARD_TIMEOUT_MS,
          freshSessionAttempts: PLANNER_FRESH_SESSION_ATTEMPTS
        },
        defaultTaskBudget: DEFAULT_TASK_BUDGET,
        minTaskBudget: MIN_TASK_BUDGET,
        maxTaskBudget: MAX_TASK_BUDGET
      }
    });
    this.activeRun = {
      invocationId,
      startedAt,
      maxRunTimeMs,
      deadlineAt,
      startSeq: runStartedEvent.seq ?? 0
    };
    const decideRun = async (result: RunResult): Promise<RunResult> => {
      if (this.activeRun?.invocationId === invocationId) {
        this.activeRun.outcome = result;
      }
      await this.executionLog.append({
        role: "runtime",
        eventType: "run_result_decided",
        summary: result.stoppedReason,
        payload: {
          invocationId,
          completed: result.completed,
          stoppedReason: result.stoppedReason,
          plannerCycleCount: result.cycles.length,
          durationMs: Date.now() - startedAt
        }
      });
      return result;
    };
    try {
      let cycleIndex = 0;
      let deferredPlannerFailures = 0;
      while (cycleIndex < maxPlannerCycles) {
        if (this.stopRequestedReason) {
          return await decideRun({ cycles, completed: false, stoppedReason: this.stopRequestedReason });
        }
        if (Date.now() >= deadlineAt) {
          return await decideRun({
            cycles,
            completed: false,
            stoppedReason: `Reached global run time budget: ${maxRunTimeMs}ms`
          });
        }
        let cycleResult: Awaited<ReturnType<SecurityAgentController["runOnce"]>>;
        try {
          cycleResult = await this.runOnce({ ...input, maxParallelTasks });
        } catch (error) {
          if (this.stopRequestedReason) {
            return await decideRun({ cycles, completed: false, stoppedReason: this.stopRequestedReason });
          }
          if (Date.now() >= deadlineAt) {
            return await decideRun({
              cycles,
              completed: false,
              stoppedReason: `Reached global run time budget: ${maxRunTimeMs}ms`
            });
          }
          if (!isRetryablePlannerInvocationError(error)) {
            throw error;
          }
          deferredPlannerFailures += 1;
          if (deferredPlannerFailures >= PLANNER_MAX_DEFERRED_FAILURES) {
            return await decideRun({
              cycles,
              completed: false,
              stoppedReason: `Planner unavailable after ${deferredPlannerFailures} consecutive deferred failures: ${errorMessageFromUnknown(error) ?? "unknown error"}`
            });
          }
          const backoffMs = Math.min(
            PLANNER_DEFER_BACKOFF_MAX_MS,
            PLANNER_FRESH_SESSION_BACKOFF_MS * 2 ** Math.min(deferredPlannerFailures - 1, 5)
          );
          await this.executionLog.append({
            role: "runtime",
            eventType: "planner_cycle_deferred",
            summary: errorMessageFromUnknown(error) ?? "Planner temporarily unavailable",
            payload: {
              invocationId,
              cycleIndex,
              deferredPlannerFailures,
              backoffMs,
              plannerCycleCount: cycles.length
            }
          });
          await sleep(backoffMs);
          continue;
        }
        deferredPlannerFailures = 0;
        cycles.push(cycleResult);
        cycleIndex += 1;
        if (this.stopRequestedReason) {
          return await decideRun({ cycles, completed: false, stoppedReason: this.stopRequestedReason });
        }
        if (this.isRootGoalStatus("completed")) {
          return await decideRun({ cycles, completed: true, stoppedReason: cycleResult.plannerDecision.reason });
        }
        if (this.isRootGoalStatus("blocked")) {
          return await decideRun({ cycles, completed: false, stoppedReason: cycleResult.plannerDecision.reason });
        }
      }
      return await decideRun({
        cycles,
        completed: false,
        stoppedReason: `Reached max planner cycles: ${maxPlannerCycles}`
      });
    } catch (error) {
      if (this.stopRequestedReason) {
        return await decideRun({ cycles, completed: false, stoppedReason: this.stopRequestedReason });
      }
      const stoppedReason = error instanceof Error ? error.message : String(error);
      if (this.activeRun?.invocationId === invocationId) {
        this.activeRun.outcome = { completed: false, stoppedReason, failed: true };
      }
      await this.executionLog.append({
        role: "runtime",
        eventType: "run_failed",
        summary: stoppedReason,
        payload: { invocationId, durationMs: Date.now() - startedAt, error: stoppedReason }
      });
      throw error;
    }
  }

  async requestStop(reason: string): Promise<void> {
    if (this.stopRequestedReason) {
      return;
    }
    this.stopRequestedReason = reason;
    this.projectionQueueClosed = true;
    this.clearProjectionCatchupTimers();
    await this.executionLog.append({
      role: "runtime",
      eventType: "run_interrupted",
      summary: reason,
      payload: {
        invocationId: this.activeRun?.invocationId,
        activeEpochIds: [...this.activeEpochs.keys()],
        activePlannerCount: this.activePlannerSessions.size,
        activeSupervisorCount: this.activeSupervisorSessions.size,
        activeProjectorCount: this.activeProjectorSessions.size
      }
    });
    for (const state of this.activeEpochs.values()) {
      if (state.lifecycleState !== "running") {
        continue;
      }
      state.executorStopRequested = true;
      state.abortContext = { kind: "controller_abort", reason };
      this.terminateExecutorSession(state);
    }
    for (const session of this.activePlannerSessions) {
      void session.abort();
    }
    for (const session of this.activeSupervisorSessions) {
      void session.abort();
    }
    for (const session of this.activeProjectorSessions) {
      void session.abort();
    }
  }

  private async finalizeRunMetrics(): Promise<void> {
    const activeRun = this.activeRun;
    if (!activeRun) {
      return;
    }
    const eventMetrics = this.executionLog.metrics(activeRun.startSeq);
    await this.executionLog.append({
      role: "runtime",
      eventType: "run_completed",
      summary: activeRun.outcome?.stoppedReason ?? "Controller closed without a run outcome",
      payload: {
        invocationId: activeRun.invocationId,
        runId: this.runId,
        completed: activeRun.outcome?.completed ?? false,
        stoppedReason: activeRun.outcome?.stoppedReason ?? "Controller closed without a run outcome",
        durationMs: Date.now() - activeRun.startedAt,
        costCurrency: this.llmRuntime.metadata.costCurrency,
        eventMetrics,
        runtimeMetrics: this.runtimeStore.stats(),
        graphMetrics: this.graphStore.stats(),
        artifactMetrics: this.artifactStore.stats()
      }
    });
    this.activeRun = undefined;
  }

  private async appendInvocationMetrics(input: {
    session: SecurityAgentSession;
    before?: PiSessionStatsSnapshot;
    invocationId: string;
    invocationKind: "planner" | "executor" | "supervisor" | "projector";
    agentRole: "planner" | "executor" | "observer";
    status: string;
    startedAt: number;
    taskId?: string;
    epochId?: string;
    inputBytes?: number;
    details?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const after = readPiSessionStats(input.session);
      if (!after) {
        return;
      }
      const stats = diffPiSessionStats(input.before, after);
      await this.executionLog.append({
        epochId: input.epochId,
        taskId: input.taskId,
        role: "runtime",
        eventType: "invocation_metrics",
        summary: `${input.invocationKind}:${input.status} tokens=${stats.usage.totalTokens} cost=${stats.usage.cost.total.toFixed(6)} ${this.llmRuntime.metadata.costCurrency}`,
        payload: {
          invocationId: input.invocationId,
          invocationKind: input.invocationKind,
          agentRole: input.agentRole,
          status: input.status,
          durationMs: Date.now() - input.startedAt,
          inputBytes: input.inputBytes,
          model: this.llmRuntime.metadata,
          sessionId: after.sessionId,
          stats,
          contextUsage: after.contextUsage,
          ...input.details
        }
      });
    } catch (error) {
      try {
        await this.executionLog.append({
          epochId: input.epochId,
          taskId: input.taskId,
          role: "runtime",
          eventType: "metrics_collection_failed",
          summary: error instanceof Error ? error.message : String(error),
          payload: {
            invocationId: input.invocationId,
            invocationKind: input.invocationKind,
            status: input.status
          }
        });
      } catch {
      }
    }
  }

  async close(input: {
    drainProjectionJobs?: boolean;
    projectionDrainTimeoutMs?: number;
    projectionCancelGraceMs?: number;
  } = {}): Promise<void> {
    if (this.graphStoreClosed) {
      return;
    }
    this.projectionQueueClosed = true;
    this.clearProjectionCatchupTimers();
    for (const state of [...this.activeEpochs.values()]) {
      if (state.lifecycleState === "closed") {
        continue;
      }
      state.lifecycleState = "closing";
      state.abortContext = { kind: "controller_abort", reason: "Controller shutdown" };
      this.terminateExecutorSession(state);
      this.finishTaskExecution(state.taskEnvelope.taskId, "shutdown");
    }
    for (const pending of [...this.pendingSupervisorRequests.values()]) {
      void this.discardSupervisorCheck(
        pending.request,
        "controller is closing",
        pending.request.sourceEventIds ?? []
      ).then(pending.resolve, pending.reject);
    }
    this.pendingSupervisorRequests.clear();
    for (const session of [...this.activeSupervisorSessions]) {
      void session.abort();
    }
    for (const session of [...this.activePlannerSessions]) {
      void session.abort();
    }
    if (this.supervisorInFlight.size > 0) {
      await raceWithTimeout(
        Promise.allSettled([...this.supervisorInFlight.values()]).then(() => "drained" as const),
        2_000
      );
    }
    if (input.drainProjectionJobs !== false) {
      this.projectionQueueDrainingOnClose = true;
      this.drainProjectionQueue();
      await this.drainProjectionJobs(
        input.projectionDrainTimeoutMs ?? PROJECTION_DRAIN_TIMEOUT_MS,
        input.projectionCancelGraceMs ?? PROJECTION_CANCEL_GRACE_MS
      );
      this.projectionQueueDrainingOnClose = false;
    } else {
      this.cancelPendingProjectionRequests("controller is closing; pending projection request discarded");
      await this.cancelAndJoinProjectionJobs({
        summary: `Controller close cancelled ${this.projectionJobs.size} projection job(s) without drain`,
        payload: {
          pendingProjectionJobs: this.pendingProjectionRequests.size,
          activeProjectionJobCount: this.activeProjectionJobCount
        },
        graceMs: 0
      });
    }
    await this.finalizeRunMetrics();
    await this.executionLog.drain();
    this.graphStoreClosed = true;
    this.graphStore.close();
    this.runtimeStore.close();
    this.artifactStore.close();
    this.executionLog.close();
  }

  private async drainProjectionJobs(timeoutMs: number, cancelGraceMs: number): Promise<void> {
    const deadlineAt = Date.now() + timeoutMs;
    while (this.projectionJobs.size > 0 || this.pendingProjectionRequests.size > 0) {
      this.drainProjectionQueue();
      const activeJobs = [...this.projectionJobs];
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0 || activeJobs.length === 0) {
        break;
      }
      const drainResult = await raceWithTimeout(
        Promise.allSettled(activeJobs).then(() => "drained" as const),
        remainingMs
      );
      if (drainResult === "timeout") {
        break;
      }
    }
    if (this.projectionJobs.size === 0 && this.pendingProjectionRequests.size === 0) {
      return;
    }
    await this.cancelAndJoinProjectionJobs({
      summary: `Controller close cancelled ${this.projectionJobs.size} active and ${this.pendingProjectionRequests.size} pending projection job(s) after drain timeout`,
      payload: {
        pendingProjectionJobs: this.pendingProjectionRequests.size,
        activeProjectionJobCount: this.activeProjectionJobCount,
        timeoutMs
      },
      graceMs: cancelGraceMs
    });
  }

  private async cancelAndJoinProjectionJobs(input: {
    summary: string;
    payload: Record<string, unknown>;
    graceMs: number;
  }): Promise<void> {
    this.cancelProjectionJobs();
    await this.executionLog.append({
      role: "runtime",
      eventType: "projection_jobs_cancelled",
      summary: input.summary,
      payload: input.payload
    });
    if (this.projectionJobs.size > 0 && input.graceMs > 0) {
      await raceWithTimeout(
        Promise.allSettled([...this.projectionJobs]).then(() => "drained" as const),
        input.graceMs
      );
    }
    if (this.projectionJobs.size > 0) {
      await this.executionLog.append({
        role: "runtime",
        eventType: "projection_shutdown_waiting",
        summary: `Waiting for ${this.projectionJobs.size} cancelled projection job(s) to settle before closing stores`,
        payload: { pendingProjectionJobs: this.projectionJobs.size }
      });
      await Promise.allSettled([...this.projectionJobs]);
    }
  }

  private cancelProjectionJobs(): void {
    this.projectionCancellationRequested = true;
    this.cancelPendingProjectionRequests("controller shutdown cancelled pending projection request");
    for (const taskId of this.activeProjectorByTask.keys()) {
      this.runtimeStore.invalidateProjection(taskId);
    }
    for (const projectorSession of [...this.activeProjectorSessions]) {
      void projectorSession.abort();
    }
  }

  private cancelPendingProjectionRequests(reason: string): void {
    for (const pendingRequest of [...this.pendingProjectionRequests.values()]) {
      void this.resolveSupersededProjectionRequest(pendingRequest, reason);
    }
    this.pendingProjectionRequests.clear();
  }

  private clearProjectionCatchupTimers(): void {
    for (const timer of this.projectionCatchupTimers.values()) {
      clearTimeout(timer);
    }
    this.projectionCatchupTimers.clear();
    this.projectionOrphanRefsByTask.clear();
  }

  private requireAgents(): SecurityAgentRuntime {
    if (!this.agents) {
      throw new Error("Controller is not initialized");
    }
    return this.agents;
  }

  private isRootGoalStatus(status: string): boolean {
    return this.graphStore
      .query("task", ["goal:root"], 1)
      .nodes
      .some((node) => node.id === "goal:root" && node.properties.status === status);
  }

  private async buildPlannerDecisionView(): Promise<PlannerDecisionView> {
    const view = this.graphStore.plannerDecisionView();
    const runtimeTail: NonNullable<PlannerDecisionView["runtimeTail"]> = [];
    for (const task of view.taskLedger) {
      if (runtimeTail.length >= 4) {
        break;
      }
      const projectionState = this.runtimeStore.getProjectionState(task.taskId);
      if (projectionState.desiredSeq <= projectionState.committedSeq) {
        continue;
      }
      const events = await this.executionLog.range({
        taskId: task.taskId,
        afterSeq: projectionState.committedSeq,
        toSeq: projectionState.desiredSeq,
        roles: ["executor", "runtime"]
      });
      const observations = buildProjectionObservations(events);
      runtimeTail.push({
        taskId: task.taskId,
        committedSeq: projectionState.committedSeq,
        desiredSeq: projectionState.desiredSeq,
        digest: observationDigest(observations, PLANNER_RUNTIME_TAIL_MAX_CHARS)
      });
    }
    return { ...view, runtimeTail };
  }

  private async ensureRootGraph(input: { userGoal: string; scopeSummary: string }): Promise<void> {
    this.currentUserGoal = input.userGoal;
    const goalId = "goal:root";
    const scopeId = "scope:root";
    const existingGoal = this.graphStore.query("task", [goalId], 1).nodes.find((node) => node.id === goalId);
    const existingScope = this.graphStore.query("task", [scopeId], 1).nodes.find((node) => node.id === scopeId);
    this.graphStore.upsertDelta({
      sourceEventIds: [],
      nodes: [
        {
          id: goalId,
          graphKind: "task",
          type: "Goal",
          label: input.userGoal,
          properties: { ...(existingGoal?.properties ?? {}), status: existingGoal?.properties.status ?? "open" }
        },
        {
          id: scopeId,
          graphKind: "task",
          type: "Scope",
          label: "Authorized scope",
          properties: { ...(existingScope?.properties ?? {}), summary: input.scopeSummary }
        }
      ],
      edges: [
        { from: goalId, to: scopeId, type: "within_scope" }
      ]
    });
  }

  private taskEnvelopeFromSpec(taskSpec: PlannerTaskSpec, scopeSummary: string): TaskEnvelope {
    const taskId = taskSpec.id;
    const budget = normalizeTaskBudget(taskSpec.budget);
    const constraints = dedupeStrings([
      `授权范围原文：${scopeSummary}`,
      ...taskSpec.constraints
    ]);
    const dependsOnTaskRefs = dedupeStrings(taskSpec.dependsOnTaskRefs ?? []);
    const parentTaskId = taskSpec.parentTaskId ?? "goal:root";
    return {
      taskId,
      goal: taskSpec.goal,
      targetRefs: taskSpec.targetRefs,
      scopeRef: taskSpec.scopeRef,
      constraints,
      successCriteria: taskSpec.successCriteria,
      dependsOnTaskRefs,
      parentTaskId,
      parallelGroup: taskSpec.parallelGroup,
      budget
    };
  }

  private async applyPlannerCommands(
    plannerDecision: PlannerDecision,
    scopeSummary: string,
    plannerEventId: string,
    versionSnapshot: Record<string, number>
  ): Promise<TaskEnvelope[]> {
    const createdTaskEnvelopes: TaskEnvelope[] = [];
    const commands = plannerDecision.commands ?? [];
    const taskCommands: Array<{ command: PlannerTaskCommand; commandIndex: number }> = [];
    const nodeStatusCommands: Array<{ command: PlannerNodeStatusCommand; commandIndex: number }> = [];
    let rejectedCommand: unknown;
    try {
      const taskCreateInputs: Array<{
        command: PlannerCreateTasksCommand;
        taskEnvelope: TaskEnvelope;
        priority: number;
      }> = [];
      commands.forEach((command, commandIndex) => {
        if (command.kind === "create_tasks") {
          const taskEnvelopes = command.tasks.map((taskSpec) => this.taskEnvelopeFromSpec(taskSpec, scopeSummary));
          taskEnvelopes.forEach((taskEnvelope, taskIndex) => {
            taskCreateInputs.push({
              command,
              taskEnvelope,
              priority: command.tasks[taskIndex]?.priority ?? 1
            });
          });
          return;
        }
        if (command.kind === "set_node_status") {
          nodeStatusCommands.push({ command, commandIndex });
          return;
        }
        taskCommands.push({ command, commandIndex });
      });
      rejectedCommand = commands;
      const applied = this.graphStore.applyPlannerDecision({
        createTasks: taskCreateInputs.map(({ taskEnvelope, priority }) => ({
          parentTaskId: taskEnvelope.parentTaskId,
          taskId: taskEnvelope.taskId,
          goal: taskEnvelope.goal,
          targetRefs: taskEnvelope.targetRefs,
          scopeRef: taskEnvelope.scopeRef,
          constraints: taskEnvelope.constraints,
          successCriteria: taskEnvelope.successCriteria,
          dependsOnTaskRefs: taskEnvelope.dependsOnTaskRefs,
          parallelGroup: taskEnvelope.parallelGroup,
          budget: taskEnvelope.budget,
          priority
        })),
        taskCommands: taskCommands.map(({ command, commandIndex }): PlannerTaskBatchCommand => {
          const commandReason = command.reason ?? plannerDecision.reason;
          if (command.kind === "patch_task") {
            return {
              commandIndex,
              kind: command.kind,
              taskId: command.taskId,
              patch: {
                ...command.patch,
                ...(command.patch.budget ? { budget: normalizeTaskBudget(command.patch.budget) } : {})
              },
              expectedVersion: versionSnapshot[command.taskId],
              sourceEventIds: [plannerEventId],
              reason: commandReason
            };
          }
          if (command.kind === "replace_dependencies") {
            return {
              commandIndex,
              kind: command.kind,
              taskId: command.taskId,
              dependencyTaskIds: command.dependencyTaskIds,
              expectedVersion: versionSnapshot[command.taskId],
              sourceEventIds: [plannerEventId],
              reason: commandReason
            };
          }
          return {
            commandIndex,
            kind: command.kind,
            taskId: command.taskId,
            status: command.status,
            expectedVersion: versionSnapshot[command.taskId],
            sourceEventIds: [plannerEventId],
            reason: commandReason
          };
        }),
        nodeStatusCommands: nodeStatusCommands.map(({ command, commandIndex }) => ({
          commandIndex,
          nodeId: command.nodeId,
          status: command.status,
          expectedVersion: versionSnapshot[command.nodeId],
          sourceEventIds: [plannerEventId],
          reason: command.reason ?? plannerDecision.reason
        })),
        sourceEventIds: [plannerEventId]
      });
      for (const { command, taskEnvelope } of taskCreateInputs) {
        createdTaskEnvelopes.push(taskEnvelope);
        await this.executionLog.append({
          taskId: taskEnvelope.taskId,
          role: "runtime",
          eventType: "task_created",
          summary: taskEnvelope.goal,
          payload: {
            plannerDecision: plannerDecision.decision,
            command,
            basedOnRefs: dedupeStrings([
              ...plannerDecision.basedOnRefs,
              ...(command.basedOnRefs ?? [])
            ]),
            taskEnvelope
          }
        });
      }
      if (taskCommands.length > 0) {
        const appliedCommandByIndex = new Map(applied.taskCommands.map((result) => [result.commandIndex, result]));
        for (const { command, commandIndex } of taskCommands) {
          const commandReason = command.reason ?? plannerDecision.reason;
          const appliedCommand = appliedCommandByIndex.get(commandIndex);
          if (command.kind === "patch_task") {
            await this.executionLog.append({
              taskId: command.taskId,
              role: "runtime",
              eventType: "planner_task_patched",
              summary: commandReason,
              payload: { command, nodeVersion: appliedCommand?.node.properties.version }
            });
            continue;
          }
          if (command.kind === "replace_dependencies") {
            await this.executionLog.append({
              taskId: command.taskId,
              role: "runtime",
              eventType: "planner_dependencies_replaced",
              summary: commandReason,
              payload: { command, nodeVersion: appliedCommand?.node.properties.version }
            });
            continue;
          }
          await this.executionLog.append({
            taskId: command.taskId,
            role: "runtime",
            eventType: "planner_status_applied",
            summary: commandReason,
            payload: { command, status: command.status, nodeVersion: appliedCommand?.node.properties.version }
          });
          if (["completed", "blocked", "failed", "archived"].includes(command.status)) {
            this.runtimeStore.deleteExecutorSession(command.taskId);
          }
        }
      }
      const appliedNodeByIndex = new Map(applied.nodeStatusCommands.map((result) => [result.commandIndex, result.node]));
      for (const { command, commandIndex } of nodeStatusCommands) {
        const commandReason = command.reason ?? plannerDecision.reason;
        const node = appliedNodeByIndex.get(commandIndex);
        await this.executionLog.append({
          role: "runtime",
          eventType: "planner_status_applied",
          summary: commandReason,
          payload: { command, status: node?.properties.status, nodeId: node?.id, nodeVersion: node?.properties.version }
        });
      }
    } catch (error) {
      await this.executionLog.append({
        role: "runtime",
        eventType: "planner_command_rejected",
        summary: error instanceof Error ? error.message : String(error),
        payload: {
          plannerDecision: plannerDecision.decision,
          command: rejectedCommand,
          errorName: error instanceof Error ? error.name : undefined,
          graphValidationError: error instanceof GraphValidationError
        }
      });
      throw error;
    }
    return createdTaskEnvelopes;
  }

  private async runReadyTaskGraph(input: { maxParallelTasks: number }): Promise<TaskExecution[]> {
    const candidates = this.graphStore.listReadyTasks(Math.max(input.maxParallelTasks * 4, 16));
    const readyTasks = admitReadyTasks(candidates, input.maxParallelTasks);
    if (readyTasks.length === 0) {
      return [];
    }
    await this.executionLog.append({
      role: "runtime",
      eventType: "task_wave_started",
      summary: `Running ${readyTasks.length} admitted task(s)`,
      payload: {
        waveIndex: 0,
        candidateTaskIds: candidates.map((task) => task.taskId),
        taskIds: readyTasks.map((task) => task.taskId),
        maxParallelTasks: input.maxParallelTasks
      }
    });
    const waveExecutions = await Promise.all(
      readyTasks.map((taskEnvelope) => this.runExecutorTask(taskEnvelope, {
        useDynamicExecutor: this.isolatedSessionsEnabled || readyTasks.length > 1
      }))
    );
    await this.executionLog.append({
      role: "runtime",
      eventType: "task_wave_completed",
      summary: `Completed ${waveExecutions.length} task(s) in admitted wave`,
      payload: {
        waveIndex: 0,
        results: waveExecutions.map((execution) => ({
          taskId: execution.taskEnvelope.taskId,
          status: execution.taskResult.status,
          controlSignal: execution.controlSignal.decision
        }))
      }
    });
    return waveExecutions;
  }

  private async runExecutorTask(
    taskEnvelope: TaskEnvelope,
    options: { useDynamicExecutor: boolean }
  ): Promise<TaskExecution> {
    for (let providerAttempt = 1; providerAttempt <= EXECUTOR_PROVIDER_RETRY_ATTEMPTS + 1; providerAttempt += 1) {
      const state = this.beginTaskExecution(taskEnvelope);
      const executorSession = await this.createExecutorSessionForTask(taskEnvelope, options.useDynamicExecutor);
      const executorInvocationId = `executor:${state.epochId}:provider:${providerAttempt}`;
      const executorInvocationStartedAt = Date.now();
      const executorStatsBefore = readPiSessionStats(executorSession.session);
      state.executorSession = executorSession.session;
      state.dynamicExecutor = executorSession.dynamicExecutor;
      let executorLogging: ReturnType<typeof attachExecutionLogging> | undefined;
      if (executorSession.dynamicExecutor) {
        executorLogging = attachExecutionLogging({
          session: executorSession.session,
          executionLog: this.executionLog,
          artifactStore: this.artifactStore,
          role: "executor",
          getTaskId: () => taskEnvelope.taskId,
          getEpochId: () => state.epochId,
          getAbortContext: () => state.abortContext,
          onPersistedEvent: (event) => this.handleExecutorEventPersisted(event)
        });
      }
      this.armEpochTimeSlice(taskEnvelope);
      const taskStartedEvent = await this.executionLog.append({
        epochId: state.epochId,
        taskId: taskEnvelope.taskId,
        role: "runtime",
        eventType: "epoch_transition",
        summary: `${state.epochId} running`,
        payload: { state: "running", attempt: state.attempt, taskEnvelope }
      });
      state.lastEventId = taskStartedEvent.id;

      let executorOutput = "";
      let taskResult: TaskResult | undefined;
      let providerFailure: RetryableProviderFailure | undefined;
      let executorError: unknown;
      let executorInputBytes = 0;
      let executorInvocationStatus = "submitted";
      try {
        const taskStatus = this.getTaskStatusSnapshot(taskEnvelope.taskId);
        const rootGoal = this.currentUserGoal ?? this.getRootGoalText() ?? taskEnvelope.goal;
        const runtimeBudgetStatus = formatExecutorBudgetStatus(
          taskEnvelope,
          state,
          executorSession.resumed
            ? `task_resume:${executorSession.resumeCount}`
            : providerAttempt === 1 ? "task_start" : `provider_retry:${providerAttempt}`
        );
        const executorInput = executorSession.resumed
          ? await this.renderResumeExecutorInput({
            rootGoal,
            taskEnvelope,
            taskStatus,
            plannerHint: stringProperty(taskStatus?.plannerReason),
            runtimeBudgetStatus
          })
          : await this.renderInitialExecutorInput({
            rootGoal,
            taskEnvelope,
            taskStatus,
            runtimeBudgetStatus
          });
        executorInputBytes = Buffer.byteLength(executorInput);
        if (this.structuredInvocationsEnabled) {
          taskResult = await invokeStructured(executorSession.session, executorInput, {
            toolName: "task_result_submit",
            validate: (value) => normalizeTaskResult(value as Partial<TaskResult>, taskEnvelope)
          });
        } else {
          executorOutput = await promptAndCollect(executorSession.session, executorInput);
          taskResult = normalizeTaskResult(extractJsonObject<Partial<TaskResult>>(executorOutput), taskEnvelope);
        }
      } catch (error) {
        executorError = error;
        providerFailure = state.executorStopRequested
          ? undefined
          : classifyExecutorProviderFailure(error, error, executorOutput);
        executorInvocationStatus = providerFailure?.retryable ? "provider_error" : "failed";
      } finally {
        await executorLogging?.drain();
        await this.appendInvocationMetrics({
          session: executorSession.session,
          before: executorStatsBefore,
          invocationId: executorInvocationId,
          invocationKind: "executor",
          agentRole: "executor",
          status: executorInvocationStatus,
          startedAt: executorInvocationStartedAt,
          taskId: taskEnvelope.taskId,
          epochId: state.epochId,
          inputBytes: executorInputBytes,
          details: {
            providerAttempt,
            dynamicSession: executorSession.dynamicExecutor,
            resumedSession: executorSession.resumed,
            resumeCount: executorSession.resumeCount,
            budget: taskEnvelope.budget,
            toolExecutionEndCount: state.toolExecutionEndCount,
            turnEndCount: state.turnEndCount
          }
        });
        this.clearEpochTimeSlice(taskEnvelope);
      }

      if (taskResult && state.checkpointGraceTimer) {
        clearTimeout(state.checkpointGraceTimer);
        state.checkpointGraceTimer = undefined;
        await this.executionLog.append({
          epochId: state.epochId,
          taskId: taskEnvelope.taskId,
          role: "runtime",
          eventType: "executor_checkpoint_submitted",
          summary: taskResult.summary,
          payload: {
            controlSignal: state.controlSignal,
            taskResultStatus: taskResult.status
          }
        });
      }

      if (
        !taskResult
        && providerFailure?.retryable
        && state.toolExecutionEndCount === 0
        && providerAttempt <= EXECUTOR_PROVIDER_RETRY_ATTEMPTS
        && !state.executorStopRequested
      ) {
        await this.executionLog.append({
          epochId: state.epochId,
          taskId: taskEnvelope.taskId,
          role: "runtime",
          eventType: "executor_provider_retry_scheduled",
          summary: `${providerFailure.errorKind}: retry ${providerAttempt}/${EXECUTOR_PROVIDER_RETRY_ATTEMPTS}`,
          payload: {
            providerAttempt,
            maxRetryAttempts: EXECUTOR_PROVIDER_RETRY_ATTEMPTS,
            backoffMs: EXECUTOR_PROVIDER_RETRY_BACKOFF_MS,
            providerFailure
          }
        });
        this.finishTaskExecution(taskEnvelope.taskId, "provider_error");
        executorLogging?.();
        if (executorSession.dynamicExecutor) {
          disposeSession(executorSession.session);
        }
        await sleep(EXECUTOR_PROVIDER_RETRY_BACKOFF_MS);
        continue;
      }

      taskResult ??= await this.createSyntheticTaskResult({
        taskEnvelope,
        signal: state.controlSignal,
        reason: providerFailure?.message
          ?? errorMessageFromUnknown(executorError)
          ?? "Executor did not return a valid TaskResult",
        executorOutputPreview: executorOutput.slice(0, 1000)
      });
      if (providerFailure?.retryable) {
        taskResult = {
          ...taskResult,
          retryable: true,
          checkpointReason: providerFailure.message
        };
      }
      taskResult = await this.enrichTaskResultLifecycle(taskResult, taskEnvelope, state);
      const isInfraFailure = taskResult.status === "failed" && taskResult.retryable === true;

      const taskCompletedEvent = await this.executionLog.append({
        epochId: state.epochId,
        taskId: taskEnvelope.taskId,
        role: "executor",
        eventType: `task_${taskResult.status}`,
        summary: taskResult.summary,
        payload: { taskResult },
        artifactRefs: taskResult.artifactRefs
      });
      state.lastEventId = taskCompletedEvent.id;
      const taskStatusDelta = isInfraFailure
        ? (() => {
          this.graphStore.markTaskStatus({
            taskId: taskEnvelope.taskId,
            status: "open",
            sourceEventIds: [taskCompletedEvent.id],
            properties: {
              resultSummary: taskResult.summary,
              checkpointReason: taskResult.checkpointReason,
              retryable: taskResult.retryable,
              attempt: taskResult.attempt,
              resumeCursor: taskResult.resumeCursor,
              lastEventId: taskResult.lastEventId
            }
          });
          return undefined;
        })()
        : this.graphStore.updateTaskResult({
          taskEnvelope,
          taskResult,
          sourceEventIds: [taskCompletedEvent.id]
        });
      if (providerFailure?.retryable && state.toolExecutionEndCount === 0) {
        await this.executionLog.append({
          epochId: state.epochId,
          taskId: taskEnvelope.taskId,
          role: "runtime",
          eventType: "projection_job_skipped",
          summary: `task_end skipped: pure retryable provider error ${providerFailure.errorKind}`,
          payload: { reason: "task_end", providerFailure, sourceEventIds: [taskCompletedEvent.id] }
        });
      } else {
        this.runtimeStore.raiseProjectionDesired(taskEnvelope.taskId, taskCompletedEvent.seq ?? 0, 10);
        void this.enqueueProjectionJob({
          reason: "task_end",
          taskEnvelope,
          taskResult,
          sourceEventIds: [taskCompletedEvent.id]
        });
      }
      const controlSignal = state.controlSignal ?? controlSignalForTaskResult(taskResult, [taskCompletedEvent.id]);
      const terminationReason = taskResult.status === "completed"
        ? "executor_submitted"
        : terminationReasonForTaskResult(taskResult, state);
      executorLogging?.();
      this.finishTaskExecution(taskEnvelope.taskId, terminationReason);
      if (executorSession.dynamicExecutor) {
        disposeSession(executorSession.session);
      }
      return { taskEnvelope, taskResult, graphDelta: taskStatusDelta, controlSignal };
    }
    throw new Error(`Executor retry loop exhausted without result for ${taskEnvelope.taskId}`);
  }

  private async createExecutorSessionForTask(
    taskEnvelope: TaskEnvelope,
    useDynamicExecutor: boolean
  ): Promise<ExecutorSessionLease> {
    if (!this.isolatedSessionsEnabled && !useDynamicExecutor) {
      return { session: this.requireAgents().executor, dynamicExecutor: false, resumed: false, resumeCount: 0 };
    }
    const persisted = this.runtimeStore.getExecutorSession(taskEnvelope.taskId);
    if (persisted) {
      const sessionManager = SessionManager.open(persisted.sessionFile);
      const executor = await createExecutorAgentSession({
        cwd: this.executorSandbox?.root ?? this.cwd,
        sandbox: this.executorSandbox,
        artifactStore: this.artifactStore,
        llmRuntime: this.llmRuntime,
        sessionManager,
        skillsDirs: projectSkillsDirs(this.cwd)
      });
      const lease: ExecutorSessionLease = {
        session: executor.session,
        dynamicExecutor: true,
        resumed: true,
        resumeCount: persisted.resumeCount + 1
      };
      this.runtimeStore.upsertExecutorSession({
        taskId: taskEnvelope.taskId,
        sessionFile: persisted.sessionFile,
        resumeCount: lease.resumeCount
      });
      await this.executionLog.append({
        taskId: taskEnvelope.taskId,
        role: "runtime",
        eventType: "executor_session_resumed",
        summary: `Resumed Executor session for ${taskEnvelope.taskId}`,
        payload: {
          sessionFile: persisted.sessionFile,
          resumeCount: lease.resumeCount
        }
      });
      return lease;
    }
    return this.createNewExecutorSessionForTask(taskEnvelope, useDynamicExecutor);
  }

  private async createNewExecutorSessionForTask(
    taskEnvelope: TaskEnvelope,
    useDynamicExecutor: boolean
  ): Promise<ExecutorSessionLease> {
    if (!this.isolatedSessionsEnabled && !useDynamicExecutor) {
      return { session: this.requireAgents().executor, dynamicExecutor: false, resumed: false, resumeCount: 0 };
    }
    const sessionDir = join(this.runtimeDir, EXECUTOR_SESSION_DIR);
    const sessionManager = SessionManager.create(this.executorSandbox?.root ?? this.cwd, sessionDir);
    const executor = await createExecutorAgentSession({
      cwd: this.executorSandbox?.root ?? this.cwd,
      sandbox: this.executorSandbox,
      artifactStore: this.artifactStore,
      llmRuntime: this.llmRuntime,
      sessionManager,
      skillsDirs: projectSkillsDirs(this.cwd)
    });
    const sessionFile = executor.session.sessionFile;
    if (!sessionFile) {
      throw new Error(`Executor session for ${taskEnvelope.taskId} was not persisted to a file`);
    }
    this.runtimeStore.upsertExecutorSession({
      taskId: taskEnvelope.taskId,
      sessionFile,
      resumeCount: 0
    });
    return { session: executor.session, dynamicExecutor: true, resumed: false, resumeCount: 0 };
  }

  private async renderInitialExecutorInput(input: {
    rootGoal: string;
    taskEnvelope: TaskEnvelope;
    taskStatus?: Record<string, unknown>;
    runtimeBudgetStatus: string;
  }): Promise<string> {
    const executionGraphContext = this.graphStore.projectionClosure({
      taskId: input.taskEnvelope.taskId,
      scopeRef: input.taskEnvelope.scopeRef,
      dependencyTaskIds: input.taskEnvelope.dependsOnTaskRefs,
      targetRefs: input.taskEnvelope.targetRefs,
      nodeLimit: 28,
      edgeLimit: 48
    });
    const operationGraphSlice = compactExecutorGraphClosure(executionGraphContext, "operation", 12);
    return renderExecutorInput({
      rootGoal: input.rootGoal,
      taskEnvelope: input.taskEnvelope,
      operationGraphSlice,
      reasoningGraphSlice: compactExecutorGraphClosure(executionGraphContext, "reasoning", 12),
      sessionRefs: operationGraphSlice.nodes.filter((node) => node.type === "Session" || node.type === "Credential"),
      toolCatalog: ["read", "bash", "grep", "find", "ls", "artifact_read", "artifact_write", "task_result_submit"],
      executionBrief: createExecutionBrief(input.taskEnvelope, (await this.executionLog.window({
        taskId: input.taskEnvelope.taskId,
        limit: 5,
        roles: ["executor", "runtime"]
      })).events, input.taskStatus),
      dependencyOutcomes: await this.createDependencyOutcomeBrief(input.taskEnvelope),
      runtimeBudgetStatus: input.runtimeBudgetStatus
    });
  }

  private async renderResumeExecutorInput(input: {
    rootGoal: string;
    taskEnvelope: TaskEnvelope;
    taskStatus?: Record<string, unknown>;
    plannerHint?: string;
    runtimeBudgetStatus: string;
  }): Promise<string> {
    const executionGraphContext = this.graphStore.projectionClosure({
      taskId: input.taskEnvelope.taskId,
      scopeRef: input.taskEnvelope.scopeRef,
      dependencyTaskIds: input.taskEnvelope.dependsOnTaskRefs,
      targetRefs: input.taskEnvelope.targetRefs,
      nodeLimit: 28,
      edgeLimit: 48
    });
    const operationGraphSlice = compactExecutorGraphClosure(executionGraphContext, "operation", 12);
    return renderExecutorResumeInput({
      rootGoal: input.rootGoal,
      taskEnvelope: input.taskEnvelope,
      plannerHint: input.plannerHint,
      operationGraphSlice,
      reasoningGraphSlice: compactExecutorGraphClosure(executionGraphContext, "reasoning", 12),
      sessionRefs: operationGraphSlice.nodes.filter((node) => node.type === "Session" || node.type === "Credential"),
      executionBrief: createExecutionBrief(input.taskEnvelope, (await this.executionLog.window({
        taskId: input.taskEnvelope.taskId,
        limit: 5,
        roles: ["executor", "runtime"]
      })).events, input.taskStatus),
      dependencyOutcomes: await this.createDependencyOutcomeBrief(input.taskEnvelope),
      runtimeBudgetStatus: input.runtimeBudgetStatus
    });
  }

  private getRootGoalText(): string | undefined {
    return this.graphStore
      .query("task", ["goal:root"], 1)
      .nodes
      .find((node) => node.id === "goal:root")
      ?.label;
  }

  private async invokePlannerCycle(input: {
    userGoal: string;
    scopeSummary: string;
    repairFeedback?: string;
  }): Promise<{ plannerDecision: PlannerDecision; plannerPromptId: string; versionSnapshot: Record<string, number> }> {
    let lastError: unknown;
    let attemptFeedback = input.repairFeedback;
    for (let attempt = 1; attempt <= PLANNER_FRESH_SESSION_ATTEMPTS; attempt += 1) {
      if (this.stopRequestedReason) {
        throw new Error(this.stopRequestedReason);
      }
      const plannerHardTimeoutMs = this.remainingRunTimeLimit(PLANNER_HARD_TIMEOUT_MS);
      if (plannerHardTimeoutMs <= 0) {
        throw new Error(`Reached global run time budget: ${this.activeRun?.maxRunTimeMs ?? 0}ms`);
      }
      const plannerDecisionView = await this.buildPlannerDecisionView();
      const versionSnapshot = this.graphStore.plannerVersionSnapshot();
      const plannerInput = renderPlannerInput({ ...input, repairFeedback: attemptFeedback, plannerDecisionView });
      const plannerInputBytes = Buffer.byteLength(plannerInput);
      const plannerPromptId = `planner:${randomUUID()}`;
      await this.executionLog.append({
        role: "runtime",
        eventType: "planner_prompt_started",
        summary: `Planner prompt started attempt=${attempt}`,
        payload: {
          plannerPromptId,
          attempt,
          maxAttempts: PLANNER_FRESH_SESSION_ATTEMPTS,
          idleTimeoutMs: PLANNER_IDLE_TIMEOUT_MS,
          hardTimeoutMs: plannerHardTimeoutMs
        }
      });
      const plannerHeartbeat = this.startRuntimeHeartbeat({
        eventType: "planner_prompt_heartbeat",
        summary: "Planner prompt still running",
        payload: { plannerPromptId, attempt }
      });
      let plannerSessionResult: { session: SecurityAgentSession; isolated: boolean } | undefined;
      let plannerLogging: ReturnType<typeof attachExecutionLogging> | undefined;
      let plannerStatsBefore: PiSessionStatsSnapshot | undefined;
      let plannerInvocationStatus = "completed";
      let retryDelayMs = 0;
      const plannerInvocationStartedAt = Date.now();
      try {
        plannerSessionResult = await this.createPlannerSessionForCycle(attempt > 1);
        const plannerSession = plannerSessionResult.session;
        this.activePlannerSessions.add(plannerSession);
        plannerStatsBefore = readPiSessionStats(plannerSession);
        plannerLogging = plannerSessionResult.isolated
          ? attachExecutionLogging({
            session: plannerSession,
            executionLog: this.executionLog,
            artifactStore: this.artifactStore,
            role: "planner"
          })
          : undefined;
        const plannerDecision = this.structuredInvocationsEnabled
          ? await invokeStructured(plannerSession, plannerInput, {
            toolName: "planner_submit",
            idleTimeoutMs: PLANNER_IDLE_TIMEOUT_MS,
            hardTimeoutMs: plannerHardTimeoutMs,
            validate: normalizePlannerDecision
          })
          : normalizePlannerDecision(extractJsonObject<unknown>(await withTimeout(
            promptAndCollect(plannerSession, plannerInput),
            plannerHardTimeoutMs,
            () => void plannerSession.abort()
          )));
        return { plannerDecision, plannerPromptId, versionSnapshot };
      } catch (error) {
        lastError = error;
        if (this.stopRequestedReason) {
          plannerInvocationStatus = "aborted";
          await this.executionLog.append({
            role: "runtime",
            eventType: "planner_prompt_aborted",
            summary: this.stopRequestedReason,
            payload: { plannerPromptId, attempt, maxAttempts: PLANNER_FRESH_SESSION_ATTEMPTS }
          });
          throw error;
        }
        const providerFailure = classifyPlannerProviderFailure(error);
        if (error instanceof StructuredInvocationError && error.code === "missing_submit") {
          attemptFeedback = [attemptFeedback, MISSING_SUBMIT_RETRY_FEEDBACK]
            .filter((value) => value && value.trim().length > 0)
            .join("\n");
        }
        plannerInvocationStatus = providerFailure.retryable ? "provider_error" : "failed";
        await this.executionLog.append({
          role: "runtime",
          eventType: "planner_prompt_failed",
          summary: providerFailure.message,
          payload: {
            plannerPromptId,
            attempt,
            maxAttempts: PLANNER_FRESH_SESSION_ATTEMPTS,
            retryable: providerFailure.retryable,
            errorKind: providerFailure.errorKind
          }
        });
        if (Date.now() >= (this.activeRun?.deadlineAt ?? Number.POSITIVE_INFINITY)
          || !providerFailure.retryable
          || attempt >= PLANNER_FRESH_SESSION_ATTEMPTS) {
          throw error;
        }
        await this.executionLog.append({
          role: "runtime",
          eventType: "planner_prompt_retry_scheduled",
          summary: `Retrying Planner after ${providerFailure.errorKind}`,
          payload: {
            plannerPromptId,
            attempt,
            nextAttempt: attempt + 1,
            backoffMs: PLANNER_FRESH_SESSION_BACKOFF_MS,
            errorKind: providerFailure.errorKind
          }
        });
        retryDelayMs = PLANNER_FRESH_SESSION_BACKOFF_MS * attempt;
      } finally {
        clearInterval(plannerHeartbeat);
        if (plannerSessionResult) {
          this.activePlannerSessions.delete(plannerSessionResult.session);
        }
        await plannerLogging?.drain();
        plannerLogging?.();
        if (plannerSessionResult) {
          await this.appendInvocationMetrics({
            session: plannerSessionResult.session,
            before: plannerStatsBefore,
            invocationId: plannerPromptId,
            invocationKind: "planner",
            agentRole: "planner",
            status: plannerInvocationStatus,
            startedAt: plannerInvocationStartedAt,
            inputBytes: plannerInputBytes,
            details: {
              isolatedSession: plannerSessionResult.isolated,
              attempt,
              maxAttempts: PLANNER_FRESH_SESSION_ATTEMPTS,
              idleTimeoutMs: PLANNER_IDLE_TIMEOUT_MS,
              hardTimeoutMs: plannerHardTimeoutMs
            }
          });
          if (plannerSessionResult.isolated) {
            disposeSession(plannerSessionResult.session);
          }
        }
      }
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
        if (this.stopRequestedReason) {
          throw new Error(this.stopRequestedReason);
        }
      }
    }
    throw lastError ?? new Error("Planner retry loop exhausted without result");
  }

  private remainingRunTimeLimit(configuredLimitMs: number): number {
    if (!this.activeRun) {
      return configuredLimitMs;
    }
    return Math.max(0, Math.min(configuredLimitMs, this.activeRun.deadlineAt - Date.now()));
  }

  private async createPlannerSessionForCycle(forceIsolated = false): Promise<{ session: SecurityAgentSession; isolated: boolean }> {
    if (!this.isolatedSessionsEnabled && !forceIsolated) {
      return { session: this.requireAgents().planner, isolated: false };
    }
    const planner = await createPlannerAgentSession({
      cwd: this.cwd,
      graphStore: this.graphStore,
      llmRuntime: this.llmRuntime
    });
    return { session: planner.session, isolated: true };
  }

  private async createObserverSessionForMode(
    mode: ObserverMode,
    taskId: string
  ): Promise<{
    session: SecurityAgentSession;
    dynamicObserver: boolean;
    logging: ReturnType<typeof attachExecutionLogging>;
  }> {
    const observer = await createObserverAgentSession({
      cwd: this.cwd,
      graphStore: this.graphStore,
      executionLog: this.executionLog,
      artifactStore: this.artifactStore,
      llmRuntime: this.llmRuntime,
      mode
    });
    const logging = attachExecutionLogging({
      session: observer.session,
      executionLog: this.executionLog,
      artifactStore: this.artifactStore,
      role: "observer",
      getTaskId: () => taskId
    });
    return { session: observer.session, dynamicObserver: true, logging };
  }

  private beginTaskExecution(taskEnvelope: TaskEnvelope): ActiveTaskState {
    const epochId = `epoch:${randomUUID()}`;
    const attempt = this.nextTaskAttempt(taskEnvelope.taskId);
    const state: ActiveTaskState = {
      epochId,
      lifecycleState: "created",
      taskEnvelope,
      toolExecutionEndCount: 0,
      turnEndCount: 0,
      executorStopRequested: false,
      dynamicExecutor: false,
      attempt,
      budgetExtensionCount: 0,
      budgetStatusSteerKeys: new Set(),
      supervisionState: restoreTaskSupervisionState(
        taskEnvelope,
        this.getTaskStatusSnapshot(taskEnvelope.taskId),
        this.taskSupervisionStates.get(taskEnvelope.taskId)
      )
    };
    this.runtimeStore.createEpoch({
      epochId,
      taskId: taskEnvelope.taskId,
      attempt,
      startSeq: this.executionLog.latestSeq(taskEnvelope.taskId)
    });
    this.runtimeStore.transitionEpoch({ epochId, state: "running" });
    state.lifecycleState = "running";
    this.activeEpochs.set(epochId, state);
    this.activeEpochIdByTask.set(taskEnvelope.taskId, epochId);
    return state;
  }

  private finishTaskExecution(taskId: string, terminationReason: ActiveTaskState["terminationReason"] = "executor_submitted"): void {
    const state = this.getActiveTaskState(taskId);
    if (state) {
      this.taskSupervisionStates.set(taskId, cloneTaskSupervisionState(state.supervisionState));
      state.lifecycleState = "closed";
      state.terminationReason = terminationReason;
      this.runtimeStore.transitionEpoch({
        epochId: state.epochId,
        state: "closed",
        terminationReason,
        endSeq: this.executionLog.latestSeq(taskId)
      });
    }
    if (state?.taskTimer) {
      clearTimeout(state.taskTimer);
    }
    if (state?.checkpointGraceTimer) {
      clearTimeout(state.checkpointGraceTimer);
      state.checkpointGraceTimer = undefined;
    }
    if (state) {
      this.activeEpochs.delete(state.epochId);
    }
    this.activeEpochIdByTask.delete(taskId);
  }

  private getActiveTaskState(taskId: string): ActiveTaskState | undefined {
    const epochId = this.activeEpochIdByTask.get(taskId);
    return epochId ? this.activeEpochs.get(epochId) : undefined;
  }


  private isActiveEpoch(state: ActiveTaskState): boolean {
    return state.lifecycleState === "running"
      && this.activeEpochIdByTask.get(state.taskEnvelope.taskId) === state.epochId
      && this.activeEpochs.get(state.epochId) === state;
  }

  private async loadProjectorArtifactIndex(input: {
    taskEnvelope: TaskEnvelope;
    taskResult?: TaskResult;
    observations: ProjectionObservation[];
  }): Promise<{ text: string; itemCount: number; omittedCount: number }> {
    const directRefs = dedupeStrings(input.observations.flatMap((observation) => observation.artifactRefs));
    const includeTaskResultArtifacts = input.observations.some((observation) => observation.kind === "task_outcome");
    const taskResultRefs = includeTaskResultArtifacts ? input.taskResult?.artifactRefs ?? [] : [];
    const candidateRefs = dedupeStrings([...directRefs, ...taskResultRefs]);
    const directRefSet = new Set(directRefs);
    const relevantSnippets = await this.artifactStore.searchWithin({
      artifactRefs: candidateRefs,
      query: [
        ...input.observations.flatMap((observation) => observation.anchors),
        ...input.observations
          .filter((observation) => observation.kind === "task_outcome")
          .map((observation) => observation.outcomeDigest),
        ...input.observations.flatMap((observation) => [
          observation.interpretation ?? "",
          observation.inputDigest ?? "",
          observation.outcomeDigest
        ]),
        input.taskEnvelope.goal,
        ...input.taskEnvelope.successCriteria
      ].join(" "),
      limit: 6
    });
    const selected: string[] = [];
    for (const artifactRef of candidateRefs) {
      if (selected.length >= PROJECTOR_ARTIFACT_MANIFEST_LIMIT) {
        break;
      }
      const record = artifactRef.startsWith("artifact:") ? await this.artifactStore.get(artifactRef) : undefined;
      if (record && isRuntimeContextArtifact(record.preview)) {
        continue;
      }
      const snippet = relevantSnippets.find((candidate) => candidate.artifactRef === artifactRef);
      const needsFallbackPreview = directRefSet.has(artifactRef) && !snippet;
      const tail = needsFallbackPreview && record && record.byteLength > 240
        ? await this.artifactStore.read(artifactRef, {
          offset: Math.max(0, record.byteLength - 240),
          length: 240
        })
        : "";
      selected.push([
        `${artifactRef} kind=${record?.kind ?? "unknown"} bytes=${record?.byteLength ?? "unknown"}`,
        needsFallbackPreview && record?.preview ? `  head: ${truncateText(record.preview.replace(/\s+/g, " "), 240)}` : undefined,
        tail ? `  tail: ${truncateText(tail.replace(/\s+/g, " "), 240)}` : undefined,
        snippet ? `  match: ${truncateText(snippet.snippet.replace(/\s+/g, " "), 480)}` : undefined
      ].filter((line): line is string => Boolean(line)).join("\n"));
    }
    return {
      text: selected.length > 0 ? selected.join("\n") : "无相关 artifact。",
      itemCount: selected.length,
      omittedCount: Math.max(0, candidateRefs.length - selected.length)
    };
  }

  private async handleExecutorEventPersisted(event: ExecutionEvent): Promise<void> {
    if (!event.taskId) {
      return;
    }
    let state = this.getActiveTaskState(event.taskId);
    if (event.epochId && state && event.epochId !== state.epochId) {
      await this.executionLog.append({
        epochId: event.epochId,
        taskId: event.taskId,
        role: "runtime",
        eventType: "stale_callback_discarded",
        summary: `Ignored event from stale epoch ${event.epochId}`,
        payload: { sourceEventId: event.id, activeEpochId: state.epochId }
      });
      return;
    }
    const taskEnvelope = state?.taskEnvelope;
    if (!state || !taskEnvelope) {
      return;
    }
    state.lastEventId = event.id;
    updateTaskSupervisionState(state.supervisionState, event);
    if (event.eventType === "turn_usage" || event.eventType === "turn_end") {
      state.turnEndCount += 1;
      if (state.executorStopRequested) {
        return;
      }
      this.publishExecutorBudgetStatusUpdate({
        taskEnvelope,
        state,
        sourceEventId: event.id,
        reason: "turn_usage"
      });
      if (state.turnEndCount >= (taskEnvelope.budget?.maxTurns ?? DEFAULT_TASK_BUDGET.maxTurns)) {
        this.requestSupervisorBudgetDecision(taskEnvelope, event, state);
      } else if (state.turnEndCount % SUPERVISOR_TURN_WINDOW_SIZE === 0) {
        void this.enqueueSupervisorCheck({
          reason: `${TURN_WINDOW_REASON_PREFIX}${state.turnEndCount}`,
          taskEnvelope,
          sourceEventIds: [event.id]
        }).then((controlSignal) => this.applyControlSignal(taskEnvelope, controlSignal, state));
      }
    }
    if (event.eventType === "tool_finished" || event.eventType === "tool_execution_end") {
      state.toolExecutionEndCount += 1;
      if (state.toolExecutionEndCount % PROJECTOR_TOOL_WINDOW_SIZE === 0) {
        void this.requestProjection({
          reason: `${PROJECT_WINDOW_REASON_PREFIX}${state.toolExecutionEndCount}`,
          taskEnvelope,
          sourceEventIds: [event.id]
        });
      }
    }
  }

  private enqueueSupervisorCheck(input: SupervisorCheckRequest): Promise<ControlSignal> {
    const queueItem: SupervisorCheckRequest = {
      ...input,
      queueId: `supervisor:${randomUUID()}`,
      queuedAt: Date.now()
    };
    const state = this.getActiveTaskState(input.taskEnvelope.taskId);
    if (!state) {
      return this.discardSupervisorCheck(queueItem, "task is no longer active", input.sourceEventIds ?? []);
    }
    const epochId = state.epochId;
    if (this.supervisorInFlight.has(epochId)) {
      const existing = this.pendingSupervisorRequests.get(epochId);
      if (existing) {
        void this.discardSupervisorCheck(
          existing.request,
          `superseded by newer supervisor window ${queueItem.reason}`,
          existing.request.sourceEventIds ?? []
        ).then(existing.resolve, existing.reject);
      }
      return new Promise<ControlSignal>((resolve, reject) => {
        this.pendingSupervisorRequests.set(epochId, { request: queueItem, resolve, reject });
      });
    }
    return this.startSupervisorCheck(epochId, queueItem);
  }

  private startSupervisorCheck(epochId: string, input: SupervisorCheckRequest): Promise<ControlSignal> {
    const promise = this.runSupervisorCheck(input);
    this.supervisorInFlight.set(epochId, promise);
    void promise.then(() => {
      this.finishSupervisorCheck(epochId, promise);
    }, () => {
      this.finishSupervisorCheck(epochId, promise);
    });
    return promise;
  }

  private finishSupervisorCheck(epochId: string, promise: Promise<ControlSignal>): void {
    if (this.supervisorInFlight.get(epochId) === promise) {
      this.supervisorInFlight.delete(epochId);
    }
    const pending = this.pendingSupervisorRequests.get(epochId);
    if (!pending) {
      return;
    }
    this.pendingSupervisorRequests.delete(epochId);
    this.startSupervisorCheck(epochId, pending.request).then(pending.resolve, pending.reject);
  }

  private async runSupervisorCheck(input: SupervisorCheckRequest): Promise<ControlSignal> {
    const expectedSourceEventIds = input.sourceEventIds ?? [];
    const state = this.getActiveTaskState(input.taskEnvelope.taskId);
    const discardReason = this.supervisorCheckDiscardReason(input, state);
    if (discardReason) {
      return this.discardSupervisorCheck(input, discardReason, expectedSourceEventIds);
    }
    await this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "runtime",
      eventType: "supervisor_check_started",
      summary: `${input.reason} started`,
      payload: {
        queueId: input.queueId,
        reason: input.reason,
        queuedForMs: input.queuedAt ? Date.now() - input.queuedAt : undefined,
        sourceEventIds: expectedSourceEventIds
      }
    });
    let supervisorOutput = "";
    let supervisorSession: SecurityAgentSession | undefined;
    let supervisorLogging: ReturnType<typeof attachExecutionLogging> | undefined;
    let supervisorStatsBefore: PiSessionStatsSnapshot | undefined;
    let supervisorInputBytes = 0;
    let supervisorInvocationStatus = "failed";
    const supervisorInvocationStartedAt = Date.now();
    try {
      const logWindow = await this.executionLog.window({
        taskId: input.taskEnvelope.taskId,
        limit: 96,
        roles: ["executor", "runtime"],
        eventTypes: [
          "assistant_intent",
          "turn_usage",
          "tool_started",
          "tool_finished",
          "provider_error",
          "message_end",
          "turn_end",
          "tool_execution_start",
          "tool_execution_end",
          "task_completed",
          "task_partial",
          "task_blocked",
          "task_failed",
          "executor_stop_requested"
        ]
      });
      const supervisorTrace = summarizeSupervisorTrace(
        selectRecentExecutorTurnEvents(logWindow.events, SUPERVISOR_TURN_WINDOW_SIZE)
      );
      const observerSession = await this.createObserverSessionForMode("supervise", input.taskEnvelope.taskId);
      const activeSupervisorSession = observerSession.session;
      supervisorSession = activeSupervisorSession;
      supervisorStatsBefore = readPiSessionStats(activeSupervisorSession);
      supervisorLogging = observerSession.logging;
      this.activeSupervisorSessions.add(activeSupervisorSession);
      const supervisorInput = renderSupervisorInput({
          taskEnvelope: input.taskEnvelope,
          actionTraceText: supervisorTrace.actionTraceText,
          loopSignalsText: supervisorTrace.loopSignalsText,
          supervisionState: supervisionStateForPrompt(
            state?.supervisionState ?? createInitialTaskSupervisionState(input.taskEnvelope)
          ),
          budgetState: {
            ...budgetStatusSnapshot(input.taskEnvelope, state),
            toolExecutionEndCount: state?.toolExecutionEndCount ?? 0,
            turnEndCount: state?.turnEndCount ?? 0,
            budgetExtensionCount: state?.budgetExtensionCount ?? 0,
            maxBudgetExtensions: MAX_BUDGET_EXTENSIONS
          },
          taskStatus: this.getTaskStatusSnapshot(input.taskEnvelope.taskId),
          lastControlSignal: state?.controlSignal,
          sourceEventIds: expectedSourceEventIds,
          reason: input.reason
        });
      supervisorInputBytes = Buffer.byteLength(supervisorInput);
      const rawControlSignal = this.structuredInvocationsEnabled
        ? await invokeStructured<unknown>(activeSupervisorSession, supervisorInput, {
          toolName: "control_submit",
          idleTimeoutMs: SUPERVISOR_IDLE_TIMEOUT_MS,
          hardTimeoutMs: SUPERVISOR_HARD_TIMEOUT_MS
        })
        : extractJsonObject<unknown>(await withTimeout(
          promptAndCollect(activeSupervisorSession, supervisorInput),
          SUPERVISOR_HARD_TIMEOUT_MS,
          () => void supervisorSession?.abort()
        ));
      const controlSignal = {
        ...normalizeSupervisorControlSignal(rawControlSignal, expectedSourceEventIds),
        evidenceRefs: expectedSourceEventIds
      };
      const postPromptDiscardReason = this.supervisorCheckDiscardReason(input, state);
      if (postPromptDiscardReason) {
        supervisorInvocationStatus = "discarded";
        return this.discardSupervisorCheck(input, postPromptDiscardReason, expectedSourceEventIds);
      }
      supervisorInvocationStatus = "completed";
      await this.executionLog.append({
        taskId: input.taskEnvelope.taskId,
        role: "observer",
        eventType: "supervisor_check_succeeded",
        summary: `${input.reason}: signal=${controlSignal.decision}`,
        payload: {
          queueId: input.queueId,
          reason: input.reason,
          controlSignal,
          sourceEventIds: expectedSourceEventIds,
          outputPreview: supervisorOutput.slice(0, 1000)
        }
      });
      return controlSignal;
    } catch (error) {
      supervisorInvocationStatus = "failed";
      const controlSignal: ControlSignal = {
        decision: "continue",
        reason: `Supervisor check failed; continuing hot path: ${error instanceof Error ? error.message : String(error)}`,
        evidenceRefs: expectedSourceEventIds,
        confidence: "low"
      };
      await this.executionLog.append({
        taskId: input.taskEnvelope.taskId,
        role: "observer",
        eventType: "supervisor_check_failed",
        summary: controlSignal.reason,
        payload: {
          queueId: input.queueId,
          reason: input.reason,
          error: error instanceof Error ? error.message : String(error),
          outputPreview: supervisorOutput.slice(0, 1000),
          controlSignal
        }
      });
      return controlSignal;
    } finally {
      await supervisorLogging?.drain();
      supervisorLogging?.();
      if (supervisorSession) {
        await this.appendInvocationMetrics({
          session: supervisorSession,
          before: supervisorStatsBefore,
          invocationId: input.queueId ?? `supervisor:${randomUUID()}`,
          invocationKind: "supervisor",
          agentRole: "observer",
          status: supervisorInvocationStatus,
          startedAt: supervisorInvocationStartedAt,
          taskId: input.taskEnvelope.taskId,
          inputBytes: supervisorInputBytes,
          details: { reason: input.reason, sourceEventIds: expectedSourceEventIds }
        });
      }
      if (supervisorSession) {
        this.activeSupervisorSessions.delete(supervisorSession);
      }
      if (supervisorSession) {
        disposeSession(supervisorSession);
      }
    }
  }

  private supervisorCheckDiscardReason(input: SupervisorCheckRequest, state?: ActiveTaskState): string | undefined {
    if (!state) {
      return "task is no longer active";
    }
    if (state.lifecycleState !== "running") {
      return `epoch ${state.epochId} is ${state.lifecycleState}`;
    }
    if (state.executorStopRequested) {
      return "executor already requested stop";
    }
    const requestedTurnCount = turnWindowCount(input.reason);
    if (
      requestedTurnCount !== undefined
      && state.turnEndCount - requestedTurnCount >= SUPERVISOR_TURN_WINDOW_SIZE
    ) {
      return `stale supervisor window: requested ${requestedTurnCount}, current ${state.turnEndCount}`;
    }
    return undefined;
  }

  private async discardSupervisorCheck(
    input: SupervisorCheckRequest,
    discardReason: string,
    evidenceRefs: string[]
  ): Promise<ControlSignal> {
    const controlSignal: ControlSignal = {
      decision: "continue",
      reason: `Supervisor check discarded: ${discardReason}`,
      evidenceRefs,
      confidence: "low"
    };
    await this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "runtime",
      eventType: "supervisor_check_discarded",
      summary: `${input.reason}: ${discardReason}`,
      payload: {
        queueId: input.queueId,
        reason: input.reason,
        discardReason,
        sourceEventIds: evidenceRefs
      }
    });
    return controlSignal;
  }

  private enqueueProjectionJob(input: ObserverProjectionRequest): Promise<ObserverProjection> {
    return this.requestProjection(input);
  }

  private requestProjection(input: ObserverProjectionRequest): Promise<ObserverProjection> {
    const currentProjectionState = this.runtimeStore.getProjectionState(input.taskEnvelope.taskId);
    const latestSeq = Math.max(
      currentProjectionState.desiredSeq,
      ...((input.sourceEventIds ?? []).map((eventId) => this.executionLog.seqForEvent(eventId) ?? 0))
    );
    this.runtimeStore.raiseProjectionDesired(
      input.taskEnvelope.taskId,
      latestSeq,
      input.reason === "task_end" ? 10 : 0
    );
    const queueItem: PendingProjectionRequest = {
      ...input,
      queueId: `projection:${randomUUID()}`,
      queuedAt: Date.now(),
      sequence: this.projectionSequence += 1,
      supersedes: []
    };
    if (this.projectionQueueClosed) {
      return this.discardProjectionJob(queueItem, "controller is closing; projection queue is closed");
    }
    return new Promise<ObserverProjection>((resolve, reject) => {
      queueItem.resolve = resolve;
      queueItem.reject = reject;
      void this.executionLog.append({
        taskId: input.taskEnvelope.taskId,
        role: "runtime",
        eventType: "projection_requested",
        summary: `${input.reason} requested`,
        payload: {
          queueId: queueItem.queueId,
          reason: input.reason,
          sourceEventIds: input.sourceEventIds ?? [],
          pendingProjectionCount: this.pendingProjectionRequests.size,
          activeProjectionJobCount: this.activeProjectionJobCount
        }
      });
      const pendingKey = input.taskEnvelope.taskId;
      const existing = this.pendingProjectionRequests.get(pendingKey);
      if (existing) {
        const shouldReplace = projectionRequestPriority(queueItem) >= projectionRequestPriority(existing);
        if (!shouldReplace) {
          void this.resolveSupersededProjectionRequest(
            queueItem,
            `pending ${existing.reason} has higher priority`
          );
          return;
        }
        this.pendingProjectionRequests.delete(pendingKey);
        queueItem.supersedes = [...(queueItem.supersedes ?? []), existing.queueId];
        void this.resolveSupersededProjectionRequest(
          existing,
          `${queueItem.reason} superseded pending ${existing.reason}`
        );
        void this.executionLog.append({
          taskId: input.taskEnvelope.taskId,
          role: "runtime",
          eventType: "projection_request_coalesced",
          summary: `${existing.reason} -> ${queueItem.reason}`,
          payload: {
            supersededQueueId: existing.queueId,
            queueId: queueItem.queueId,
            previousReason: existing.reason,
            reason: queueItem.reason,
            pendingProjectionCount: this.pendingProjectionRequests.size,
            activeProjectionJobCount: this.activeProjectionJobCount
          }
        });
      }
      this.pendingProjectionRequests.set(pendingKey, queueItem);
      void this.executionLog.append({
        taskId: input.taskEnvelope.taskId,
        role: "runtime",
        eventType: "projection_job_queued",
        summary: `${input.reason} queued`,
        payload: this.projectionQueuePayload(queueItem)
      });
      this.drainProjectionQueue();
    });
  }

  private projectionQueuePayload(input: PendingProjectionRequest): Record<string, unknown> {
    return {
      queueId: input.queueId,
      reason: input.reason,
      sourceEventIds: input.sourceEventIds ?? [],
      sequence: input.sequence,
      supersedes: input.supersedes ?? [],
      pendingProjectionCount: this.pendingProjectionRequests.size,
      activeProjectionJobCount: this.activeProjectionJobCount
    };
  }

  private drainProjectionQueue(): void {
    if (
      (this.projectionQueueClosed && !this.projectionQueueDrainingOnClose)
      || this.projectionCancellationRequested
    ) {
      return;
    }
    while (this.activeProjectionJobCount < MAX_ACTIVE_PROJECTION_JOBS && this.pendingProjectionRequests.size > 0) {
      const nextRequest = this.nextPendingProjectionRequest();
      if (!nextRequest) {
        return;
      }
      this.pendingProjectionRequests.delete(nextRequest.taskEnvelope.taskId);
      const projectionPromise = this.runProjectionJob(nextRequest);
      this.projectionJobs.add(projectionPromise);
      projectionPromise.then((projection) => {
        nextRequest.resolve?.(projection);
        const state = this.getActiveTaskState(nextRequest.taskEnvelope.taskId);
        if (state) {
          state.lastObserverProjection = projection;
        }
      }, (error) => {
        nextRequest.reject?.(error);
      }).finally(() => {
        this.projectionJobs.delete(projectionPromise);
        this.drainProjectionQueue();
      });
    }
  }

  private nextPendingProjectionRequest(): PendingProjectionRequest | undefined {
    return [...this.pendingProjectionRequests.values()]
      .filter((request) => this.runtimeStore.getProjectionState(request.taskEnvelope.taskId).activeGeneration === undefined)
      .sort((left, right) =>
        projectionRequestPriority(right) - projectionRequestPriority(left)
        || left.sequence - right.sequence
      )[0];
  }

  private async resolveSupersededProjectionRequest(
    input: PendingProjectionRequest,
    supersededReason: string
  ): Promise<void> {
    const projection: ObserverProjection = {
      graphDelta: { sourceEventIds: input.sourceEventIds ?? [], nodes: [], edges: [] },
      controlSignal: {
        decision: "continue",
        reason: `Projection request superseded: ${supersededReason}`,
        evidenceRefs: input.sourceEventIds ?? [],
        confidence: "low"
      }
    };
    await this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "runtime",
      eventType: "projection_request_superseded",
      summary: `${input.reason}: ${supersededReason}`,
      payload: {
        queueId: input.queueId,
        reason: input.reason,
        supersededReason,
        sourceEventIds: input.sourceEventIds ?? [],
        pendingProjectionCount: this.pendingProjectionRequests.size,
        activeProjectionJobCount: this.activeProjectionJobCount
      }
    });
    input.resolve?.(projection);
  }

  private enqueueObserverProjection(input: ObserverProjectionRequest): Promise<ObserverProjection> {
    return this.enqueueProjectionJob(input);
  }

  private async prepareProjectorInput(input: {
    input: ObserverProjectionRequest;
    claim: ProjectionClaim;
    batch: ProjectionBatch;
    nodeLimit: number;
    edgeLimit: number;
    artifactTextLimit?: number;
    observationTextLimit?: number;
    graphTextLimit?: number;
    goalTextLimit?: number;
  }) {
    const orphanRefs = this.projectionOrphanRefsByTask.get(input.input.taskEnvelope.taskId) ?? [];
    const closure = this.graphStore.projectionClosure({
      taskId: input.input.taskEnvelope.taskId,
      scopeRef: input.input.taskEnvelope.scopeRef,
      dependencyTaskIds: input.input.taskEnvelope.dependsOnTaskRefs,
      targetRefs: [...input.input.taskEnvelope.targetRefs, ...orphanRefs],
      anchors: input.batch.observations.flatMap((observation) => observation.anchors),
      nodeLimit: input.nodeLimit,
      edgeLimit: input.edgeLimit
    });
    const graphContext = aliasProjectionGraphContext(closure);
    const artifactIndex = await this.loadProjectorArtifactIndex({
      taskEnvelope: input.input.taskEnvelope,
      taskResult: input.input.taskResult,
      observations: input.batch.observations
    });
    const artifactText = input.artifactTextLimit !== undefined
      ? truncateText(artifactIndex.text, input.artifactTextLimit)
      : artifactIndex.text;
    const observationText = input.observationTextLimit !== undefined
      ? truncateText(renderProjectionObservations(input.batch.observations), input.observationTextLimit)
      : renderProjectionObservations(input.batch.observations);
    const graphText = input.graphTextLimit !== undefined
      ? truncateText(renderProjectionGraphContext(graphContext), input.graphTextLimit)
      : renderProjectionGraphContext(graphContext);
    const projectorInput = renderObserverInput({
      projectionJob: [
        `task=${input.input.taskEnvelope.taskId}`,
        `reason=${input.input.reason}`,
        `seq=(${input.claim.fromSeq},${input.batch.toSeq}] desired=${input.claim.toSeq}`,
        orphanRefs.length > 0 ? `unconnectedNodeRefs=${orphanRefs.join(",")}` : undefined,
        input.input.taskResult ? `taskOutcome=${truncateText(input.input.taskResult.summary, 600)}` : undefined,
        `goal=${truncateText(input.input.taskEnvelope.goal, input.goalTextLimit ?? 500)}`
      ].filter((line): line is string => Boolean(line)).join("\n"),
      observations: observationText,
      artifactIndex: artifactText,
      graphContext: graphText
    });
    return {
      batch: input.batch,
      graphContext,
      artifactCount: artifactIndex.itemCount,
      projectorInput,
      inputBytes: Buffer.byteLength(projectorInput)
    };
  }

  private async runProjectionJob(input: ObserverProjectionRequest): Promise<ObserverProjection> {
    const discardReason = this.observerProjectionDiscardReason(input);
    if (discardReason) {
      return this.discardProjectionJob(input, discardReason);
    }
    const claim = this.runtimeStore.claimProjection(input.taskEnvelope.taskId);
    if (!claim) {
      return this.discardProjectionJob(input, "no uncommitted projection range is available");
    }
    let expectedSourceEventIds = input.sourceEventIds ?? [];
    this.activeProjectionJobCount += 1;
    await this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "runtime",
      eventType: "projection_job_started",
      summary: `${input.reason} started`,
      payload: {
        queueId: input.queueId,
        reason: input.reason,
        queuedForMs: input.queuedAt ? Date.now() - input.queuedAt : undefined,
        sourceEventIds: expectedSourceEventIds,
        fromSeq: claim.fromSeq,
        toSeq: claim.toSeq,
        generation: claim.generation,
        activeProjectionJobCount: this.activeProjectionJobCount
      }
    });
    const projectionHeartbeat = this.startRuntimeHeartbeat({
      taskId: input.taskEnvelope.taskId,
      eventType: "projection_job_heartbeat",
      summary: `${input.reason} still running`,
      payload: {
        queueId: input.queueId,
        reason: input.reason,
        sourceEventIds: expectedSourceEventIds
      }
    });
    let observerOutput = "";
    let projectorSession: SecurityAgentSession | undefined;
    let projectorLogging: ReturnType<typeof attachExecutionLogging> | undefined;
    let projectorStatsBefore: PiSessionStatsSnapshot | undefined;
    let projectorInputBytes = 0;
    let projectorObservationCount = 0;
    let projectorProjectionToSeq = claim.toSeq;
    let projectorInvocationStatus = "failed";
    const projectorInvocationStartedAt = Date.now();
    let projectionCommitted = false;
    try {
      const cancellationReason = this.projectionWriteBlockedReason();
      if (cancellationReason) {
        return this.discardProjectionJob(input, cancellationReason);
      }
      const availableLogEvents = await this.executionLog.range({
        taskId: input.taskEnvelope.taskId,
        afterSeq: claim.fromSeq,
        toSeq: claim.toSeq,
        roles: [...PROJECTOR_OBSERVATION_ROLES],
        eventTypes: [...PROJECTOR_OBSERVATION_EVENT_TYPES]
      });
      const availableObservationCount = selectProjectionBatch(availableLogEvents, {
        fromSeq: claim.fromSeq,
        maxObservations: Number.MAX_SAFE_INTEGER
      }).observations.length;
      if (availableObservationCount === 0 && availableLogEvents.length > 0) {
        return this.discardProjectionJob(input, "waiting for executor result interpretation");
      }
      const terminalProjection = Boolean(input.taskResult);
      const selectedBatch = selectProjectionBatch(availableLogEvents, {
        fromSeq: claim.fromSeq,
        maxObservations: terminalProjection ? Number.MAX_SAFE_INTEGER : PROJECTOR_MAX_OBSERVATIONS_PER_JOB
      });
      const initialBatch = terminalProjection || selectedBatch.observations.length >= availableObservationCount
        ? { ...selectedBatch, toSeq: claim.toSeq }
        : selectedBatch;
      let prepared = await this.prepareProjectorInput({
        input,
        claim,
        batch: initialBatch,
        nodeLimit: 12,
        edgeLimit: 16
      });
      if (prepared.inputBytes > PROJECTOR_INPUT_TARGET_BYTES) {
        const compactedBatch = compactProjectionBatchForInput(initialBatch, {
          maxObservations: terminalProjection ? 24 : PROJECTOR_MAX_OBSERVATIONS_PER_JOB,
          maxChars: Math.floor(PROJECTOR_INPUT_TARGET_BYTES * 0.55)
        });
        prepared = await this.prepareProjectorInput({
          input,
          claim,
          batch: compactedBatch,
          nodeLimit: 10,
          edgeLimit: 14,
          artifactTextLimit: 1_200,
          graphTextLimit: 7_000
        });
      }
      if (prepared.inputBytes > PROJECTOR_INPUT_TARGET_BYTES) {
        const compactedBatch = compactProjectionBatchForInput(initialBatch, {
          maxObservations: terminalProjection ? 16 : Math.min(PROJECTOR_MAX_OBSERVATIONS_PER_JOB, 12),
          maxChars: Math.floor(PROJECTOR_INPUT_TARGET_BYTES * 0.4)
        });
        prepared = await this.prepareProjectorInput({
          input,
          claim,
          batch: compactedBatch,
          nodeLimit: 8,
          edgeLimit: 12,
          artifactTextLimit: 500,
          observationTextLimit: Math.floor(PROJECTOR_INPUT_TARGET_BYTES * 0.42),
          graphTextLimit: 4_000,
          goalTextLimit: 240
        });
      }
      if (prepared.inputBytes > PROJECTOR_INPUT_TARGET_BYTES) {
        const compactedBatch = compactProjectionBatchForInput(initialBatch, {
          maxObservations: terminalProjection ? 12 : Math.min(PROJECTOR_MAX_OBSERVATIONS_PER_JOB, 8),
          maxChars: Math.floor(PROJECTOR_INPUT_TARGET_BYTES * 0.3)
        });
        let observationTextLimit = Math.max(800, Math.floor(PROJECTOR_INPUT_TARGET_BYTES * 0.32));
        do {
          prepared = await this.prepareProjectorInput({
            input,
            claim,
            batch: compactedBatch,
            nodeLimit: 8,
            edgeLimit: 12,
            artifactTextLimit: 0,
            observationTextLimit,
            graphTextLimit: 2_000,
            goalTextLimit: 120
          });
          observationTextLimit = Math.max(400, observationTextLimit - Math.max(500, prepared.inputBytes - PROJECTOR_INPUT_TARGET_BYTES));
        } while (prepared.inputBytes > PROJECTOR_INPUT_TARGET_BYTES && observationTextLimit > 400);
      }
      const projectionToSeq = prepared.batch.toSeq;
      projectorProjectionToSeq = projectionToSeq;
      projectorInputBytes = prepared.inputBytes;
      projectorObservationCount = prepared.batch.observations.length;
      expectedSourceEventIds = prepared.batch.sourceEventIds;
      await this.executionLog.append({
        taskId: input.taskEnvelope.taskId,
        role: "runtime",
        eventType: "projection_input_built",
        summary: `observations=${prepared.batch.observations.length} bytes=${prepared.inputBytes}`,
        payload: {
          queueId: input.queueId,
          reason: input.reason,
          generation: claim.generation,
          fromSeq: claim.fromSeq,
          toSeq: projectionToSeq,
          desiredSeq: claim.toSeq,
          observationCount: prepared.batch.observations.length,
          graphNodeCount: prepared.graphContext.nodes.length,
          graphEdgeCount: prepared.graphContext.edges.length,
          artifactCount: prepared.artifactCount,
          inputBytes: prepared.inputBytes,
          targetBytes: PROJECTOR_INPUT_TARGET_BYTES,
          overTarget: prepared.inputBytes > PROJECTOR_INPUT_TARGET_BYTES
        }
      });
      if (prepared.batch.observations.length === 0) {
        const projection: ObserverProjection = {
          graphDelta: { sourceEventIds: [], nodes: [], edges: [] },
          controlSignal: CONTINUE_CONTROL_SIGNAL
        };
        const commitResult = this.graphStore.commitProjection({
          taskId: input.taskEnvelope.taskId,
          fromSeq: claim.fromSeq,
          toSeq: projectionToSeq,
          generation: claim.generation,
          delta: projection.graphDelta
        });
        projection.graphDelta = commitResult.delta;
        projectionCommitted = true;
        projectorInvocationStatus = "completed_without_llm";
        this.projectionRetryCountByTask.delete(input.taskEnvelope.taskId);
        await this.appendProjectionJobLog({
          taskId: input.taskEnvelope.taskId,
          eventType: "projection_job_succeeded",
          reason: input.reason,
          projection,
          outputPreview: "",
          queueId: input.queueId,
          generation: claim.generation,
          fromSeq: claim.fromSeq,
          toSeq: projectionToSeq,
          desiredSeq: claim.toSeq,
          durationMs: Date.now() - projectorInvocationStartedAt,
          inputBytes: prepared.inputBytes,
          observationCount: prepared.batch.observations.length,
          remappedNodeCount: commitResult.remappedNodeCount,
          mergedNodeCount: commitResult.mergedNodeCount,
          orphanNodeIds: commitResult.orphanNodeIds
        });
        return projection;
      }
      const prePromptCancellationReason = this.projectionWriteBlockedReason();
      if (prePromptCancellationReason) {
        return this.discardProjectionJob(input, prePromptCancellationReason);
      }
      const observerSession = await this.createObserverSessionForMode("project", input.taskEnvelope.taskId);
      const activeProjectorSession = observerSession.session;
      projectorSession = activeProjectorSession;
      projectorStatsBefore = readPiSessionStats(activeProjectorSession);
      projectorLogging = observerSession.logging;
      this.activeProjectorSessions.add(activeProjectorSession);
      this.activeProjectorByTask.set(input.taskEnvelope.taskId, activeProjectorSession);
      const rawGraphDelta = this.structuredInvocationsEnabled
        ? await invokeStructured<unknown>(activeProjectorSession, prepared.projectorInput, {
          toolName: "graph_delta_submit",
          idleTimeoutMs: PROJECTOR_IDLE_TIMEOUT_MS,
          hardTimeoutMs: PROJECTOR_HARD_TIMEOUT_MS
        })
        : extractJsonObject<unknown>(await withTimeout(
          promptAndCollect(activeProjectorSession, prepared.projectorInput),
          PROJECTOR_HARD_TIMEOUT_MS,
          () => void activeProjectorSession.abort()
        ));
      const postPromptCancellationReason = this.projectionWriteBlockedReason();
      if (postPromptCancellationReason) {
        return this.discardProjectionJob(input, postPromptCancellationReason);
      }
      const graphDelta = expandProjectionDraft({
        value: rawGraphDelta,
        batch: prepared.batch,
        graphContext: prepared.graphContext
      });
      const projection: ObserverProjection = {
        graphDelta,
        controlSignal: CONTINUE_CONTROL_SIGNAL
      };
      const commitResult = this.graphStore.commitProjection({
        taskId: input.taskEnvelope.taskId,
        fromSeq: claim.fromSeq,
        toSeq: projectionToSeq,
        generation: claim.generation,
        delta: projection.graphDelta
      });
      projection.graphDelta = commitResult.delta;
      const orphanCandidates = dedupeStrings([
        ...(this.projectionOrphanRefsByTask.get(input.taskEnvelope.taskId) ?? []),
        ...commitResult.orphanNodeIds
      ]);
      const unresolvedOrphanNodeIds = this.graphStore.findOrphanNodeIds(orphanCandidates).slice(0, 8);
      if (unresolvedOrphanNodeIds.length > 0) {
        this.projectionOrphanRefsByTask.set(input.taskEnvelope.taskId, unresolvedOrphanNodeIds);
        await this.executionLog.append({
          taskId: input.taskEnvelope.taskId,
          role: "runtime",
          eventType: "projection_orphans_detected",
          summary: `projection has ${unresolvedOrphanNodeIds.length} unconnected nodes`,
          payload: { orphanNodeIds: unresolvedOrphanNodeIds }
        });
      } else {
        this.projectionOrphanRefsByTask.delete(input.taskEnvelope.taskId);
      }
      projectionCommitted = true;
      projectorInvocationStatus = "completed";
      this.projectionRetryCountByTask.delete(input.taskEnvelope.taskId);
      await this.appendProjectionJobLog({
        taskId: input.taskEnvelope.taskId,
        eventType: "projection_job_succeeded",
        reason: input.reason,
        projection,
        outputPreview: observerOutput.slice(0, 1000),
        queueId: input.queueId,
        generation: claim.generation,
        fromSeq: claim.fromSeq,
        toSeq: projectionToSeq,
        desiredSeq: claim.toSeq,
        durationMs: Date.now() - projectorInvocationStartedAt,
        inputBytes: prepared.inputBytes,
        observationCount: prepared.batch.observations.length,
        remappedNodeCount: commitResult.remappedNodeCount,
        mergedNodeCount: commitResult.mergedNodeCount,
        orphanNodeIds: commitResult.orphanNodeIds
      });
      return projection;
    } catch (promptError) {
      projectorInvocationStatus = "failed";
      this.runtimeStore.releaseProjection(input.taskEnvelope.taskId, claim.generation);
      const projectionState = this.runtimeStore.getProjectionState(input.taskEnvelope.taskId);
      if (projectionState.generation > claim.generation) {
        return this.discardProjectionJob(input, `projection generation ${claim.generation} was superseded`);
      }
      const cancellationReason = this.projectionWriteBlockedReason();
      if (cancellationReason) {
        return this.discardProjectionJob(input, cancellationReason);
      }
      const failedProjection = await this.failProjectionJob(
        input,
        expectedSourceEventIds,
        promptError,
        "project_failed",
        observerOutput,
        {
          generation: claim.generation,
          fromSeq: claim.fromSeq,
          toSeq: projectorProjectionToSeq,
          desiredSeq: claim.toSeq,
          durationMs: Date.now() - projectorInvocationStartedAt,
          inputBytes: projectorInputBytes,
          observationCount: projectorObservationCount
        }
      );
      this.scheduleProjectionRetry(input, promptError);
      return failedProjection;
    } finally {
      clearInterval(projectionHeartbeat);
      await projectorLogging?.drain();
      projectorLogging?.();
      if (projectorSession) {
        await this.appendInvocationMetrics({
          session: projectorSession,
          before: projectorStatsBefore,
          invocationId: input.queueId ?? `projection:${randomUUID()}`,
          invocationKind: "projector",
          agentRole: "observer",
          status: projectorInvocationStatus,
          startedAt: projectorInvocationStartedAt,
          taskId: input.taskEnvelope.taskId,
          inputBytes: projectorInputBytes,
          details: {
            reason: input.reason,
            generation: claim.generation,
            fromSeq: claim.fromSeq,
            toSeq: projectorProjectionToSeq,
            desiredSeq: claim.toSeq,
            observationCount: projectorObservationCount,
            projectionCommitted
          }
        });
      }
      if (!projectionCommitted) {
        this.runtimeStore.releaseProjection(input.taskEnvelope.taskId, claim.generation);
      }
      this.activeProjectionJobCount = Math.max(0, this.activeProjectionJobCount - 1);
      if (projectorSession) {
        this.activeProjectorSessions.delete(projectorSession);
        if (this.activeProjectorByTask.get(input.taskEnvelope.taskId) === projectorSession) {
          this.activeProjectorByTask.delete(input.taskEnvelope.taskId);
        }
      }
      if (projectorSession) {
        disposeSession(projectorSession);
      }
      const projectionState = this.runtimeStore.getProjectionState(input.taskEnvelope.taskId);
      if (
        !this.projectionQueueClosed
        && !this.projectionCancellationRequested
        && projectionCommitted
        && projectionState.desiredSeq > projectionState.committedSeq
        && !this.pendingProjectionRequests.has(input.taskEnvelope.taskId)
      ) {
        if (!input.taskResult) {
          this.scheduleProjectionCatchup(input);
        }
      }
    }
  }

  /**
   * Debounced catch-up for the uncommitted tail left behind by a finished job.
   * The next tool window or the task_end flush claims the same (committed, desired]
   * range, so an immediate catch-up mostly produces tiny, full-cost projector calls.
   * The timer re-validates the watermark and only fires when no other projection
   * took over and the tail holds enough observations to be worth a call.
   */
  private scheduleProjectionCatchup(input: ObserverProjectionRequest): void {
    const taskId = input.taskEnvelope.taskId;
    if (this.projectionCatchupTimers.has(taskId)) {
      return;
    }
    const delayMs = positiveIntegerEnv("PROJECTOR_CATCHUP_DELAY_MS", DEFAULT_PROJECTOR_CATCHUP_DELAY_MS);
    const timer = setTimeout(() => {
      this.projectionCatchupTimers.delete(taskId);
      void this.fireProjectionCatchup(input);
    }, delayMs);
    timer.unref?.();
    this.projectionCatchupTimers.set(taskId, timer);
  }

  private async fireProjectionCatchup(input: ObserverProjectionRequest): Promise<void> {
    const taskId = input.taskEnvelope.taskId;
    if (this.projectionQueueClosed || this.projectionCancellationRequested) {
      return;
    }
    const projectionState = this.runtimeStore.getProjectionState(taskId);
    if (projectionState.desiredSeq <= projectionState.committedSeq) {
      return;
    }
    if (
      projectionState.activeGeneration !== undefined
      || this.pendingProjectionRequests.has(taskId)
    ) {
      return;
    }
    const tailEvents = await this.executionLog.range({
      taskId,
      afterSeq: projectionState.committedSeq,
      toSeq: projectionState.desiredSeq,
      roles: [...PROJECTOR_OBSERVATION_ROLES],
      eventTypes: [...PROJECTOR_OBSERVATION_EVENT_TYPES]
    });
    const observationCount = selectProjectionBatch(tailEvents, {
      fromSeq: projectionState.committedSeq,
      maxObservations: Number.MAX_SAFE_INTEGER
    }).observations.length;
    const minObservations = positiveIntegerEnv("PROJECTOR_CATCHUP_MIN_OBSERVATIONS", DEFAULT_PROJECTOR_CATCHUP_MIN_OBSERVATIONS);
    if (observationCount < minObservations) {
      await this.executionLog.append({
        taskId,
        role: "runtime",
        eventType: "projection_catchup_deferred",
        summary: `catchup deferred: observations=${observationCount} below min=${minObservations}; tail merges into the next projection`,
        payload: {
          committedSeq: projectionState.committedSeq,
          desiredSeq: projectionState.desiredSeq,
          observationCount,
          minObservations,
          previousReason: input.reason
        }
      });
      return;
    }
    await this.executionLog.append({
      taskId,
      role: "runtime",
      eventType: "projection_catchup_started",
      summary: `committed=${projectionState.committedSeq} desired=${projectionState.desiredSeq}`,
      payload: {
        committedSeq: projectionState.committedSeq,
        desiredSeq: projectionState.desiredSeq,
        observationCount,
        delayedMs: positiveIntegerEnv("PROJECTOR_CATCHUP_DELAY_MS", DEFAULT_PROJECTOR_CATCHUP_DELAY_MS),
        previousReason: input.reason
      }
    });
    void this.requestProjection({
      reason: "projection_catchup",
      taskEnvelope: input.taskEnvelope,
      taskResult: input.taskResult
    });
  }

  private scheduleProjectionRetry(input: ObserverProjectionRequest, error: unknown): void {
    if (this.projectionQueueClosed || this.projectionCancellationRequested) {
      return;
    }
    if (!isRetryableProjectionError(error)) {
      return;
    }
    const retryCount = (this.projectionRetryCountByTask.get(input.taskEnvelope.taskId) ?? 0) + 1;
    if (retryCount > PROJECTOR_MAX_RETRIES) {
      return;
    }
    this.projectionRetryCountByTask.set(input.taskEnvelope.taskId, retryCount);
    const delayMs = 2_000 * retryCount;
    const timer = setTimeout(() => {
      if (this.projectionQueueClosed || this.projectionCancellationRequested) {
        return;
      }
      const state = this.runtimeStore.getProjectionState(input.taskEnvelope.taskId);
      if (state.desiredSeq <= state.committedSeq) {
        return;
      }
      void this.requestProjection({
        reason: `projection_retry:${retryCount}`,
        taskEnvelope: input.taskEnvelope,
        taskResult: input.taskResult
      });
    }, delayMs);
    timer.unref?.();
  }

  private observerProjectionDiscardReason(input: ObserverProjectionRequest): string | undefined {
    const writeBlockedReason = this.projectionWriteBlockedReason();
    if (writeBlockedReason) {
      return writeBlockedReason;
    }
    return undefined;
  }

  private projectionWriteBlockedReason(): string | undefined {
    if (this.graphStoreClosed) {
      return "graph store is already closed";
    }
    if (this.projectionCancellationRequested) {
      return "controller shutdown cancelled projection before graph write";
    }
    return undefined;
  }

  private async discardProjectionJob(input: ObserverProjectionRequest, discardReason: string): Promise<ObserverProjection> {
    const sourceEventIds = input.sourceEventIds ?? [];
    await this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "runtime",
      eventType: "projection_job_discarded",
      summary: `${input.reason}: ${discardReason}`,
      payload: {
        queueId: input.queueId,
        reason: input.reason,
        discardReason,
        sourceEventIds
      }
    });
    return {
      graphDelta: { sourceEventIds, nodes: [], edges: [] },
      controlSignal: {
        decision: "continue",
        reason: `Projection job discarded: ${discardReason}`,
        evidenceRefs: sourceEventIds,
        confidence: "low"
      }
    };
  }

  private async failProjectionJob(
    input: ObserverProjectionRequest,
    expectedSourceEventIds: string[],
    error: unknown,
    phase: string,
    observerOutput: string,
    metrics: {
      generation: number;
      fromSeq: number;
      toSeq: number;
      desiredSeq: number;
      durationMs: number;
      inputBytes: number;
      observationCount: number;
    }
  ): Promise<ObserverProjection> {
    const parseFailureEvent = await this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "observer",
      eventType: "projection_job_failed",
      summary: error instanceof Error ? error.message : "Projection job failed",
      payload: {
        queueId: input.queueId,
        reason: input.reason,
        phase,
        error: error instanceof Error ? error.message : String(error),
        outputPreview: observerOutput.slice(0, 2000),
        ...metrics
      }
    });
    const cancellationReason = this.projectionWriteBlockedReason();
    if (cancellationReason) {
      return {
        graphDelta: { sourceEventIds: [...expectedSourceEventIds, parseFailureEvent.id], nodes: [], edges: [] },
        controlSignal: {
          decision: "continue",
          reason: `Projection job failed during ${phase}, but graph write was skipped: ${cancellationReason}`,
          evidenceRefs: [...expectedSourceEventIds, parseFailureEvent.id],
          confidence: "low"
        }
      };
    }
    return {
      graphDelta: { sourceEventIds: expectedSourceEventIds, nodes: [], edges: [] },
      controlSignal: {
        decision: "continue",
        reason: `Projection job failed during ${phase}; committed watermark was not advanced`,
        evidenceRefs: [...expectedSourceEventIds, parseFailureEvent.id],
        confidence: "low"
      }
    };
  }

  private async appendProjectionJobLog(input: {
    taskId: string;
    eventType: "projection_job_succeeded";
    reason: string;
    projection: ObserverProjection;
    outputPreview: string;
    error?: string;
    queueId?: string;
    generation?: number;
    fromSeq?: number;
    toSeq?: number;
    desiredSeq?: number;
    durationMs?: number;
    inputBytes?: number;
    observationCount?: number;
    remappedNodeCount?: number;
    mergedNodeCount?: number;
    orphanNodeIds?: string[];
  }): Promise<void> {
    const nodeCounts = input.projection.graphDelta.nodes.reduce<Record<string, number>>((counts, node) => {
      const key = `${node.graphKind}:${node.type}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    await this.executionLog.append({
      taskId: input.taskId,
      role: "observer",
      eventType: input.eventType,
      summary: `${input.reason}: nodes=${input.projection.graphDelta.nodes.length} edges=${input.projection.graphDelta.edges.length}`,
      payload: {
        reason: input.reason,
        queueId: input.queueId,
        generation: input.generation,
        fromSeq: input.fromSeq,
        toSeq: input.toSeq,
        desiredSeq: input.desiredSeq,
        durationMs: input.durationMs,
        inputBytes: input.inputBytes,
        observationCount: input.observationCount,
        remappedNodeCount: input.remappedNodeCount,
        mergedNodeCount: input.mergedNodeCount,
        orphanNodeIds: input.orphanNodeIds,
        nodeCounts,
        edgeCount: input.projection.graphDelta.edges.length,
        sourceEventIds: input.projection.graphDelta.sourceEventIds,
        empty: input.projection.graphDelta.nodes.length === 0 && input.projection.graphDelta.edges.length === 0,
        error: input.error,
        outputPreview: input.outputPreview
      }
    });
  }

  private startRuntimeHeartbeat(input: {
    taskId?: string;
    eventType: string;
    summary: string;
    payload: Record<string, unknown>;
  }): NodeJS.Timeout {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      void this.executionLog.append({
        taskId: input.taskId,
        role: "runtime",
        eventType: input.eventType,
        summary: `${input.summary}; elapsedMs=${elapsedMs}`,
        payload: {
          ...input.payload,
          elapsedMs
        }
      });
    }, RUNTIME_HEARTBEAT_MS);
    timer.unref?.();
    return timer;
  }

  private requestBudgetCheckpoint(
    taskEnvelope: TaskEnvelope,
    event: ExecutionEvent,
    budgetKey: "maxTurns",
    state = this.getActiveTaskState(taskEnvelope.taskId)
  ): void {
    if (!state || state.executorStopRequested) {
      return;
    }
    const limit = taskEnvelope.budget?.[budgetKey] ?? DEFAULT_TASK_BUDGET[budgetKey];
    const budgetSignal: ControlSignal = {
      decision: "checkpoint",
      reason: `Task budget reached: ${budgetKey}=${limit}`,
      evidenceRefs: [event.id],
      confidence: "high"
    };
    this.applyControlSignal(taskEnvelope, budgetSignal, state);
  }

  private requestSupervisorBudgetDecision(
    taskEnvelope: TaskEnvelope,
    event: ExecutionEvent,
    state: ActiveTaskState
  ): void {
    if (state.executorStopRequested || state.budgetDecisionPending) {
      return;
    }
    state.budgetDecisionPending = true;
    void this.enqueueSupervisorCheck({
      reason: `budget_pressure:maxTurns:${state.turnEndCount}`,
      taskEnvelope,
      sourceEventIds: [event.id]
    }).then((controlSignal) => {
      this.applyControlSignal(taskEnvelope, controlSignal, state);
      if (!state.executorStopRequested && remainingTurns(taskEnvelope, state) <= 0) {
        this.requestBudgetCheckpoint(taskEnvelope, event, "maxTurns", state);
      }
    }, () => {
      this.requestBudgetCheckpoint(taskEnvelope, event, "maxTurns", state);
    }).finally(() => {
      state.budgetDecisionPending = false;
    });
  }

  private applyBudgetExtensionFromSignal(taskEnvelope: TaskEnvelope, controlSignal: ControlSignal, state?: ActiveTaskState): boolean {
    if (!state || controlSignal.decision !== "continue") {
      return false;
    }
    const requestedDelta = controlSignal.budgetExtension?.maxTurnsDelta;
    if (typeof requestedDelta !== "number" || !Number.isFinite(requestedDelta) || requestedDelta <= 0) {
      return false;
    }
    const budget = ensureTaskBudget(taskEnvelope);
    if (budget.maxTurns >= MAX_TASK_BUDGET.maxTurns) {
      return false;
    }
    if (state.budgetExtensionCount >= MAX_BUDGET_EXTENSIONS) {
      return false;
    }
    const previousMaxTurns = budget.maxTurns;
    const extensionTurns = Math.min(Math.floor(requestedDelta), BUDGET_EXTENSION_TURNS);
    const nextMaxTurns = Math.min(MAX_TASK_BUDGET.maxTurns, previousMaxTurns + extensionTurns);
    if (nextMaxTurns <= previousMaxTurns) {
      return false;
    }
    budget.maxTurns = nextMaxTurns;
    state.budgetExtensionCount += 1;
    state.controlSignal = controlSignal;
    void this.executionLog.append({
      taskId: taskEnvelope.taskId,
      role: "runtime",
      eventType: "budget_extension_granted",
      summary: `Extended maxTurns ${previousMaxTurns}->${nextMaxTurns}: ${controlSignal.budgetExtension?.reason ?? controlSignal.reason}`,
      payload: {
        previousMaxTurns,
        nextMaxTurns,
        extensionTurns: nextMaxTurns - previousMaxTurns,
        budgetExtensionCount: state.budgetExtensionCount,
        maxBudgetExtensions: MAX_BUDGET_EXTENSIONS,
        controlSignal,
        budgetStatus: budgetStatusSnapshot(taskEnvelope, state)
      }
    });
    this.publishExecutorBudgetStatusUpdate({
      taskEnvelope,
      state,
      sourceEventId: controlSignal.evidenceRefs[0],
      reason: "budget_extension_granted",
      force: true
    });
    return true;
  }

  private publishExecutorBudgetStatusUpdate(input: {
    taskEnvelope: TaskEnvelope;
    state: ActiveTaskState;
    sourceEventId?: string;
    reason: string;
    force?: boolean;
  }): void {
    if (input.state.executorStopRequested) {
      return;
    }
    const status = budgetStatusSnapshot(input.taskEnvelope, input.state);
    const steerKey = budgetStatusSteerKey(input, status);
    if (!steerKey || input.state.budgetStatusSteerKeys.has(steerKey)) {
      return;
    }
    input.state.budgetStatusSteerKeys.add(steerKey);
    const message = formatExecutorBudgetStatus(input.taskEnvelope, input.state, input.reason, true);
    const steeringQueued = this.queueExecutorSteer(input.state, message, input.taskEnvelope.taskId, input.reason);
    void this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "runtime",
      eventType: "budget_status_updated",
      summary: `remainingTurns=${status.remainingTurns}`,
      payload: {
        reason: input.reason,
        sourceEventId: input.sourceEventId,
        budgetStatus: status,
        delivery: steeringQueued ? "steer" : "none",
        messagePreview: message.slice(0, 500)
      }
    });
  }

  private queueExecutorSteer(
    state: ActiveTaskState,
    message: string,
    taskId: string,
    reason: string,
    allowWhenStopping = false
  ): boolean {
    if (state.executorStopRequested && !allowWhenStopping) {
      return false;
    }
    const executorSession = state.executorSession;
    const steer = (executorSession as { steer?: (text: string) => Promise<void> } | undefined)?.steer;
    if (typeof steer !== "function" || !executorSession) {
      return false;
    }
    void steer.call(executorSession, message).catch((error: unknown) => {
      void this.executionLog.append({
        taskId,
        role: "runtime",
        eventType: "budget_status_steer_failed",
        summary: `Failed to steer budget status: ${error instanceof Error ? error.message : String(error)}`,
        payload: {
          reason,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    });
    return true;
  }

  private applyControlSignal(
    taskEnvelope: TaskEnvelope,
    controlSignal: ControlSignal,
    state = this.getActiveTaskState(taskEnvelope.taskId)
  ): void {
    if (!state || !this.isActiveEpoch(state)) {
      void this.executionLog.append({
        taskId: taskEnvelope.taskId,
        role: "runtime",
        eventType: "stale_callback_discarded",
        summary: `Ignored control signal for inactive epoch ${state?.epochId ?? "unknown"}`,
        payload: { controlSignal, epochId: state?.epochId, lifecycleState: state?.lifecycleState }
      });
      return;
    }
    this.applyBudgetExtensionFromSignal(taskEnvelope, controlSignal, state);
    if (!shouldStopExecutorForControlSignal(controlSignal)) {
      return;
    }
    if (state?.executorStopRequested) {
      return;
    }
    state.controlSignal = controlSignal;
    if (isGracefulCheckpointSignal(controlSignal)) {
      this.requestGracefulExecutorCheckpoint(taskEnvelope, controlSignal, state);
      return;
    }
    state.lifecycleState = "closing";
    this.runtimeStore.transitionEpoch({ epochId: state.epochId, state: "closing" });
    state.executorStopRequested = true;
    state.abortContext = createRuntimeAbortContext(controlSignal);
    void this.executionLog.append({
      taskId: taskEnvelope.taskId,
      role: "runtime",
      eventType: "executor_stop_requested",
      summary: controlSignal.reason,
      payload: { controlSignal, abortContext: state.abortContext, epochId: state.epochId }
    });
    this.terminateExecutorSession(state);
  }

  private terminateExecutorSession(state: ActiveTaskState): void {
    // Clear queued steers before aborting: the SDK auto-continues a run when
    // messages remain queued after abort, which would resurrect the Executor
    // past its termination point.
    state.executorSession?.clearQueue?.();
    void state.executorSession?.abort();
  }

  private requestGracefulExecutorCheckpoint(
    taskEnvelope: TaskEnvelope,
    controlSignal: ControlSignal,
    state: ActiveTaskState
  ): void {
    state.lifecycleState = "closing";
    this.runtimeStore.transitionEpoch({ epochId: state.epochId, state: "closing" });
    state.executorStopRequested = true;
    state.abortContext = createRuntimeAbortContext(controlSignal);
    const checkpointMessage = [
      "RUNTIME_CHECKPOINT_REQUEST:",
      controlSignal.reason,
      "停止扩展探索。先完成进行中的取证动作（读取已确认的关键内容、保存 artifact），再调用 task_result_submit 提交当前阶段已经确认的事实、失败结论、关键响应内容和 artifact 引用。",
      "本次 checkpoint 不代表 completed 或 blocked；状态由你的 TaskResult 和后续 Planner 决定。"
    ].join("\n");
    const steeringQueued = this.queueExecutorSteer(
      state,
      checkpointMessage,
      taskEnvelope.taskId,
      controlSignal.reason,
      true
    );
    void this.executionLog.append({
      epochId: state.epochId,
      taskId: taskEnvelope.taskId,
      role: "runtime",
      eventType: "executor_checkpoint_requested",
      summary: controlSignal.reason,
      payload: {
        controlSignal,
        delivery: steeringQueued ? "steer" : "none",
        graceMs: steeringQueued ? EXECUTOR_CHECKPOINT_GRACE_MS : 0
      }
    });
    if (!steeringQueued) {
      this.terminateExecutorSession(state);
      return;
    }
    state.checkpointGraceTimer = setTimeout(() => {
      if (this.getActiveTaskState(taskEnvelope.taskId) !== state || state.lifecycleState === "closed") {
        return;
      }
      void this.executionLog.append({
        epochId: state.epochId,
        taskId: taskEnvelope.taskId,
        role: "runtime",
        eventType: "executor_checkpoint_timed_out",
        summary: `Executor did not submit TaskResult within ${EXECUTOR_CHECKPOINT_GRACE_MS}ms`,
        payload: { controlSignal, graceMs: EXECUTOR_CHECKPOINT_GRACE_MS }
      });
      this.terminateExecutorSession(state);
    }, EXECUTOR_CHECKPOINT_GRACE_MS);
    state.checkpointGraceTimer.unref?.();
  }

  private getActiveAbortContext(taskId?: string): RuntimeAbortContext | undefined {
    if (!taskId) {
      return undefined;
    }
    return this.getActiveTaskState(taskId)?.abortContext;
  }

  private armEpochTimeSlice(taskEnvelope: TaskEnvelope): void {
    this.clearEpochTimeSlice(taskEnvelope);
    const state = this.getActiveTaskState(taskEnvelope.taskId);
    const activeRun = this.activeRun;
    if (!state || !activeRun) {
      return;
    }
    const now = Date.now();
    const remainingRunMs = Math.max(0, activeRun.deadlineAt - now);
    const epochTimeLimitMs = Math.max(1, Math.min(
      Math.floor(activeRun.maxRunTimeMs * TASK_EPOCH_RUN_TIME_SHARE),
      remainingRunMs
    ));
    state.runDeadlineAt = activeRun.deadlineAt;
    state.epochTimeLimitMs = epochTimeLimitMs;
    state.epochDeadlineAt = now + epochTimeLimitMs;
    const timer = setTimeout(() => {
      if (!this.isActiveEpoch(state)) {
        return;
      }
      const signal: ControlSignal = {
        decision: "checkpoint",
        reason: `Epoch time slice reached: ${epochTimeLimitMs}ms of ${activeRun.maxRunTimeMs}ms global run budget`,
        evidenceRefs: [],
        confidence: "high"
      };
      this.applyControlSignal(taskEnvelope, signal, state);
    }, epochTimeLimitMs);
    state.taskTimer = timer;
  }

  private clearEpochTimeSlice(taskEnvelope?: TaskEnvelope): void {
    const states = taskEnvelope
      ? [this.getActiveTaskState(taskEnvelope.taskId)].filter((state): state is ActiveTaskState => Boolean(state))
      : [...this.activeEpochs.values()];
    for (const state of states) {
      if (state.taskTimer) {
        clearTimeout(state.taskTimer);
        state.taskTimer = undefined;
      }
    }
  }

  private async createSyntheticTaskResult(input: {
    taskEnvelope: TaskEnvelope;
    signal?: ControlSignal;
    reason: string;
    executorOutputPreview: string;
  }): Promise<TaskResult> {
    const state = this.getActiveTaskState(input.taskEnvelope.taskId);
    const signal = input.signal ?? state?.controlSignal;
    const recentEvents = (await this.executionLog.window({
      taskId: input.taskEnvelope.taskId,
      epochId: state?.epochId,
      limit: 256,
      roles: ["executor", "runtime"],
      eventTypes: [
        "assistant_intent",
        "tool_started",
        "tool_finished",
        "provider_error",
        "task_completed",
        "task_partial",
        "task_failed"
      ]
    })).events;
    const observations = buildProjectionObservations(recentEvents);
    const observationSummary = causalObservationDigest(observations, 6_000);
    const previousResultSummary = stringProperty(this.getTaskStatusSnapshot(input.taskEnvelope.taskId)?.resultSummary);
    const artifactRefs = dedupeStrings(observations.flatMap((observation) => observation.artifactRefs));
    const isInfraAbort = state?.abortContext?.kind === "budget_abort"
      || (!signal && /concurrency limit|rate limit|too many requests|\b429\b|\b5\d\d\b|bad gateway|service unavailable|timed out|timeout/i.test(input.reason));
    const summary = [
      observationSummary ? `本轮因果观察：\n${observationSummary}` : undefined,
      previousResultSummary ? `既有阶段结果：${truncateText(previousResultSummary, 800)}` : undefined,
      signal
        ? `Executor checkpointed by Observer/Controller: ${signal.reason}`
        : `Executor ended without valid TaskResult: ${input.reason}`,
      input.executorOutputPreview.trim().length > 0
        ? `Executor 输出：${truncateText(input.executorOutputPreview, 800)}`
        : undefined
    ].filter((line): line is string => Boolean(line)).join("\n");
    return {
      taskId: input.taskEnvelope.taskId,
      status: isInfraAbort ? "failed" : "partial",
      summary,
      evidenceRefs: dedupeStrings([
        ...(signal?.evidenceRefs ?? []),
        ...observations.flatMap((observation) => observation.sourceEventIds),
        ...(state?.lastObserverProjection?.graphDelta.sourceEventIds ?? [])
      ]),
      artifactRefs,
      suggestedNextGoal: !isInfraAbort && signal && ["checkpoint", "need_planner", "stop_executor"].includes(signal.decision)
        ? "Planner should read the updated graph and create the next goal-level task if needed."
        : undefined,
      checkpointReason: signal?.reason,
      retryable: isInfraAbort ? true : signal?.decision !== "stop_executor",
      attempt: state?.attempt ?? this.nextTaskAttempt(input.taskEnvelope.taskId),
      resumeCursor: state?.lastEventId,
      lastEventId: state?.lastEventId
    };
  }

  private async enrichTaskResultLifecycle(
    taskResult: TaskResult,
    taskEnvelope: TaskEnvelope,
    state = this.getActiveTaskState(taskEnvelope.taskId)
  ): Promise<TaskResult> {
    const checkpointReason = taskResult.checkpointReason
      ?? state?.controlSignal?.reason
      ?? (taskResult.status === "partial" ? "Executor returned a partial epoch result" : undefined);
    const retryable = typeof taskResult.retryable === "boolean"
      ? taskResult.retryable
      : taskResult.status === "partial";
    const lastEventId = state?.lastEventId;
    const submittedEvidenceRefs = taskResult.evidenceRefs.filter((ref) => (
      this.executionLog.seqForEvent(ref) !== undefined
      || this.graphStore.trace({ nodeId: ref }).nodes.some((node) => node.id === ref)
    ));
    const submittedArtifactRefs: string[] = [];
    for (const artifactRef of taskResult.artifactRefs) {
      if (await this.artifactStore.get(artifactRef)) {
        submittedArtifactRefs.push(artifactRef);
      }
    }
    const epochEvents = state
      ? (await this.executionLog.window({
        epochId: state.epochId,
        limit: 256,
        roles: ["executor", "runtime"],
        eventTypes: ["assistant_intent", "tool_started", "tool_finished", "provider_error"]
      })).events
      : [];
    const epochObservations = buildProjectionObservations(epochEvents);
    const evidenceRefs = dedupeStrings([
      ...submittedEvidenceRefs,
      ...epochObservations.flatMap((observation) => observation.sourceEventIds)
    ]);
    const artifactRefs = dedupeStrings([
      ...submittedArtifactRefs,
      ...epochObservations.flatMap((observation) => observation.artifactRefs)
    ]);
    return {
      ...taskResult,
      evidenceRefs,
      artifactRefs,
      checkpointReason,
      retryable,
      attempt: state?.attempt ?? this.nextTaskAttempt(taskEnvelope.taskId),
      resumeCursor: lastEventId,
      lastEventId
    };
  }

  private nextTaskAttempt(taskId: string): number {
    return this.runtimeStore.countTaskEpochs(taskId) + 1;
  }

  private getTaskStatusSnapshot(taskId: string): Record<string, unknown> | undefined {
    const taskNode = this.graphStore
      .query("task", [taskId], 1)
      .nodes
      .find((node) => node.id === taskId);
    return taskNode?.properties;
  }

  private async createDependencyOutcomeBrief(taskEnvelope: TaskEnvelope): Promise<string> {
    const dependencyTaskIds = taskEnvelope.dependsOnTaskRefs ?? [];
    if (dependencyTaskIds.length === 0) {
      return "无直接依赖任务结果。";
    }
    const briefs = await Promise.all(dependencyTaskIds.map(async (dependencyTaskId) => {
      const taskNode = this.graphStore.getTaskNode(dependencyTaskId);
      if (!taskNode) {
        return `${dependencyTaskId}: 图中不存在。`;
      }
      const dependencyEnvelope = this.graphStore.getTaskEnvelope(dependencyTaskId);
      const dependencyContext = dependencyEnvelope
        ? this.graphStore.projectionClosure({
          taskId: dependencyTaskId,
          scopeRef: dependencyEnvelope.scopeRef,
          dependencyTaskIds: dependencyEnvelope.dependsOnTaskRefs,
          targetRefs: dependencyEnvelope.targetRefs,
          nodeLimit: 18,
          edgeLimit: 30
        })
        : this.graphStore.trace({ nodeId: dependencyTaskId });
      const reusableAssets = dependencyContext.nodes
        .filter((node) => node.graphKind === "operation" && [
          "Host", "Service", "WebEndpoint", "Credential", "Session", "File"
        ].includes(node.type))
        .slice(0, 8)
        .map((node) => `${node.type}:${node.id}:${truncateText(node.label, 180)}`);
      const reusableClaims = dependencyContext.nodes
        .filter((node) => node.graphKind === "reasoning" && ["Vulnerability", "Exploit"].includes(node.type))
        .slice(0, 5)
        .map((node) => `${node.type}:${node.id}:${truncateText(node.label, 180)}`);
      const dependencyEvents = await this.executionLog.window({
        taskId: dependencyTaskId,
        limit: 96,
        roles: ["executor", "runtime"],
        eventTypes: [
          "assistant_intent",
          "tool_started",
          "tool_finished",
          "task_completed",
          "task_partial",
          "task_failed"
        ]
      });
      const capabilities = capabilityDigest(buildProjectionObservations(dependencyEvents.events), 1200);
      const properties = taskNode.properties;
      return [
        `${dependencyTaskId} status=${String(properties.status ?? "unknown")}`,
        properties.resultSummary ? `  result: ${truncateText(String(properties.resultSummary), 700)}` : undefined,
        properties.checkpointReason ? `  checkpoint: ${truncateText(String(properties.checkpointReason), 300)}` : undefined,
        capabilities ? `  capabilities:\n${capabilities.split("\n").map((line) => `    ${line}`).join("\n")}` : undefined,
        reusableAssets.length > 0 ? `  reusable: ${reusableAssets.join("；")}` : undefined,
        reusableClaims.length > 0 ? `  confirmed: ${reusableClaims.join("；")}` : undefined,
        stringArrayProperty(properties.evidenceRefs).length > 0
          ? `  evidence: ${stringArrayProperty(properties.evidenceRefs).slice(0, 5).join(", ")}`
          : undefined,
        stringArrayProperty(properties.artifactRefs).length > 0
          ? `  artifacts: ${stringArrayProperty(properties.artifactRefs).slice(0, 5).join(", ")}`
          : undefined
      ].filter((line): line is string => Boolean(line)).join("\n");
    }));
    return briefs.join("\n");
  }

}

function admitReadyTasks(candidates: TaskEnvelope[], maxParallelTasks: number): TaskEnvelope[] {
  if (candidates.length <= 1) {
    return candidates.slice(0, maxParallelTasks);
  }
  const admitted: TaskEnvelope[] = [];
  const occupiedSessions = new Set<string>();
  for (const candidate of candidates) {
    const sessionRefs = candidate.availableSessionRefs ?? [];
    const conflicts = sessionRefs.some((sessionRef) => occupiedSessions.has(sessionRef));
    if (conflicts) {
      continue;
    }
    admitted.push(candidate);
    sessionRefs.forEach((sessionRef) => occupiedSessions.add(sessionRef));
    if (admitted.length >= maxParallelTasks) {
      break;
    }
  }
  return admitted.length > 0 ? admitted : candidates.slice(0, 1);
}

function terminationReasonForTaskResult(
  taskResult: TaskResult,
  state: ActiveTaskState
): ActiveTaskState["terminationReason"] {
  if (state.abortContext?.kind === "budget_abort") {
    return state.abortContext.reason.startsWith("Epoch time slice reached:")
      ? "time_slice_exhausted"
      : "budget_exhausted";
  }
  if (state.abortContext?.kind === "observer_abort") {
    return "supervisor_checkpoint";
  }
  if (taskResult.retryable && /provider|concurrency|rate limit|timeout/i.test(taskResult.checkpointReason ?? taskResult.summary)) {
    return "provider_error";
  }
  return "executor_submitted";
}

function normalizeParallelTaskLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_PARALLEL_TASKS;
  }
  return Math.max(1, Math.min(Math.floor(value), 8));
}

function normalizeRunTimeBudgetMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_RUN_TIME_BUDGET_MS;
  }
  return Math.max(60_000, Math.floor(value));
}

function normalizeGraphDelta(delta: Partial<GraphDelta>): GraphDelta {
  return {
    sourceEventIds: Array.isArray(delta.sourceEventIds) ? delta.sourceEventIds : [],
    nodes: Array.isArray(delta.nodes)
      ? delta.nodes.map((node) => ({
        ...node,
        properties: node.properties ?? {}
      }))
      : [],
    edges: Array.isArray(delta.edges) ? delta.edges : []
  };
}

export function normalizeObserverProjection(value: unknown, defaultSourceEventIds: string[] = []): ObserverProjection {
  const record = isRecord(value) ? value : {};
  const rawGraphDelta = isRecord(record.graphDelta) ? record.graphDelta : record;
  const graphDelta = withDefaultSourceEventIds(
    normalizeGraphDelta(rawGraphDelta as Partial<GraphDelta>),
    defaultSourceEventIds
  );
  const rawControlSignal = isRecord(record.controlSignal) ? record.controlSignal : undefined;
  return {
    graphDelta,
    controlSignal: normalizeControlSignal(rawControlSignal, graphDelta.sourceEventIds)
  };
}

export function normalizeSupervisorControlSignal(value: unknown, defaultEvidenceRefs: string[] = []): ControlSignal {
  const record = isRecord(value) ? value : {};
  const rawControlSignal = isRecord(record.controlSignal) ? record.controlSignal : record;
  return normalizeControlSignal(rawControlSignal, defaultEvidenceRefs);
}

export function normalizeProjectorGraphDelta(value: unknown, defaultSourceEventIds: string[] = []): GraphDelta {
  return normalizeObserverProjection(value, defaultSourceEventIds).graphDelta;
}

function normalizeControlSignal(signal: Record<string, unknown> | undefined, fallbackEvidenceRefs: string[]): ControlSignal {
  const decision = typeof signal?.decision === "string" && isControlSignalDecision(signal.decision)
    ? signal.decision
    : "continue";
  const confidence = typeof signal?.confidence === "string" && ["low", "medium", "high"].includes(signal.confidence)
    ? signal.confidence as ControlSignal["confidence"]
    : undefined;
  const rawBudgetExtension = isRecord(signal?.budgetExtension) ? signal.budgetExtension : undefined;
  const maxTurnsDelta = typeof rawBudgetExtension?.maxTurnsDelta === "number" && Number.isFinite(rawBudgetExtension.maxTurnsDelta)
    ? Math.floor(rawBudgetExtension.maxTurnsDelta)
    : undefined;
  const budgetExtension = maxTurnsDelta && maxTurnsDelta > 0
    ? {
      maxTurnsDelta,
      reason: typeof rawBudgetExtension?.reason === "string" ? rawBudgetExtension.reason : undefined
    }
    : undefined;
  return {
    decision,
    reason: typeof signal?.reason === "string" && signal.reason.trim().length > 0
      ? signal.reason
      : CONTINUE_CONTROL_SIGNAL.reason,
    evidenceRefs: Array.isArray(signal?.evidenceRefs)
      ? signal.evidenceRefs.filter((ref): ref is string => typeof ref === "string")
      : fallbackEvidenceRefs,
    confidence,
    budgetExtension
  };
}

export function normalizeTaskBudget(input?: TaskBudget): Required<TaskBudget> {
  return {
    maxTurns: normalizeBudgetNumber(
      input?.maxTurns,
      DEFAULT_TASK_BUDGET.maxTurns,
      MAX_TASK_BUDGET.maxTurns,
      MIN_TASK_BUDGET.maxTurns
    )
  };
}

function normalizeBudgetNumber(value: unknown, defaultValue: number, maxValue: number, minValue = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return defaultValue;
  }
  return Math.max(minValue, Math.min(Math.floor(value), maxValue));
}

export function shouldStopExecutorForControlSignal(controlSignal: ControlSignal): boolean {
  return ["checkpoint", "stop_executor", "need_planner"].includes(controlSignal.decision);
}

function isGracefulCheckpointSignal(controlSignal: ControlSignal): boolean {
  return ["checkpoint", "need_planner"].includes(controlSignal.decision);
}

function isRetryableProjectionError(error: unknown): boolean {
  if (error instanceof StructuredInvocationError) {
    return error.code === "timeout" || error.code === "provider_error" || error.code === "missing_submit";
  }
  if (error instanceof PromptRuntimeError) {
    return isRetryableLlmErrorKind(error.errorKind);
  }
  const message = errorMessageFromUnknown(error);
  return Boolean(message && isRetryableLlmErrorKind(classifyLlmErrorKind(message)));
}

export function classifyPlannerProviderFailure(error: unknown): RetryableProviderFailure {
  const message = errorMessageFromUnknown(error) ?? "Planner invocation failed";
  if (error instanceof StructuredInvocationError) {
    if (error.code === "timeout") {
      return { errorKind: "provider_timeout", message, retryable: true };
    }
    if (error.code === "provider_error") {
      return { errorKind: classifyLlmErrorKind(message), message, retryable: true };
    }
    if (error.code === "invalid_submit") {
      return { errorKind: "llm_error", message, retryable: true };
    }
    if (error.code === "missing_submit") {
      // The model exhausted its completion budget (typically on reasoning)
      // before emitting the terminating tool call. Retrying with a fresh
      // session and an explicit submit-first nudge usually recovers; a single
      // silent Planner turn must never be run-fatal.
      return { errorKind: "missing_submit", message, retryable: true };
    }
    return { errorKind: "llm_error", message, retryable: false };
  }
  if (error instanceof PromptRuntimeError) {
    return {
      errorKind: error.errorKind,
      message,
      retryable: isRetryableLlmErrorKind(error.errorKind)
    };
  }
  const errorKind = classifyLlmErrorKind(message);
  return { errorKind, message, retryable: isRetryableLlmErrorKind(errorKind) };
}

function isRetryablePlannerInvocationError(error: unknown): boolean {
  return classifyPlannerProviderFailure(error).retryable;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function createRuntimeAbortContext(controlSignal: ControlSignal): RuntimeAbortContext {
  return {
    kind: runtimeAbortKindForControlSignal(controlSignal),
    reason: controlSignal.reason,
    controlSignal
  };
}

function runtimeAbortKindForControlSignal(controlSignal: ControlSignal): RuntimeAbortContext["kind"] {
  if (controlSignal.reason.startsWith("Task budget reached:") || controlSignal.reason.startsWith("Epoch time slice reached:")) {
    return "budget_abort";
  }
  if (controlSignal.decision === "stop_executor") {
    return "controller_abort";
  }
  return "observer_abort";
}

function normalizeTaskResult(result: Partial<TaskResult>, taskEnvelope: TaskEnvelope): TaskResult {
  const submittedStatus = isTaskResultStatus(result.status) ? result.status : "partial";
  const status = submittedStatus === "blocked" ? "partial" : submittedStatus;
  return {
    taskId: taskEnvelope.taskId,
    status,
    summary: typeof result.summary === "string" && result.summary.trim().length > 0
      ? result.summary
      : "Executor returned a TaskResult without summary",
    evidenceRefs: Array.isArray(result.evidenceRefs) ? result.evidenceRefs.filter((ref): ref is string => typeof ref === "string") : [],
    artifactRefs: Array.isArray(result.artifactRefs) ? result.artifactRefs.filter((ref): ref is string => typeof ref === "string") : [],
    blockerReason: typeof result.blockerReason === "string" ? result.blockerReason : undefined,
    suggestedNextGoal: typeof result.suggestedNextGoal === "string" ? result.suggestedNextGoal : undefined,
    checkpointReason: typeof result.checkpointReason === "string"
      ? result.checkpointReason
      : submittedStatus === "blocked" && typeof result.blockerReason === "string"
        ? result.blockerReason
        : undefined,
    retryable: typeof result.retryable === "boolean" ? result.retryable : undefined,
    attempt: typeof result.attempt === "number" && Number.isFinite(result.attempt) ? Math.floor(result.attempt) : undefined,
    resumeCursor: typeof result.resumeCursor === "string" ? result.resumeCursor : undefined,
    lastEventId: typeof result.lastEventId === "string" ? result.lastEventId : undefined
  };
}

function controlSignalForTaskResult(taskResult: TaskResult, evidenceRefs: string[]): ControlSignal {
  if (taskResult.status === "partial") {
    return {
      decision: "need_planner",
      reason: taskResult.checkpointReason ?? taskResult.summary,
      evidenceRefs,
      confidence: "medium"
    };
  }
  return {
    decision: "continue",
    reason: taskResult.summary,
    evidenceRefs,
    confidence: "medium"
  };
}

function classifyExecutorProviderFailure(
  executorError: unknown,
  parseError: unknown,
  executorOutput: string
): RetryableProviderFailure | undefined {
  const message = errorMessageFromUnknown(executorError)
    ?? providerMessageFromOutput(executorOutput)
    ?? errorMessageFromUnknown(parseError);
  if (!message) {
    return undefined;
  }
  const errorKind = executorError instanceof PromptRuntimeError
    ? executorError.errorKind
    : classifyLlmErrorKind(message);
  return {
    errorKind,
    message,
    retryable: isRetryableLlmErrorKind(errorKind)
  };
}

function providerMessageFromOutput(output: string): string | undefined {
  if (!/concurrency limit|rate limit|too many requests|\b429\b|\b5\d\d\b|bad gateway|service unavailable|timed out|timeout/i.test(output)) {
    return undefined;
  }
  return output.slice(0, 500);
}

function errorMessageFromUnknown(error: unknown): string | undefined {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : typeof error === "string" && error.trim().length > 0
      ? error
      : undefined;
}

function projectionRequestPriority(input: ObserverProjectionRequest): number {
  if (input.reason === "task_end") {
    return 100;
  }
  if (input.taskResult) {
    return 90;
  }
  if (input.reason.startsWith(PROJECT_WINDOW_REASON_PREFIX)) {
    return 10;
  }
  return 1;
}

function turnWindowCount(reason: string): number | undefined {
  if (!reason.startsWith(TURN_WINDOW_REASON_PREFIX)) {
    return undefined;
  }
  const count = Number.parseInt(reason.slice(TURN_WINDOW_REASON_PREFIX.length), 10);
  return Number.isFinite(count) ? count : undefined;
}

function selectRecentExecutorTurnEvents(events: ExecutionEvent[], maxTurns: number): ExecutionEvent[] {
  const ordered = [...events].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  let turnsSeen = 0;
  let startIndex = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (["turn_usage", "turn_end"].includes(ordered[index]?.eventType ?? "")) {
      turnsSeen += 1;
      if (turnsSeen > maxTurns) {
        startIndex = index + 1;
        break;
      }
    }
  }
  return ordered.slice(startIndex).filter((event) => event.eventType !== "turn_usage");
}

function createInitialTaskSupervisionState(taskEnvelope: TaskEnvelope): TaskSupervisionState {
  return {
    taskId: taskEnvelope.taskId,
    phase: inferTaskPhase(taskEnvelope.goal),
    progressDigest: "尚无监督摘要；等待 Executor 产生执行事件。",
    repeatedPatterns: [],
    negativeFindings: [],
    recentFingerprints: [],
    openQuestions: taskEnvelope.successCriteria.length > 0
      ? [`成功条件：${taskEnvelope.successCriteria.join("；")}`]
      : ["成功条件未显式提供。"]
  };
}

function restoreTaskSupervisionState(
  taskEnvelope: TaskEnvelope,
  taskStatus: Record<string, unknown> | undefined,
  previous: TaskSupervisionState | undefined
): TaskSupervisionState {
  if (previous) {
    return {
      ...cloneTaskSupervisionState(previous),
      taskId: taskEnvelope.taskId,
      phase: inferTaskPhase(taskEnvelope.goal),
      openQuestions: taskEnvelope.successCriteria.length > 0
        ? [`成功条件：${taskEnvelope.successCriteria.join("；")}`]
        : previous.openQuestions
    };
  }
  const initial = createInitialTaskSupervisionState(taskEnvelope);
  const resultSummary = stringProperty(taskStatus?.resultSummary);
  const checkpointReason = stringProperty(taskStatus?.checkpointReason);
  const blockerReason = stringProperty(taskStatus?.blockerReason);
  if (resultSummary) {
    initial.progressDigest = `上一阶段结果：${truncateText(resultSummary, 240)}`;
  }
  for (const negativeFinding of [checkpointReason, blockerReason]) {
    if (negativeFinding) {
      appendLimitedUnique(initial.negativeFindings, truncateText(negativeFinding, 160), 6);
    }
  }
  return initial;
}

function cloneTaskSupervisionState(state: TaskSupervisionState): TaskSupervisionState {
  return {
    ...state,
    repeatedPatterns: [...state.repeatedPatterns],
    negativeFindings: [...state.negativeFindings],
    recentFingerprints: [...state.recentFingerprints],
    openQuestions: [...state.openQuestions]
  };
}

function updateTaskSupervisionState(
  supervisionState: TaskSupervisionState,
  event: ExecutionEvent
): void {
  if (event.eventType === "tool_finished" || event.eventType === "tool_execution_end") {
    const toolName = stringProperty((event.payload as { toolName?: unknown } | undefined)?.toolName);
    const resultText = eventText(event).slice(0, 240);
    const fingerprint = toolResultFingerprint(event);
    const repeated = Boolean(fingerprint && supervisionState.recentFingerprints.includes(fingerprint));
    supervisionState.progressDigest = [
      `最近工具完成：${toolName ?? "unknown"}`,
      resultText ? `结果摘要：${resultText}` : undefined,
      fingerprint ? `工具输出指纹：${repeated ? "重复出现" : "此前未见"}；指纹变化不代表语义进展` : undefined
    ].filter(Boolean).join("；");
    if (fingerprint) {
      if (repeated) {
        appendLimitedUnique(supervisionState.repeatedPatterns, fingerprint, 6);
      }
      supervisionState.recentFingerprints.push(fingerprint);
      while (supervisionState.recentFingerprints.length > 12) {
        supervisionState.recentFingerprints.shift();
      }
    }
    if ((event.payload as { isError?: unknown }).isError === true) {
      appendLimitedUnique(supervisionState.negativeFindings, resultText.slice(0, 160) || `${toolName}:error`, 6);
    }
    return;
  }
  if (["turn_usage", "assistant_intent", "turn_end", "message_end"].includes(event.eventType)) {
    const text = eventText(event).slice(0, 240);
    if (text) {
      supervisionState.progressDigest = `最近思考/消息：${text}`;
    }
    return;
  }
  if (["task_partial", "task_blocked", "task_failed", "task_completed"].includes(event.eventType)) {
    const summary = event.summary ?? eventText(event).slice(0, 240);
    supervisionState.progressDigest = `任务阶段结果：${summary}`;
    if (event.eventType === "task_blocked" || event.eventType === "task_failed") {
      appendLimitedUnique(supervisionState.negativeFindings, summary, 6);
    }
  }
}

function inferTaskPhase(goal: string): TaskSupervisionState["phase"] {
  const normalized = goal.toLowerCase();
  if (/recon|enumerat|discover|侦察|枚举|探测/.test(normalized)) {
    return "recon";
  }
  if (/exploit|bypass|ssrf|sqli|rce|利用|绕过|注入/.test(normalized)) {
    return "exploit";
  }
  if (/verify|validate|confirm|验证|确认/.test(normalized)) {
    return "verify";
  }
  if (/flag|extract|read|读取|提取/.test(normalized)) {
    return "extract";
  }
  return "unknown";
}

function toolResultFingerprint(event: ExecutionEvent): string | undefined {
  const payload = event.payload as { toolName?: unknown; result?: unknown; isError?: unknown } | undefined;
  const toolName = stringProperty(payload?.toolName) ?? "tool";
  const text = eventText(event);
  if (!text) {
    return `${toolName}:empty:${payload?.isError === true ? "error" : "ok"}`;
  }
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return `${toolName}:${payload?.isError === true ? "error" : "ok"}:${text.length}:${digest}`;
}

function eventText(event: ExecutionEvent): string {
  const texts: string[] = [];
  collectTextFragments(event.payload, texts, 6);
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

function collectTextFragments(value: unknown, output: string[], limit: number): void {
  if (output.length >= limit || value === undefined || value === null) {
    return;
  }
  if (typeof value === "string") {
    if (value.trim().length > 0) {
      output.push(value.trim());
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) {
      collectTextFragments(item, output, limit);
      if (output.length >= limit) {
        return;
      }
    }
    return;
  }
  if (isRecord(value)) {
    for (const key of ["summary", "text", "command", "error", "stdout", "stderr", "content", "result", "partialResult", "message"]) {
      if (key in value) {
        collectTextFragments(value[key], output, limit);
        if (output.length >= limit) {
          return;
        }
      }
    }
  }
}

function supervisionStateForPrompt(state: TaskSupervisionState): Omit<TaskSupervisionState, "recentFingerprints"> {
  const { recentFingerprints: _recentFingerprints, ...promptState } = state;
  return promptState;
}

function appendLimitedUnique(values: string[], value: string, limit: number): void {
  const normalized = value.trim();
  if (!normalized || values.includes(normalized)) {
    return;
  }
  values.push(normalized);
  while (values.length > limit) {
    values.shift();
  }
}

function truncateText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 24))}...[truncated:${normalized.length}]`;
}

function truncateOneLine(value: string, limit: number): string {
  return truncateText(value, limit);
}

function isRuntimeContextArtifact(preview: string): boolean {
  const normalized = preview.trim();
  return normalized.startsWith("OBSERVATION_SEED:")
    || normalized.startsWith("TASK_ENVELOPE:")
    || normalized.startsWith("USER_GOAL:")
    || normalized.startsWith("你正在监督当前 Executor")
    || (normalized.startsWith("---") && /\nname:\s*(ctf-|solve-challenge|skill)/i.test(normalized))
    || /allowed-tools:|# CTF Web Exploitation|# AGENTS\.md/i.test(normalized)
    || (normalized.startsWith("{") && normalized.includes("\"events\"") && normalized.includes("\"eventType\""));
}

function stringArrayProperty(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringProperty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isControlSignalDecision(value: string): value is ControlSignal["decision"] {
  return ["continue", "checkpoint", "stop_executor", "need_planner"].includes(value);
}

function isTaskResultStatus(value: unknown): value is TaskResultStatus {
  return ["completed", "partial", "blocked", "failed"].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withDefaultSourceEventIds(delta: GraphDelta, defaultSourceEventIds: string[]): GraphDelta {
  if (delta.sourceEventIds.length > 0 || defaultSourceEventIds.length === 0) {
    return delta;
  }
  return {
    ...delta,
    sourceEventIds: defaultSourceEventIds
  };
}

export function compactExecutorGraphClosure(
  closure: ReturnType<SQLiteGraphStore["projectionClosure"]>,
  graphKind: "operation" | "reasoning",
  limit: number
) {
  const nodes = closure.nodes.filter((node) => node.graphKind === graphKind).slice(0, limit).map((node) => ({
    id: node.id,
    type: node.type,
    label: truncateText(node.label, 220),
    properties: compactNodeProperties(node.type, node.properties),
    evidenceRefs: (node.evidenceRefs ?? []).slice(0, 6)
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: closure.edges
      .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
      .slice(0, 20)
      .map((edge) => ({ from: edge.from, to: edge.to, type: edge.type }))
  };
}

function compactNodeProperties(type: string, properties: Record<string, unknown>): Record<string, unknown> {
  const commonKeys = [
    "status",
    "host",
    "port",
    "protocol",
    "service",
    "url",
    "path",
    "method",
    "name",
    "username",
    "role",
    "valid",
    "confidence",
    "resultSummary",
    "checkpointReason",
    "blockerReason"
  ];
  const keysByType: Record<string, string[]> = {
    Host: ["address", "ip", "hostname"],
    Port: ["port", "protocol", "state"],
    Service: ["scheme", "server", "technology", "baseUrl"],
    WebEndpoint: ["path", "url", "method", "status", "requires_auth", "role_observed"],
    Parameter: ["name", "location", "examples", "flag_path_probe_result"],
    Credential: ["username", "password", "role", "source", "valid"],
    Session: ["username", "role", "principal", "cookieName", "cookie_name", "authenticated", "valid"],
    File: ["path", "size", "hash", "mediaType"],
    Process: ["pid", "command", "user"],
    Evidence: [
      "target", "endpoint", "parameter", "method", "accessMethod", "precondition", "result",
      "statusCode", "negativeFindings", "negative_flag_findings", "interesting_paths"
    ],
    Hypothesis: ["basis", "target", "endpointLocated", "preconditions"],
    Vulnerability: ["affectedEndpoint", "affectedParameter", "authenticatedRole", "preconditions", "impact"],
    Exploit: ["sessionRole", "preconditions", "effect", "readFiles", "createdSession", "nonDestructive"]
  };
  const allowedKeys = dedupeStrings([...commonKeys, ...(keysByType[type] ?? [])]);
  return Object.fromEntries(
    allowedKeys
      .filter((key) => properties[key] !== undefined)
      .map((key) => [key, compactExecutorProperty(properties[key])])
  );
}

function compactExecutorProperty(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateText(value, 300);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => typeof item === "string" ? truncateText(item, 180) : item);
  }
  return value;
}

function createExecutionBrief(
  taskEnvelope: TaskEnvelope,
  events: ExecutionEvent[],
  taskStatus?: Record<string, unknown>
): string {
  const trace = summarizeSupervisorTrace(events);
  return [
    `当前业务状态：${String(taskStatus?.status ?? "open")}`,
    taskStatus?.resultSummary ? `上一阶段结果：${truncateText(String(taskStatus.resultSummary), 500)}` : undefined,
    taskStatus?.checkpointReason ? `上次 checkpoint：${truncateText(String(taskStatus.checkpointReason), 300)}` : undefined,
    taskStatus?.plannerReason ? `Planner 续接提示：${truncateText(String(taskStatus.plannerReason), 500)}` : undefined,
    taskStatus?.blockerReason ? `已知阻塞：${truncateText(String(taskStatus.blockerReason), 300)}` : undefined,
    taskStatus?.resumeCursor ? `续接位置：${String(taskStatus.resumeCursor)}` : undefined,
    `尚需满足：${taskEnvelope.successCriteria.join("；") || "未显式定义"}`,
    "最近规范动作：",
    trace.actionTraceText,
    "近期循环信号：",
    trace.loopSignalsText
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function createFallbackObserverDelta(
  _taskEnvelope: TaskEnvelope,
  _taskResult: TaskResult | undefined,
  sourceEventIds: string[],
  _reason = "observer_projection_failed"
): GraphDelta {
  return {
    sourceEventIds,
    nodes: [],
    edges: []
  };
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function ensureTaskBudget(taskEnvelope: TaskEnvelope): Required<TaskBudget> {
  const budget = normalizeTaskBudget(taskEnvelope.budget);
  taskEnvelope.budget = budget;
  return budget;
}

function budgetStatusSnapshot(taskEnvelope: TaskEnvelope, state?: ActiveTaskState): Record<string, unknown> {
  const budget = normalizeTaskBudget(taskEnvelope.budget);
  const usedTurns = state?.turnEndCount ?? 0;
  const remaining = Math.max(0, budget.maxTurns - usedTurns);
  return {
    taskId: taskEnvelope.taskId,
    budget: { maxTurns: budget.maxTurns },
    usedTurns,
    remainingTurns: remaining,
    nearTurnLimit: remaining <= BUDGET_PRESSURE_TURNS,
    stopRequested: state?.executorStopRequested ?? false,
    abortReason: state?.abortContext?.reason,
    budgetExtensionCount: state?.budgetExtensionCount ?? 0,
    maxBudgetExtensions: MAX_BUDGET_EXTENSIONS,
    globalRemainingMs: state?.runDeadlineAt === undefined
      ? undefined
      : Math.max(0, state.runDeadlineAt - Date.now()),
    epochRemainingMs: state?.epochDeadlineAt === undefined
      ? undefined
      : Math.max(0, state.epochDeadlineAt - Date.now()),
    epochTimeLimitMs: state?.epochTimeLimitMs,
    lastControlSignal: state?.controlSignal,
    lastEventId: state?.lastEventId
  };
}

function remainingTurns(taskEnvelope: TaskEnvelope, state: ActiveTaskState): number {
  const budget = normalizeTaskBudget(taskEnvelope.budget);
  return Math.max(0, budget.maxTurns - state.turnEndCount);
}

function budgetStatusSteerKey(
  input: {
    reason: string;
    force?: boolean;
  },
  status: Record<string, unknown>
): string | undefined {
  const remaining = typeof status.remainingTurns === "number" ? status.remainingTurns : undefined;
  if (input.force) {
    const budget = status.budget as { maxTurns?: number } | undefined;
    return `force:${input.reason}:maxTurns=${budget?.maxTurns ?? "unknown"}:extensions=${status.budgetExtensionCount ?? 0}`;
  }
  if (remaining !== undefined && remaining > 0 && remaining <= BUDGET_PRESSURE_TURNS) {
    return `remainingTurns:${remaining}`;
  }
  const epochRemainingMs = typeof status.epochRemainingMs === "number" ? status.epochRemainingMs : undefined;
  if (epochRemainingMs !== undefined && epochRemainingMs > 0 && epochRemainingMs <= 120_000) {
    return `epochRemainingBucket:${Math.ceil(epochRemainingMs / 30_000)}`;
  }
  const globalRemainingMs = typeof status.globalRemainingMs === "number" ? status.globalRemainingMs : undefined;
  if (globalRemainingMs !== undefined && globalRemainingMs > 0 && globalRemainingMs <= 120_000) {
    return `globalRemainingBucket:${Math.ceil(globalRemainingMs / 30_000)}`;
  }
  return undefined;
}

function formatExecutorBudgetStatus(
  taskEnvelope: TaskEnvelope,
  state: ActiveTaskState,
  reason: string,
  update = false
): string {
  const status = budgetStatusSnapshot(taskEnvelope, state);
  const budget = status.budget as { maxTurns?: number };
  const yesNo = (value: unknown): string => value === true ? "yes" : "no";
  return [
    update ? "RUNTIME_BUDGET_STATUS_UPDATE" : "RUNTIME_BUDGET_STATUS",
    `reason: ${reason}`,
    `turns: ${status.usedTurns}/${budget.maxTurns ?? "unknown"}; remaining: ${status.remainingTurns}`,
    `globalRemainingMs: ${status.globalRemainingMs ?? "unbounded"}`,
    `epochRemainingMs: ${status.epochRemainingMs ?? "unbounded"}; epochTimeLimitMs: ${status.epochTimeLimitMs ?? "unbounded"}`,
    `nearTurnLimit: ${yesNo(status.nearTurnLimit)}`,
    `extensions: ${status.budgetExtensionCount}/${status.maxBudgetExtensions}`,
    `stopRequested: ${yesNo(status.stopRequested)}${status.abortReason ? `; abortReason: ${status.abortReason}` : ""}`,
    "Rule: if stopRequested=yes, remaining<=0, or epochRemainingMs is near zero, immediately return a phase TaskResult; otherwise continue within scope."
  ].join("\n");
}

function readPiSessionStats(session: SecurityAgentSession): PiSessionStatsSnapshot | undefined {
  const candidate = session as unknown as { getSessionStats?: () => PiSessionStatsSnapshot };
  if (typeof candidate.getSessionStats !== "function") {
    return undefined;
  }
  try {
    return candidate.getSessionStats();
  } catch {
    return undefined;
  }
}

function diffPiSessionStats(
  before: PiSessionStatsSnapshot | undefined,
  after: PiSessionStatsSnapshot
): Record<string, unknown> & {
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { total: number };
  };
} {
  const delta = (current: number, previous = 0): number => Math.max(0, current - previous);
  const input = delta(after.tokens.input, before?.tokens.input);
  const output = delta(after.tokens.output, before?.tokens.output);
  const cacheRead = delta(after.tokens.cacheRead, before?.tokens.cacheRead);
  const cacheWrite = delta(after.tokens.cacheWrite, before?.tokens.cacheWrite);
  return {
    userMessages: delta(after.userMessages, before?.userMessages),
    assistantMessages: delta(after.assistantMessages, before?.assistantMessages),
    toolCalls: delta(after.toolCalls, before?.toolCalls),
    toolResults: delta(after.toolResults, before?.toolResults),
    totalMessages: delta(after.totalMessages, before?.totalMessages),
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { total: delta(after.cost, before?.cost) }
    }
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`Timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function disposeSession(session: SecurityAgentSession): void {
  const candidate = session as unknown as { dispose?: () => void; abort?: () => Promise<void> };
  if (typeof candidate.dispose === "function") {
    candidate.dispose();
    return;
  }
  void candidate.abort?.();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
