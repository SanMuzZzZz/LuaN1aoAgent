import {
  AuthStorage,
  ModelRegistry
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LlmRuntimeConfig = {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  apiType: "openai-completions" | "openai-responses";
};

export type LlmRuntime = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: NonNullable<ReturnType<ModelRegistry["find"]>>;
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
  };
};

const PROVIDER_NAME = "baizhi-openai";
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
  return {
    provider: PROVIDER_NAME,
    modelId,
    baseUrl: normalizeOpenAIBaseUrl(rawBaseUrl, apiType),
    apiKey,
    apiType
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
  authStorage.setRuntimeApiKey(config.provider, config.apiKey);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(config.provider, {
    name: "Baizhi OpenAI-compatible Gateway",
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    api: config.apiType,
    authHeader: true,
    models: [
      {
        id: config.modelId,
        name: config.modelId,
        api: config.apiType,
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 8192,
        cost: costPerMillionTokens,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false
        }
      }
    ]
  });
  const model = modelRegistry.find(config.provider, config.modelId);
  if (!model) {
    throw new Error(`Unable to register model ${config.provider}/${config.modelId}`);
  }
  return {
    authStorage,
    modelRegistry,
    model,
    metadata: {
      provider: config.provider,
      modelId: config.modelId,
      baseUrl: config.baseUrl,
      apiType: config.apiType,
      costCurrency: "CNY",
      costPerMillionTokens
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

function loadLocalEnvFile(env: NodeJS.ProcessEnv): void {
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
