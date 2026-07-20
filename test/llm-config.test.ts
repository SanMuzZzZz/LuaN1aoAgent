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
