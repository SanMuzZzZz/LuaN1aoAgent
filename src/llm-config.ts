import {
  AuthStorage,
  ModelRegistry
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LlmApiType = "openai-completions" | "openai-responses";
export type LlmThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type LlmThinkingFormat =
  | "openai"
  | "openrouter"
  | "deepseek"
  | "together"
  | "zai"
  | "qwen"
  | "chat-template"
  | "qwen-chat-template"
  | "string-thinking"
  | "ant-ling";
export type LlmAgentRole = "planner" | "executor" | "supervisor" | "projector";

export type LlmRoleConfig = {
  modelId: string;
  maxTokens: number;
  thinkingLevel: LlmThinkingLevel;
  baseUrl?: string;
  apiKey?: string;
};

export type LlmRuntimeConfig = {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  apiType: LlmApiType;
  defaultMaxTokens: number;
  defaultThinkingLevel: LlmThinkingLevel;
  thinkingFormat: LlmThinkingFormat;
  roles: Record<LlmAgentRole, LlmRoleConfig>;
};

export type LlmRuntime = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: NonNullable<ReturnType<ModelRegistry["find"]>>;
  models: Record<LlmAgentRole, NonNullable<ReturnType<ModelRegistry["find"]>>>;
  roleConfig: Record<LlmAgentRole, LlmRoleConfig & { provider: string; baseUrl: string }>;
  metadata: {
    provider: string;
    modelId: string;
    baseUrl: string;
    apiType: LlmRuntimeConfig["apiType"];
    costCurrency: "CNY";
    costPerMillionTokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    models: Record<LlmAgentRole, {
      provider: string;
      modelId: string;
      baseUrl: string;
      maxTokens: number;
      thinkingLevel: LlmThinkingLevel;
    }>;
  };
};

const PROVIDER_NAME = "baizhi-openai";
const AGENT_ROLES: LlmAgentRole[] = ["planner", "executor", "supervisor", "projector"];
const DEFAULT_MAX_TOKENS = 32_768;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_THINKING_FORMAT: LlmThinkingFormat = "zai";
const DEFAULT_THINKING_LEVEL: LlmThinkingLevel = "off";
let localEnvLoaded = false;

export function loadLlmRuntimeConfig(env: NodeJS.ProcessEnv = process.env): LlmRuntimeConfig {
  if (env === process.env) {
    loadLocalEnvFile(env);
  }
  const rawBaseUrl = env.LLM_API_BASE_URL;
  const apiKey = env.LLM_API_KEY;
  const modelId = env.LLM_DEFAULT_MODEL;
  const apiType = parseOpenAIApiType(env.LLM_API_TYPE);
  if (!rawBaseUrl) {
    throw new Error("Missing LLM_API_BASE_URL");
  }
  if (!apiKey) {
    throw new Error("Missing LLM_API_KEY");
  }
  if (!modelId) {
    throw new Error("Missing LLM_DEFAULT_MODEL");
  }
  const defaultMaxTokens = positiveIntegerValue(env.LLM_MAX_TOKENS, DEFAULT_MAX_TOKENS);
  const defaultThinkingLevel = parseThinkingLevel(env.LLM_THINKING, DEFAULT_THINKING_LEVEL);
  const roles = {} as Record<LlmAgentRole, LlmRoleConfig>;
  for (const role of AGENT_ROLES) {
    const prefix = `LLM_${role.toUpperCase()}_`;
    roles[role] = {
      modelId: env[`${prefix}MODEL`] || modelId,
      maxTokens: positiveIntegerValue(env[`${prefix}MAX_TOKENS`], defaultMaxTokens),
      thinkingLevel: parseThinkingLevel(env[`${prefix}THINKING`], defaultThinkingLevel),
      baseUrl: env[`${prefix}BASE_URL`]
        ? normalizeOpenAIBaseUrl(env[`${prefix}BASE_URL`] as string, apiType)
        : undefined,
      apiKey: env[`${prefix}API_KEY`] || undefined
    };
  }
  return {
    provider: PROVIDER_NAME,
    modelId,
    baseUrl: normalizeOpenAIBaseUrl(rawBaseUrl, apiType),
    apiKey,
    apiType,
    defaultMaxTokens,
    defaultThinkingLevel,
    thinkingFormat: parseThinkingFormat(env.LLM_THINKING_FORMAT, DEFAULT_THINKING_FORMAT),
    roles
  };
}

export function createLlmRuntime(config = loadLlmRuntimeConfig()): LlmRuntime {
  const costPerMillionTokens = {
    input: 3,
    output: 6,
    cacheRead: 0.025,
    cacheWrite: 0
  };
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  // Roles sharing the default credentials live in the default provider; roles
  // with their own base URL / API key get a per-role provider registration.
  type RoleAssignment = { provider: string; baseUrl: string; registeredId: string };
  const roleAssignments = new Map<LlmAgentRole, RoleAssignment>();
  const providerGroups = new Map<string, { baseUrl: string; apiKey: string; models: Array<Record<string, unknown>> }>();
  for (const role of AGENT_ROLES) {
    const roleCfg = config.roles[role];
    const baseUrl = roleCfg.baseUrl ?? config.baseUrl;
    const apiKey = roleCfg.apiKey ?? config.apiKey;
    const groupKey = `${baseUrl}\n${apiKey}`;
    let provider = groupKey === `${config.baseUrl}\n${config.apiKey}` ? config.provider : undefined;
    if (provider && !providerGroups.has(provider)) {
      providerGroups.set(provider, { baseUrl, apiKey, models: [] });
    }
    if (!provider) {
      for (const [name, group] of providerGroups) {
        if (group.baseUrl === baseUrl && group.apiKey === apiKey) {
          provider = name;
          break;
        }
      }
    }
    if (!provider) {
      provider = `${config.provider}-${role}`;
      providerGroups.set(provider, { baseUrl, apiKey, models: [] });
    }
    const group = providerGroups.get(provider)!;
    const existing = group.models.find((model) => model.name === roleCfg.modelId
      && model.maxTokens === roleCfg.maxTokens);
    if (existing) {
      roleAssignments.set(role, { provider, baseUrl, registeredId: existing.id as string });
      continue;
    }
    let registeredId = roleCfg.modelId;
    if (group.models.some((model) => model.id === registeredId)) {
      registeredId = `${roleCfg.modelId}#${role}`;
    }
    group.models.push({
      id: registeredId,
      name: roleCfg.modelId,
      api: config.apiType,
      reasoning: true,
      input: ["text"],
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: roleCfg.maxTokens,
      cost: costPerMillionTokens,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: config.thinkingFormat
      }
    });
    roleAssignments.set(role, { provider, baseUrl, registeredId });
  }
  for (const [provider, group] of providerGroups) {
    authStorage.setRuntimeApiKey(provider, group.apiKey);
    modelRegistry.registerProvider(provider, {
      name: "Baizhi OpenAI-compatible Gateway",
      baseUrl: group.baseUrl,
      apiKey: group.apiKey,
      api: config.apiType,
      authHeader: true,
      models: group.models as never
    });
  }
  const models = {} as LlmRuntime["models"];
  const roleConfig = {} as LlmRuntime["roleConfig"];
  const metadataModels = {} as LlmRuntime["metadata"]["models"];
  for (const role of AGENT_ROLES) {
    const assignment = roleAssignments.get(role)!;
    const model = modelRegistry.find(assignment.provider, assignment.registeredId);
    if (!model) {
      throw new Error(`Unable to register model ${assignment.provider}/${assignment.registeredId}`);
    }
    models[role] = model;
    roleConfig[role] = {
      ...config.roles[role],
      provider: assignment.provider,
      baseUrl: assignment.baseUrl
    };
    metadataModels[role] = {
      provider: assignment.provider,
      modelId: config.roles[role].modelId,
      baseUrl: assignment.baseUrl,
      maxTokens: config.roles[role].maxTokens,
      thinkingLevel: config.roles[role].thinkingLevel
    };
  }
  return {
    authStorage,
    modelRegistry,
    model: models.planner,
    models,
    roleConfig,
    metadata: {
      provider: config.provider,
      modelId: config.modelId,
      baseUrl: config.baseUrl,
      apiType: config.apiType,
      costCurrency: "CNY",
      costPerMillionTokens,
      models: metadataModels
    }
  };
}

export function normalizeOpenAICompletionsBaseUrl(rawBaseUrl: string): string {
  return normalizeOpenAIBaseUrl(rawBaseUrl, "openai-completions");
}

export function normalizeOpenAIBaseUrl(
  rawBaseUrl: string,
  apiType: "openai-completions" | "openai-responses"
): string {
  const trimmedBaseUrl = rawBaseUrl.replace(/\/+$/, "");
  const endpointSuffix =
    apiType === "openai-responses" ? /\/responses$/i : /\/chat\/completions$/i;
  return trimmedBaseUrl.replace(endpointSuffix, "");
}

function parseOpenAIApiType(apiType: string | undefined): "openai-completions" | "openai-responses" {
  if (!apiType) {
    return "openai-completions";
  }
  const normalizedApiType = apiType.trim().toLowerCase();
  if (normalizedApiType === "openai-responses" || normalizedApiType === "responses") {
    return "openai-responses";
  }
  if (
    normalizedApiType === "openai-completions" ||
    normalizedApiType === "chat-completions" ||
    normalizedApiType === "completions"
  ) {
    return "openai-completions";
  }
  throw new Error(`Unsupported LLM_API_TYPE: ${apiType}`);
}

function positiveIntegerValue(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseThinkingLevel(raw: string | undefined, fallback: LlmThinkingLevel): LlmThinkingLevel {
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  const levels: LlmThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
  if ((levels as string[]).includes(normalized)) {
    return normalized as LlmThinkingLevel;
  }
  throw new Error(`Unsupported thinking level: ${raw} (expected one of ${levels.join(", ")})`);
}

function parseThinkingFormat(raw: string | undefined, fallback: LlmThinkingFormat): LlmThinkingFormat {
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  const formats: LlmThinkingFormat[] = [
    "openai",
    "openrouter",
    "deepseek",
    "together",
    "zai",
    "qwen",
    "chat-template",
    "qwen-chat-template",
    "string-thinking",
    "ant-ling"
  ];
  if ((formats as string[]).includes(normalized)) {
    return normalized as LlmThinkingFormat;
  }
  throw new Error(`Unsupported LLM_THINKING_FORMAT: ${raw} (expected one of ${formats.join(", ")})`);
}

export function loadLocalEnvFile(env: NodeJS.ProcessEnv): void {
  if (localEnvLoaded) {
    return;
  }
  localEnvLoaded = true;
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }
  const envText = readFileSync(envPath, "utf8");
  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(line.slice(separatorIndex + 1).trim());
    if (!env[key]) {
      env[key] = value;
    }
  }
}

function unquoteEnvValue(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
