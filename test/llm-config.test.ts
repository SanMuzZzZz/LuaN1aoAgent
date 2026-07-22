import assert from "node:assert/strict";
import test from "node:test";
import {
  createLlmRuntime,
  loadLlmRuntimeConfig,
  normalizeOpenAIBaseUrl,
  normalizeOpenAICompletionsBaseUrl
} from "../src/llm-config.js";

test("normalizes full chat completions endpoint to OpenAI-compatible base URL", () => {
  assert.equal(
    normalizeOpenAICompletionsBaseUrl("https://example.test/api/openai/chat/completions"),
    "https://example.test/api/openai"
  );
});

test("registers LLM runtime from LLM_* environment", () => {
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai/chat/completions",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "feature/deepseek"
  });
  const runtime = createLlmRuntime(config);
  assert.equal(runtime.model.provider, "baizhi-openai");
  assert.equal(runtime.model.id, "feature/deepseek");
  assert.equal(runtime.model.baseUrl, "https://example.test/api/openai");
  assert.equal(runtime.model.api, "openai-completions");
  assert.deepEqual(runtime.metadata.costPerMillionTokens, {
    input: 3,
    output: 6,
    cacheRead: 0.025,
    cacheWrite: 0
  });
  assert.equal(runtime.metadata.costCurrency, "CNY");
  assert.equal("apiKey" in runtime.metadata, false);
});

test("registers OpenAI Responses runtime when LLM_API_TYPE requests it", () => {
  assert.equal(
    normalizeOpenAIBaseUrl("https://example.test/api/openai/responses", "openai-responses"),
    "https://example.test/api/openai"
  );
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "sec/gpt-5.5",
    LLM_API_TYPE: "openai-responses"
  });
  const runtime = createLlmRuntime(config);
  assert.equal(config.apiType, "openai-responses");
  assert.equal(runtime.model.api, "openai-responses");
  assert.equal(runtime.model.baseUrl, "https://example.test/api/openai");
});

test("defaults to Chat Completions when LLM_API_TYPE is omitted", () => {
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai/responses",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "sec/gpt-5.5"
  });
  assert.equal(config.apiType, "openai-completions");
});

test("defaults all roles to the shared model with a 32k completion budget", () => {
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "glm-5.2"
  });
  assert.equal(config.defaultMaxTokens, 32_768);
  assert.equal(config.thinkingFormat, "zai");
  for (const role of ["planner", "executor", "supervisor", "projector"] as const) {
    assert.equal(config.roles[role].modelId, "glm-5.2");
    assert.equal(config.roles[role].maxTokens, 32_768);
    assert.equal(config.roles[role].thinkingLevel, "off");
  }
  const runtime = createLlmRuntime(config);
  for (const role of ["planner", "executor", "supervisor", "projector"] as const) {
    assert.equal(runtime.models[role].provider, "baizhi-openai");
    assert.equal(runtime.models[role].id, "glm-5.2");
    assert.equal(runtime.models[role].maxTokens, 32_768);
  }
  assert.equal(runtime.model, runtime.models.planner);
});

test("registers per-role models, budgets and thinking levels from LLM_<ROLE>_* overrides", () => {
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "glm-5.2",
    LLM_MAX_TOKENS: "16384",
    LLM_EXECUTOR_MODEL: "deepseek-v4-pro-202606",
    LLM_PLANNER_MAX_TOKENS: "65536",
    LLM_PLANNER_THINKING: "low",
    LLM_SUPERVISOR_MODEL: "glm-5.2"
  });
  assert.equal(config.roles.executor.modelId, "deepseek-v4-pro-202606");
  assert.equal(config.roles.executor.maxTokens, 16_384);
  assert.equal(config.roles.planner.maxTokens, 65_536);
  assert.equal(config.roles.planner.thinkingLevel, "low");
  assert.equal(config.roles.projector.modelId, "glm-5.2");
  const runtime = createLlmRuntime(config);
  assert.equal(runtime.models.executor.id, "deepseek-v4-pro-202606");
  assert.equal(runtime.models.planner.maxTokens, 65_536);
  assert.equal(runtime.models.supervisor.maxTokens, 16_384);
  // planner/supervisor/projector share the default model id in one provider;
  // the executor variant gets its own registration.
  assert.equal(runtime.models.planner.provider, "baizhi-openai");
  assert.equal(runtime.models.executor.provider, "baizhi-openai");
  assert.equal(runtime.metadata.models.executor.modelId, "deepseek-v4-pro-202606");
});

test("registers a dedicated provider for roles with their own base URL or API key", () => {
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "glm-5.2",
    LLM_EXECUTOR_BASE_URL: "https://backup.test/v1/chat/completions",
    LLM_EXECUTOR_API_KEY: "backup-key",
    LLM_EXECUTOR_MODEL: "glm-5.2"
  });
  const runtime = createLlmRuntime(config);
  assert.equal(runtime.models.executor.provider, "baizhi-openai-executor");
  assert.equal(runtime.models.executor.baseUrl, "https://backup.test/v1");
  assert.equal(runtime.models.planner.provider, "baizhi-openai");
  assert.equal(runtime.models.planner.baseUrl, "https://example.test/api/openai");
  assert.equal("backup-key" in runtime.metadata.models.executor, false);
});

test("keeps per-role budgets distinct when roles share a model id", () => {
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "glm-5.2",
    LLM_PLANNER_MAX_TOKENS: "65536"
  });
  const runtime = createLlmRuntime(config);
  assert.equal(runtime.models.planner.maxTokens, 65_536);
  assert.equal(runtime.models.executor.maxTokens, 32_768);
  assert.notEqual(runtime.models.planner.id, runtime.models.executor.id);
});

test("rejects unsupported thinking level and format values", () => {
  assert.throws(() => loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "glm-5.2",
    LLM_PLANNER_THINKING: "ultra"
  }), /Unsupported thinking level/);
  assert.throws(() => loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "glm-5.2",
    LLM_THINKING_FORMAT: "xml"
  }), /Unsupported LLM_THINKING_FORMAT/);
});
