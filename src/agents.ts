import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type ToolDefinition,
  type CreateAgentSessionResult
} from "@earendil-works/pi-coding-agent";
import {
  EXECUTOR_SYSTEM_PROMPT,
  OBSERVER_PROJECTOR_SYSTEM_PROMPT,
  OBSERVER_SUPERVISOR_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT
} from "./prompts.js";
import { ArtifactStore } from "./stores/artifact-store.js";
import { ExecutionLog } from "./stores/execution-log.js";
import { SQLiteGraphStore } from "./stores/graph-store.js";
import type { LlmRuntime } from "./llm-config.js";
import { normalizePlannerDecision } from "./planner-commands.js";
import { createExecutorSandbox, type ExecutorSandbox } from "./executor-sandbox.js";
import type { ObserverMode } from "./types.js";
import {
  createArtifactReadTool,
  createArtifactWriteTool,
  createControlSubmitTool,
  createGraphDeltaSubmitTool,
  createGraphQueryTool,
  createGraphTraceTool,
  createPlannerSubmitTool,
  createTaskResultSubmitTool
} from "./tools/pi-tools.js";
import {
  createVulnerabilitySearchTool,
  createWebFetchTool,
  createWebSearchTool
} from "./tools/research-tools.js";

export type SecurityAgentRuntime = {
  planner: CreateAgentSessionResult["session"];
  executor: CreateAgentSessionResult["session"];
  observer: CreateAgentSessionResult["session"];
};

export type SecurityAgentSession = CreateAgentSessionResult["session"];

export function createExecutorResearchTools() {
  return [
    createWebFetchTool(),
    createWebSearchTool(),
    createVulnerabilitySearchTool()
  ];
}

export async function createSecurityAgentRuntime(input: {
  cwd: string;
  runtimeDir?: string;
  executorSandbox?: ExecutorSandbox;
  graphStore: SQLiteGraphStore;
  executionLog: ExecutionLog;
  artifactStore: ArtifactStore;
  llmRuntime: LlmRuntime;
}): Promise<SecurityAgentRuntime> {
  const plannerLoader = await createPromptLoader(input.cwd, PLANNER_SYSTEM_PROMPT);
  const executorSandbox = input.executorSandbox ?? await createExecutorSandbox({
    runtimeDir: input.runtimeDir ?? `${input.cwd}/.agent-runtime`,
    runId: `standalone-${process.pid}`
  });
  const executorLoader = await createPromptLoader(executorSandbox.root, EXECUTOR_SYSTEM_PROMPT);
  const observerLoader = await createPromptLoader(input.cwd, OBSERVER_SUPERVISOR_SYSTEM_PROMPT);

  const planner = await createAgentSession({
    cwd: input.cwd,
    noTools: "builtin",
    customTools: [
      createGraphQueryTool(input.graphStore),
      createGraphTraceTool(input.graphStore),
      createValidatedPlannerSubmitTool(input.graphStore)
    ],
    authStorage: input.llmRuntime.authStorage,
    modelRegistry: input.llmRuntime.modelRegistry,
    model: input.llmRuntime.models.planner,
    thinkingLevel: input.llmRuntime.roleConfig.planner.thinkingLevel,
    resourceLoader: plannerLoader,
    sessionManager: SessionManager.inMemory(input.cwd)
  });

  const executor = await createExecutorAgentSession({
    cwd: executorSandbox.root,
    sandbox: executorSandbox,
    artifactStore: input.artifactStore,
    llmRuntime: input.llmRuntime,
    executorLoader
  });

  const observer = await createObserverAgentSession({
    cwd: input.cwd,
    graphStore: input.graphStore,
    executionLog: input.executionLog,
    artifactStore: input.artifactStore,
    llmRuntime: input.llmRuntime,
    mode: "supervise",
    observerLoader
  });

  return {
    planner: planner.session,
    executor: executor.session,
    observer: observer.session
  };
}

export async function createExecutorAgentSession(input: {
  cwd: string;
  sandbox?: ExecutorSandbox;
  artifactStore: ArtifactStore;
  llmRuntime: LlmRuntime;
  executorLoader?: DefaultResourceLoader;
  sessionManager?: SessionManager;
}): Promise<CreateAgentSessionResult> {
  const sandbox = input.sandbox ?? await createExecutorSandbox({
    runtimeDir: `${input.cwd}/.agent-runtime`,
    runId: `standalone-${process.pid}`
  });
  const executorLoader = input.executorLoader ?? await createPromptLoader(sandbox.root, EXECUTOR_SYSTEM_PROMPT);
  const customTools: ToolDefinition<any, any, any>[] = [
    ...createExecutorResearchTools(),
    createArtifactReadTool(input.artifactStore),
    createArtifactWriteTool(input.artifactStore),
    createTaskResultSubmitTool()
  ];
  return createAgentSession({
    cwd: sandbox.root,
    noTools: "builtin",
    customTools: [...sandbox.createTools(), ...customTools] as ToolDefinition<any, any, any>[],
    authStorage: input.llmRuntime.authStorage,
    modelRegistry: input.llmRuntime.modelRegistry,
    model: input.llmRuntime.models.executor,
    thinkingLevel: input.llmRuntime.roleConfig.executor.thinkingLevel,
    resourceLoader: executorLoader,
    sessionManager: input.sessionManager ?? SessionManager.inMemory(sandbox.root)
  });
}

export async function createPlannerAgentSession(input: {
  cwd: string;
  graphStore: SQLiteGraphStore;
  llmRuntime: LlmRuntime;
  plannerLoader?: DefaultResourceLoader;
}): Promise<CreateAgentSessionResult> {
  const plannerLoader = input.plannerLoader ?? await createPromptLoader(input.cwd, PLANNER_SYSTEM_PROMPT);
  return createAgentSession({
    cwd: input.cwd,
    noTools: "builtin",
    customTools: [
      createGraphQueryTool(input.graphStore),
      createGraphTraceTool(input.graphStore),
      createValidatedPlannerSubmitTool(input.graphStore)
    ],
    authStorage: input.llmRuntime.authStorage,
    modelRegistry: input.llmRuntime.modelRegistry,
    model: input.llmRuntime.models.planner,
    thinkingLevel: input.llmRuntime.roleConfig.planner.thinkingLevel,
    resourceLoader: plannerLoader,
    sessionManager: SessionManager.inMemory(input.cwd)
  });
}

function createValidatedPlannerSubmitTool(graphStore: SQLiteGraphStore) {
  return createPlannerSubmitTool({
    validate: (value) => graphStore.validatePlannerDecision(normalizePlannerDecision(value))
  });
}

export async function createObserverAgentSession(input: {
  cwd: string;
  graphStore: SQLiteGraphStore;
  executionLog: ExecutionLog;
  artifactStore: ArtifactStore;
  llmRuntime: LlmRuntime;
  mode: ObserverMode;
  observerLoader?: DefaultResourceLoader;
}): Promise<CreateAgentSessionResult> {
  const observerLoader = input.observerLoader ?? await createPromptLoader(
    input.cwd,
    input.mode === "supervise" ? OBSERVER_SUPERVISOR_SYSTEM_PROMPT : OBSERVER_PROJECTOR_SYSTEM_PROMPT
  );
  const observerRole = input.mode === "supervise" ? "supervisor" : "projector";
  return createAgentSession({
    cwd: input.cwd,
    noTools: "builtin",
    customTools: observerToolsForMode(input),
    authStorage: input.llmRuntime.authStorage,
    modelRegistry: input.llmRuntime.modelRegistry,
    model: input.llmRuntime.models[observerRole],
    thinkingLevel: input.llmRuntime.roleConfig[observerRole].thinkingLevel,
    resourceLoader: observerLoader,
    sessionManager: SessionManager.inMemory(input.cwd)
  });
}

export function observerToolsForMode(input: {
  graphStore: SQLiteGraphStore;
  executionLog: ExecutionLog;
  artifactStore: ArtifactStore;
  mode: ObserverMode;
}) {
  if (input.mode === "supervise") {
    return [createControlSubmitTool()];
  }
  return [createGraphDeltaSubmitTool()];
}

async function createPromptLoader(cwd: string, systemPrompt: string): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    systemPromptOverride: () => systemPrompt
  });
  await loader.reload();
  return loader;
}
