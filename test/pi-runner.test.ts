import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  attachExecutionLogging,
  classifyLlmErrorKind,
  invokeStructured,
  promptAndCollect,
  PromptRuntimeError,
  StructuredInvocationError
} from "../src/pi-runner.js";
import { ArtifactStore } from "../src/stores/artifact-store.js";
import { ExecutionLog } from "../src/stores/execution-log.js";

test("collects final message text when text deltas are absent", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      for (const listener of listeners) {
        listener({
          type: "message_end",
          message: {
            content: [
              { type: "thinking", thinking: "ignored" },
              { type: "text", text: "{\"ok\":true}" }
            ],
            role: "assistant"
          }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    }
  };

  assert.equal(await promptAndCollect(session, "test"), "{\"ok\":true}");
});

test("ignores user and toolResult message echoes when collecting final output", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      for (const listener of listeners) {
        listener({
          type: "message_end",
          message: {
            role: "user",
            content: [{ type: "text", text: "USER_GOAL:\n{\"view\":\"planner_decision\"}" }]
          }
        });
        listener({
          type: "message_end",
          message: {
            role: "toolResult",
            content: [{ type: "text", text: "{\"not\":\"assistant\"}" }]
          }
        });
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "{\"decision\":\"apply_commands\"}" }]
          }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    }
  };

  assert.equal(await promptAndCollect(session, "test"), "{\"decision\":\"apply_commands\"}");
});

test("fails clearly when Pi session emits no assistant output", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      for (const listener of listeners) {
        listener({
          type: "message_end",
          message: {
            role: "user",
            content: [{ type: "text", text: "USER_GOAL:\n..." }]
          }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    }
  };

  await assert.rejects(
    () => promptAndCollect(session, "test"),
    /No assistant output collected from Pi session/
  );
});

test("collects terminating tool details without assistant text", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      for (const listener of [...listeners]) {
        listener({
          type: "tool_execution_end",
          toolName: "task_result_submit",
          isError: false,
          result: { details: { status: "completed", summary: "done" } }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }
  };

  assert.deepEqual(await invokeStructured(session, "test", { toolName: "task_result_submit" }), {
    status: "completed",
    summary: "done"
  });
});

test("clears queued Pi messages before completing a terminating tool submission", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  let queued = true;
  let secondSubmitCount = 0;
  const session = {
    async prompt(): Promise<void> {
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "task_result_submit",
        isError: false,
        result: { details: { status: "partial", summary: "checkpoint" } }
      });
      await delay(5);
      if (queued) {
        secondSubmitCount += 1;
        emitToListeners(listeners, {
          type: "tool_execution_end",
          toolName: "task_result_submit",
          isError: false,
          result: { details: { status: "completed", summary: "stale queued continuation" } }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    },
    clearQueue(): void {
      queued = false;
    }
  };

  assert.deepEqual(await invokeStructured(session, "test", { toolName: "task_result_submit" }), {
    status: "partial",
    summary: "checkpoint"
  });
  assert.equal(secondSubmitCount, 0);
});

test("fails with a protocol error when terminal submit is missing", async () => {
  const session = {
    async prompt(): Promise<void> {},
    subscribe(): () => void {
      return () => undefined;
    }
  };

  await assert.rejects(
    () => invokeStructured(session, "test", { toolName: "planner_submit" }),
    /completed without planner_submit/
  );
});

test("lets Pi finish its native provider retry lifecycle before rejecting", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  let abortCount = 0;
  let promptSettled = false;
  const session = {
    async prompt(): Promise<void> {
      for (const listener of [...listeners]) {
        listener({
          type: "message_end",
          message: { role: "assistant", errorMessage: "terminated", content: [] }
        });
        listener({
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 1,
          errorMessage: "terminated"
        });
      }
      await delay(10);
      for (const listener of [...listeners]) {
        listener({ type: "auto_retry_end", success: false, attempt: 1, finalError: "terminated" });
      }
      promptSettled = true;
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    },
    async abort(): Promise<void> {
      abortCount += 1;
    }
  };

  await assert.rejects(
    () => invokeStructured(session, "test", {
      toolName: "planner_submit",
      idleTimeoutMs: 1_000,
      hardTimeoutMs: 2_000
    }),
    /terminated/
  );
  assert.equal(promptSettled, true);
  assert.equal(abortCount, 0);
});

test("accepts a terminal submit after Pi recovers through native provider retry", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      emitToListeners(listeners, {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 service unavailable", content: [] }
      });
      emitToListeners(listeners, {
        type: "agent_end",
        messages: [],
        willRetry: true
      });
      emitToListeners(listeners, {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1,
        errorMessage: "HTTP 503 service unavailable"
      });
      await delay(5);
      emitToListeners(listeners, {
        type: "message_end",
        message: { role: "assistant", stopReason: "toolUse", content: [] }
      });
      emitToListeners(listeners, { type: "auto_retry_end", success: true, attempt: 1 });
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "planner_submit",
        isError: false,
        result: { details: { decision: "apply_commands", reason: "recovered" } }
      });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    }
  };

  assert.deepEqual(await invokeStructured(session, "test", {
    toolName: "planner_submit",
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 2_000
  }), { decision: "apply_commands", reason: "recovered" });
});

test("lets the same Pi session repair a terminal submit validation error", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  let promptCount = 0;
  const session = {
    async prompt(): Promise<void> {
      promptCount += 1;
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "planner_submit",
        isError: true,
        result: {
          content: [{
            type: "text",
            text: {
              artifactRef: "artifact:validation-error",
              preview: "Validation failed for tool planner_submit: reason is required"
            }
          }]
        }
      });
      await delay(5);
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "planner_submit",
        isError: false,
        result: {
          details: {
            decision: "apply_commands",
            commands: [],
            reason: "Repair the malformed submission",
            basedOnRefs: ["goal:root"]
          }
        }
      });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    }
  };

  assert.deepEqual(await invokeStructured(session, "test", {
    toolName: "planner_submit",
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 2_000
  }), {
    decision: "apply_commands",
    commands: [],
    reason: "Repair the malformed submission",
    basedOnRefs: ["goal:root"]
  });
  assert.equal(promptCount, 1);
});

test("preserves terminal validation details when the session does not repair the submit", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "planner_submit",
        isError: true,
        result: {
          content: [{ type: "text", text: "Validation failed: reason is required" }]
        }
      });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    }
  };

  await assert.rejects(
    () => invokeStructured(session, "test", { toolName: "planner_submit" }),
    (error) => error instanceof StructuredInvocationError
      && error.code === "invalid_submit"
      && error.message === "Validation failed: reason is required"
  );
});

test("does not misclassify a missing terminal submit after successful native retry", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      emitToListeners(listeners, {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 service unavailable", content: [] }
      });
      emitToListeners(listeners, {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1,
        errorMessage: "HTTP 503 service unavailable"
      });
      await delay(5);
      emitToListeners(listeners, {
        type: "message_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }
      });
      emitToListeners(listeners, { type: "auto_retry_end", success: true, attempt: 1 });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    }
  };

  await assert.rejects(
    () => invokeStructured(session, "test", {
      toolName: "planner_submit",
      idleTimeoutMs: 1_000,
      hardTimeoutMs: 2_000
    }),
    (error) => error instanceof Error
      && error.message.includes("completed without planner_submit")
      && !(error instanceof PromptRuntimeError)
  );
});

test("resets structured invocation idle timeout on meaningful Pi progress", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      await delay(15);
      for (const listener of [...listeners]) {
        listener({ type: "tool_execution_start", toolName: "graph_query" });
      }
      await delay(20);
      for (const listener of [...listeners]) {
        listener({
          type: "tool_execution_end",
          toolName: "planner_submit",
          isError: false,
          result: { details: { decision: "apply_commands" } }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    },
    async abort(): Promise<void> {}
  };

  assert.deepEqual(await invokeStructured(session, "test", {
    toolName: "planner_submit",
    idleTimeoutMs: 25,
    hardTimeoutMs: 100
  }), { decision: "apply_commands" });
});

test("keeps small tool output inline in execution log", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  attachExecutionLogging({
    session,
    executionLog,
    artifactStore,
    role: "executor",
    getTaskId: () => "task:small"
  });

  session.emit({
    type: "tool_execution_end",
    toolName: "bash",
    result: {
      content: [{ type: "text", text: "small output" }]
    }
  });

  await waitFor(async () => (await executionLog.readAll()).length === 1);
  const [event] = await executionLog.readAll();
  assert.equal(((event.payload.result as { content: Array<{ text: string }> }).content[0]).text, "small output");
  assert.deepEqual(await artifactStore.list({ taskId: "task:small" }), []);
});

test("spills large tool output to artifact and leaves pointer in execution log", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  attachExecutionLogging({
    session,
    executionLog,
    artifactStore,
    role: "executor",
    getTaskId: () => "task:large",
    spillThreshold: 20
  });
  const largeOutput = "x".repeat(64);

  session.emit({
    type: "tool_execution_end",
    toolName: "bash",
    result: {
      content: [{ type: "text", text: largeOutput }]
    }
  });

  await waitFor(async () => (await executionLog.readAll()).length === 1);
  const [event] = await executionLog.readAll();
  const pointer = ((event.payload.result as { content: Array<{ text: Record<string, unknown> }> }).content[0]).text;
  assert.equal(pointer.truncated, true);
  assert.equal(pointer.byteLength, 64);
  assert.equal(event.artifactRefs?.length, 1);
  assert.equal(await artifactStore.read(pointer.artifactRef as string), largeOutput);
});

test("preserves public intent text and tool call id in assistant intent events", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const logging = attachExecutionLogging({
    session,
    executionLog,
    role: "executor",
    getTaskId: () => "task:recon"
  });

  session.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "读取 Web CTF 技能指南，确认当前侦查任务适用的验证方法。" },
        {
          type: "toolCall",
          id: "call:read-skill",
          name: "read",
          arguments: { path: "/skills/ctf-web/SKILL.md", limit: 80 }
        }
      ]
    }
  });
  session.emit({
    type: "tool_execution_start",
    toolCallId: "call:read-skill",
    toolName: "read",
    args: { path: "/skills/ctf-web/SKILL.md", limit: 80 }
  });
  session.emit({
    type: "tool_execution_end",
    toolCallId: "call:read-skill",
    toolName: "read",
    isError: false,
    result: { content: [{ type: "text", text: "skill content" }] }
  });
  await logging.drain();

  const events = await executionLog.readAll();
  assert.deepEqual(events.map((event) => event.eventType), ["assistant_intent", "tool_started", "tool_finished"]);
  assert.equal(events[0]?.payload.text, "读取 Web CTF 技能指南，确认当前侦查任务适用的验证方法。");
  assert.deepEqual(events[0]?.payload.toolCalls, [{
    id: "call:read-skill",
    name: "read",
    arguments: { path: "/skills/ctf-web/SKILL.md", limit: 80 }
  }]);
  assert.equal(events[1]?.payload.toolCallId, "call:read-skill");
  assert.equal(events[2]?.payload.toolCallId, "call:read-skill");
});

test("preserves Pi event order while large outputs spill asynchronously", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const logging = attachExecutionLogging({
    session,
    executionLog,
    artifactStore,
    role: "executor",
    getTaskId: () => "task:ordered",
    spillThreshold: 20
  });

  session.emit({
    type: "tool_execution_end",
    toolName: "bash",
    result: { content: [{ type: "text", text: "x".repeat(1000) }] }
  });
  session.emit({
    type: "turn_end",
    message: {
      role: "assistant",
      provider: "test-provider",
      model: "test-model",
      responseId: "response:1",
      api: "openai-completions",
      stopReason: "toolUse",
      usage: {
        input: 7,
        output: 3,
        cacheRead: 2,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0.000021, output: 0.000018, cacheRead: 0.00000005, cacheWrite: 0, total: 0.00003905 }
      }
    }
  });
  await logging.drain();

  const events = await executionLog.readAll();
  assert.deepEqual(events.map((event) => event.eventType), ["tool_finished", "turn_usage"]);
  assert.deepEqual(events.map((event) => event.seq), [1, 2]);
  assert.deepEqual(events[1]?.payload.usage, {
    input: 7,
    output: 3,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: 12,
    cost: { input: 0.000021, output: 0.000018, cacheRead: 0.00000005, cacheWrite: 0, total: 0.00003905 }
  });
  assert.equal(events[1]?.payload.responseId, "response:1");
});

test("annotates budget abort separately from llm errors", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  attachExecutionLogging({
    session,
    executionLog,
    role: "executor",
    getTaskId: () => "task:budget",
    getAbortContext: () => ({
      kind: "budget_abort",
      reason: "Task budget reached: maxTurns=1"
    })
  });

  session.emit({
    type: "message_end",
    message: {
      stopReason: "aborted",
      errorMessage: "Request was aborted.",
      content: []
    }
  });

  await waitFor(async () => (await executionLog.readAll()).length === 1);
  const [event] = await executionLog.readAll();
  const runtimeAbort = event.payload.runtimeAbort as Record<string, unknown>;
  assert.equal(event.eventType, "runtime_control");
  assert.equal(event.summary, "runtime_abort:budget_abort");
  assert.equal(event.payload.errorKind, "budget_abort");
  assert.equal(runtimeAbort.expected, true);
  assert.equal(runtimeAbort.kind, "budget_abort");
  assert.equal(runtimeAbort.reason, "Task budget reached: maxTurns=1");
});

test("classifies unhandled Pi error events as llm errors", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  attachExecutionLogging({
    session,
    executionLog,
    role: "executor",
    getTaskId: () => "task:error"
  });

  session.emit({
    type: "message_end",
    message: {
      stopReason: "error",
      errorMessage: "upstream model request failed",
      content: []
    }
  });

  await waitFor(async () => (await executionLog.readAll()).length === 1);
  const [event] = await executionLog.readAll();
  assert.equal(event.eventType, "provider_error");
  assert.equal(event.summary, "provider_error:llm_error");
  assert.equal(event.payload.errorKind, "llm_error");
});

test("classifies provider concurrency errors as retryable prompt runtime errors", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      for (const listener of listeners) {
        listener({
          type: "message_end",
          message: {
            stopReason: "error",
            errorMessage: "Concurrency limit exceeded for user, please retry later",
            content: []
          }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    }
  };

  await assert.rejects(
    () => promptAndCollect(session, "test"),
    (error) => error instanceof PromptRuntimeError && error.errorKind === "provider_concurrency"
  );
  assert.equal(classifyLlmErrorKind("HTTP 429 too many requests"), "provider_rate_limit");
});

test("annotates provider concurrency events in execution log", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  attachExecutionLogging({
    session,
    executionLog,
    role: "executor",
    getTaskId: () => "task:provider"
  });

  session.emit({
    type: "message_end",
    message: {
      stopReason: "error",
      errorMessage: "Concurrency limit exceeded for user, please retry later",
      content: []
    }
  });

  await waitFor(async () => (await executionLog.readAll()).length === 1);
  const [event] = await executionLog.readAll();
  assert.equal(event.eventType, "provider_error");
  assert.equal(event.summary, "provider_error:provider_concurrency");
  assert.equal(event.payload.errorKind, "provider_concurrency");
  assert.deepEqual(event.payload.llmError, {
    retryable: true,
    message: "Concurrency limit exceeded for user, please retry later"
  });
});

test("records Pi native provider retry lifecycle events", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  attachExecutionLogging({
    session,
    executionLog,
    role: "planner"
  });

  session.emit({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: "terminated"
  });
  session.emit({
    type: "auto_retry_end",
    success: true,
    attempt: 1
  });

  await waitFor(async () => (await executionLog.readAll()).length === 2);
  const events = await executionLog.readAll();
  assert.deepEqual(events.map((event) => event.eventType), [
    "provider_retry_started",
    "provider_retry_completed"
  ]);
  assert.equal(events[1]?.payload.success, true);
});

function createMockSession(): {
  emit: (event: unknown) => void;
  prompt: () => Promise<void>;
  subscribe: (listener: (event: unknown) => void) => () => void;
} {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    emit(event: unknown): void {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    async prompt(): Promise<void> {},
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    }
  };
}

function emitToListeners(listeners: Array<(event: unknown) => void>, event: unknown): void {
  for (const listener of [...listeners]) {
    listener(event);
  }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
