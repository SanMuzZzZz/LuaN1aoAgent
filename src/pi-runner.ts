import type { ExecutionLog } from "./stores/execution-log.js";
import type { ArtifactStore } from "./stores/artifact-store.js";
import type { AgentRole, ArtifactRecord, ExecutionEvent, JsonObject, RuntimeAbortContext } from "./types.js";
import { RUNTIME_CONTROL_TOOL_NAMES } from "./runtime-control-tools.js";

type SubscribableSession = {
  prompt(text: string, options?: unknown): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  abort?: () => Promise<void>;
  clearQueue?: () => unknown;
};

export class StructuredInvocationError extends Error {
  readonly code: "timeout" | "missing_submit" | "tool_error" | "provider_error" | "invalid_submit";

  constructor(
    message: string,
    code: StructuredInvocationError["code"]
  ) {
    super(message);
    this.name = "StructuredInvocationError";
    this.code = code;
  }
}

export async function invokeStructured<T>(
  session: SubscribableSession,
  prompt: string,
  input: {
    toolName: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    hardTimeoutMs?: number;
    validate?: (value: unknown) => T;
  }
): Promise<T> {
  let settled = false;
  let providerError = "";
  let terminalToolError = "";
  let idleTimeout: NodeJS.Timeout | undefined;
  let hardTimeout: NodeJS.Timeout | undefined;
  let resolveInvocation: (value: T) => void = () => undefined;
  let rejectInvocation: (error: unknown) => void = () => undefined;
  const invocation = new Promise<T>((resolve, reject) => {
    resolveInvocation = resolve;
    rejectInvocation = reject;
  });
  const idleTimeoutMs = positiveTimeout(input.idleTimeoutMs);
  const hardTimeoutMs = positiveTimeout(input.hardTimeoutMs ?? input.timeoutMs);
  const rejectOnce = (error: unknown, abortSession = false): void => {
    if (settled) {
      return;
    }
    settled = true;
    if (abortSession) {
      void session.abort?.();
    }
    rejectInvocation(error);
  };
  const resetIdleTimeout = (): void => {
    if (!idleTimeoutMs || settled) {
      return;
    }
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    idleTimeout = setTimeout(() => rejectOnce(new StructuredInvocationError(
      `Structured invocation idle timed out after ${idleTimeoutMs}ms`,
      "timeout"
    ), true), idleTimeoutMs);
  };
  const unsubscribe = session.subscribe((event) => {
    if (settled || !isRecord(event)) {
      return;
    }
    if (event.type === "message_end") {
      const errorMessage = extractPiErrorMessage(event);
      if (errorMessage) {
        providerError = errorMessage;
      } else if (isSuccessfulAssistantMessage(event)) {
        providerError = "";
      }
      resetIdleTimeout();
      return;
    }
    if (event.type === "auto_retry_end" && event.success === true) {
      providerError = "";
    }
    if (isStructuredInvocationProgressEvent(event.type)) {
      resetIdleTimeout();
    }
    if (event.type !== "tool_execution_end" || event.toolName !== input.toolName) {
      return;
    }
    if (event.isError === true) {
      terminalToolError = extractStructuredToolError(event, input.toolName);
      resetIdleTimeout();
      return;
    }
    terminalToolError = "";
    const result = isRecord(event.result) ? event.result : undefined;
    const details = result?.details;
    try {
      const value = input.validate ? input.validate(details) : details as T;
      if (value === undefined) {
        throw new Error(`Terminal tool ${input.toolName} returned no details`);
      }
      session.clearQueue?.();
      settled = true;
      resolveInvocation(value);
    } catch (error) {
      rejectOnce(new StructuredInvocationError(
        error instanceof Error ? error.message : String(error),
        "invalid_submit"
      ));
    }
  });
  resetIdleTimeout();
  hardTimeout = hardTimeoutMs
    ? setTimeout(() => rejectOnce(new StructuredInvocationError(
      `Structured invocation hard timed out after ${hardTimeoutMs}ms`,
      "timeout"
    ), true), hardTimeoutMs)
    : undefined;
  const promptCompletion = session.prompt(prompt);
  void promptCompletion.then(() => {
    if (settled) {
      return;
    }
    if (terminalToolError) {
      rejectOnce(new StructuredInvocationError(terminalToolError, "invalid_submit"));
      return;
    }
    rejectOnce(new StructuredInvocationError(
      providerError || `Invocation completed without ${input.toolName}`,
      providerError ? "provider_error" : "missing_submit"
    ));
  }, (error) => {
    if (settled) {
      return;
    }
    rejectOnce(error instanceof Error
      ? error
      : new StructuredInvocationError(String(error), "provider_error"));
  });
  try {
    const value = await invocation;
    try {
      await promptCompletion;
    } catch {
      // A valid terminating tool submission wins; awaiting here only ensures
      // the Pi session has left its processing state before it is reused.
    }
    return value;
  } finally {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    if (hardTimeout) {
      clearTimeout(hardTimeout);
    }
    unsubscribe();
  }
}

function isSuccessfulAssistantMessage(event: Record<string, unknown>): boolean {
  const message = isRecord(event.message) ? event.message : undefined;
  return isAssistantMessageRole(message?.role)
    && String(message?.stopReason ?? event.stopReason ?? "").toLowerCase() !== "error";
}

function extractStructuredToolError(event: Record<string, unknown>, toolName: string): string {
  const result = isRecord(event.result) ? event.result : undefined;
  const candidates: unknown[] = [
    event.errorMessage,
    isRecord(event.error) ? event.error.message : undefined,
    result?.errorMessage,
    result?.message
  ];
  if (Array.isArray(result?.content)) {
    for (const item of result.content) {
      if (!isRecord(item) || item.type !== "text") {
        continue;
      }
      candidates.push(item.text);
      if (isRecord(item.text)) {
        candidates.push(item.text.preview, item.text.message);
      }
    }
  }
  const message = candidates.find((value) => typeof value === "string" && value.trim().length > 0);
  return typeof message === "string"
    ? message.trim().slice(0, 4_000)
    : `Terminal tool ${toolName} failed validation`;
}

function isStructuredInvocationProgressEvent(eventType: unknown): boolean {
  return typeof eventType === "string" && [
    "message_update",
    "message_start",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "turn_start",
    "turn_end",
    "agent_start",
    "agent_end",
    "auto_retry_start",
    "auto_retry_end",
    "compaction_start",
    "compaction_end"
  ].includes(eventType);
}

function positiveTimeout(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export class PromptRuntimeError extends Error {
  readonly errorKind: LlmErrorKind;

  constructor(message: string, errorKind = classifyLlmErrorKind(message)) {
    super(message);
    this.name = "PromptRuntimeError";
    this.errorKind = errorKind;
  }
}

export type LlmErrorKind =
  | "provider_concurrency"
  | "provider_rate_limit"
  | "provider_unavailable"
  | "provider_timeout"
  | "llm_error";

export async function promptAndCollect(session: SubscribableSession, prompt: string): Promise<string> {
  let collectedText = "";
  let finalMessageText = "";
  let finalErrorMessage = "";
  const unsubscribe = session.subscribe((event) => {
    const typedEvent = event as {
      type?: string;
      errorMessage?: string;
      error?: { message?: string };
      assistantMessageEvent?: { type?: string; delta?: string };
      message?: { role?: string; content?: Array<{ type?: string; text?: string }>; errorMessage?: string };
    };
    if (typedEvent.type === "message_update" && typedEvent.assistantMessageEvent?.type === "text_delta") {
      collectedText += typedEvent.assistantMessageEvent.delta ?? "";
    }
    if (typedEvent.type === "message_end" && isAssistantMessageRole(typedEvent.message?.role)) {
      finalMessageText = extractTextContent(typedEvent.message?.content);
      finalErrorMessage = typedEvent.message?.errorMessage
        ?? typedEvent.errorMessage
        ?? typedEvent.error?.message
        ?? "";
    }
  });
  try {
    await session.prompt(prompt);
    const output = collectedText.trim().length > 0 ? collectedText : finalMessageText;
    if (output.trim().length === 0 && finalErrorMessage.trim().length > 0) {
      throw new PromptRuntimeError(finalErrorMessage.trim());
    }
    if (output.trim().length === 0) {
      throw new PromptRuntimeError("No assistant output collected from Pi session", "llm_error");
    }
    return output;
  } finally {
    unsubscribe();
  }
}

export function classifyLlmErrorKind(message: string): LlmErrorKind {
  const normalized = message.toLowerCase();
  if (/concurrency limit|too many concurrent|concurrent request/.test(normalized)) {
    return "provider_concurrency";
  }
  if (/rate limit|too many requests|\b429\b|quota/.test(normalized)) {
    return "provider_rate_limit";
  }
  if (/timeout|timed out|etimedout|econnreset|socket hang up|network|fetch failed/.test(normalized)) {
    return "provider_timeout";
  }
  if (/\b5\d\d\b|bad gateway|service unavailable|temporarily unavailable|upstream.*unavailable/.test(normalized)) {
    return "provider_unavailable";
  }
  return "llm_error";
}

export function isRetryableLlmErrorKind(errorKind: LlmErrorKind): boolean {
  return errorKind !== "llm_error";
}

export function attachExecutionLogging(input: {
  session: SubscribableSession;
  executionLog: ExecutionLog;
  artifactStore?: ArtifactStore;
  role: AgentRole;
  getTaskId?: () => string | undefined;
  getEpochId?: () => string | undefined;
  getAbortContext?: () => RuntimeAbortContext | undefined;
  spillThreshold?: number;
  onPersistedEvent?: (event: ExecutionEvent) => void | Promise<void>;
}): (() => void) & { drain: () => Promise<void> } {
  const pendingWrites = new Set<Promise<void>>();
  let firstWriteError: unknown;
  let writeChain: Promise<void> = Promise.resolve();
  const unsubscribe = input.session.subscribe((event) => {
    const typedEvent = event as { type?: string; toolName?: string; isError?: boolean };
    const eventType = typedEvent.type ?? "unknown";
    if (!shouldPersistEvent(eventType)) {
      return;
    }
    const write = writeChain.then(async () => {
      const taskId = input.getTaskId?.();
      const normalized = normalizePiEvent(typedEvent, input.getAbortContext?.());
      if (!normalized) {
        return;
      }
      const sanitized = await sanitizePiEvent({
        event: normalized.payload,
        artifactStore: input.artifactStore,
        taskId,
        threshold: input.spillThreshold ?? 4000
      });
      const persistedEvent = await input.executionLog.append({
        epochId: input.getEpochId?.(),
        taskId,
        role: input.role,
        eventType: normalized.eventType,
        summary: normalized.summary,
        payload: sanitized.payload,
        artifactRefs: sanitized.artifactRefs.length > 0 ? sanitized.artifactRefs : undefined
      });
      await input.onPersistedEvent?.(persistedEvent);
    });
    writeChain = write.then(
      () => undefined,
      (error) => {
        firstWriteError ??= error;
      }
    );
    pendingWrites.add(write);
    void write.then(
      () => pendingWrites.delete(write),
      (error) => {
        firstWriteError ??= error;
        pendingWrites.delete(write);
      }
    );
  });
  const handle = (() => unsubscribe()) as (() => void) & { drain: () => Promise<void> };
  handle.drain = async () => {
    while (pendingWrites.size > 0) {
      await Promise.allSettled([...pendingWrites]);
    }
    if (firstWriteError) {
      throw firstWriteError;
    }
  };
  return handle;
}

function shouldPersistEvent(eventType: string): boolean {
  return [
    "tool_execution_start",
    "tool_execution_end",
    "turn_end",
    "message_end",
    "auto_retry_start",
    "auto_retry_end"
  ].includes(eventType);
}

function normalizePiEvent(
  event: Record<string, unknown>,
  abortContext?: RuntimeAbortContext
): { eventType: string; summary: string; payload: JsonObject } | undefined {
  const eventType = String(event.type ?? "unknown");
  const classification = classifyPiEvent(event, abortContext);
  if (eventType === "auto_retry_start") {
    return {
      eventType: "provider_retry_started",
      summary: `provider_retry_started:attempt=${String(event.attempt ?? "unknown")}`,
      payload: {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage
      }
    };
  }
  if (eventType === "auto_retry_end") {
    return {
      eventType: "provider_retry_completed",
      summary: `provider_retry_completed:${event.success === true ? "success" : "failed"}`,
      payload: {
        success: event.success,
        attempt: event.attempt,
        finalError: event.finalError
      }
    };
  }
  if (eventType === "tool_execution_start") {
    const toolName = String(event.toolName ?? "unknown");
    return {
      eventType: "tool_started",
      summary: `tool_started:${toolName}`,
      payload: {
        toolCallId: event.toolCallId,
        toolName,
        args: event.args
      }
    };
  }
  if (eventType === "tool_execution_end") {
    const toolName = String(event.toolName ?? "unknown");
    const runtimeControl = RUNTIME_CONTROL_TOOL_NAMES.has(toolName);
    return {
      eventType: runtimeControl ? "runtime_control" : "tool_finished",
      summary: `${runtimeControl ? "runtime_control" : "tool_finished"}:${toolName}:${event.isError === true ? "error" : "ok"}`,
      payload: {
        toolCallId: event.toolCallId,
        toolName,
        isError: event.isError === true,
        result: event.result
      }
    };
  }
  if (eventType === "turn_end") {
    const message = isRecord(event.message) ? event.message : undefined;
    return {
      eventType: "turn_usage",
      summary: "turn_usage",
      payload: {
        usage: message?.usage ?? event.usage,
        stopReason: message?.stopReason ?? event.stopReason,
        provider: message?.provider,
        model: message?.model,
        responseModel: message?.responseModel,
        responseId: message?.responseId,
        api: message?.api,
        ...(classification?.payloadPatch ?? {})
      }
    };
  }
  if (eventType === "message_end") {
    const message = isRecord(event.message) ? event.message : undefined;
    if (classification) {
      const runtimeAbort = isRecord(classification.payloadPatch.runtimeAbort)
        && classification.payloadPatch.runtimeAbort.expected === true;
      return {
        eventType: runtimeAbort ? "runtime_control" : "provider_error",
        summary: `${runtimeAbort ? "runtime_abort" : "provider_error"}:${classification.summarySuffix}`,
        payload: {
          stopReason: message?.stopReason ?? event.stopReason,
          ...classification.payloadPatch
        }
      };
    }
    if (!isAssistantMessageRole(message?.role)) {
      return undefined;
    }
    const content = Array.isArray(message?.content) ? message.content : [];
    const text = extractTextContent(content as Array<{ type?: string; text?: string }>);
    const toolCalls = content
      .filter(isRecord)
      .filter((item) => item.type === "toolCall")
      .map((item) => ({ id: item.id, name: item.name, arguments: item.arguments }));
    if (!text && toolCalls.length === 0) {
      return undefined;
    }
    return {
      eventType: "assistant_intent",
      summary: text ? text.slice(0, 240) : `assistant_intent:${toolCalls.map((call) => call.name).join(",")}`,
      payload: { text, toolCalls }
    };
  }
  return undefined;
}

function summarizePiEvent(event: { type?: string; toolName?: string; isError?: boolean }): string {
  if (event.type?.startsWith("tool_execution")) {
    return `${event.type}:${event.toolName ?? "unknown"}:${event.isError ? "error" : "ok"}`;
  }
  return event.type ?? "unknown";
}

function classifyPiEvent(
  event: unknown,
  abortContext?: RuntimeAbortContext
): { summarySuffix: string; payloadPatch: JsonObject } | undefined {
  const errorMessage = extractPiErrorMessage(event);
  const aborted = isAbortedPiEvent(event, errorMessage);
  if (!errorMessage && !aborted) {
    return undefined;
  }
  if (aborted && abortContext) {
    return {
      summarySuffix: abortContext.kind,
      payloadPatch: {
        errorKind: abortContext.kind,
        runtimeAbort: {
          expected: true,
          kind: abortContext.kind,
          reason: abortContext.reason,
          controlSignal: abortContext.controlSignal
        }
      }
    };
  }
  const errorKind = errorMessage ? classifyLlmErrorKind(errorMessage) : "llm_error";
  return {
    summarySuffix: errorKind,
    payloadPatch: {
      errorKind,
      ...(errorMessage
        ? {
          llmError: {
            retryable: isRetryableLlmErrorKind(errorKind),
            message: errorMessage
          }
        }
        : {}),
      ...(aborted
        ? {
          runtimeAbort: {
            expected: false,
            kind: "unclassified_abort",
            reason: errorMessage ?? "Pi session reported an abort without controller context"
          }
        }
        : {})
    }
  };
}

function extractPiErrorMessage(event: unknown): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  if (typeof event.errorMessage === "string" && event.errorMessage.trim().length > 0) {
    return event.errorMessage;
  }
  if (isRecord(event.message) && typeof event.message.errorMessage === "string" && event.message.errorMessage.trim().length > 0) {
    return event.message.errorMessage;
  }
  if (isRecord(event.error) && typeof event.error.message === "string" && event.error.message.trim().length > 0) {
    return event.error.message;
  }
  return undefined;
}

function isAbortedPiEvent(event: unknown, errorMessage?: string): boolean {
  if (!isRecord(event)) {
    return false;
  }
  if (String(event.stopReason).toLowerCase() === "aborted") {
    return true;
  }
  if (isRecord(event.message) && String(event.message.stopReason).toLowerCase() === "aborted") {
    return true;
  }
  return Boolean(errorMessage && /aborted/i.test(errorMessage));
}

async function sanitizePiEvent(input: {
  event: unknown;
  artifactStore?: ArtifactStore;
  taskId?: string;
  threshold: number;
}): Promise<{ payload: JsonObject; artifactRefs: string[] }> {
  const artifactRefs: string[] = [];
  const jsonSafeEvent = JSON.parse(JSON.stringify(input.event)) as unknown;
  const payload = await spillLargeStrings(jsonSafeEvent, {
    artifactStore: input.artifactStore,
    artifactRefs,
    taskId: input.taskId,
    threshold: input.threshold
  });
  return {
    payload: payload as JsonObject,
    artifactRefs
  };
}

async function spillLargeStrings(
  value: unknown,
  input: {
    artifactStore?: ArtifactStore;
    artifactRefs: string[];
    taskId?: string;
    threshold: number;
  }
): Promise<unknown> {
  if (typeof value === "string") {
    if (value.length <= input.threshold) {
      return value;
    }
    if (!input.artifactStore) {
      return `${value.slice(0, input.threshold)}...[truncated:${value.length}]`;
    }
    const record = await input.artifactStore.write({
      taskId: input.taskId,
      kind: "text",
      mediaType: "text/plain",
      data: value,
      extension: "txt"
    });
    input.artifactRefs.push(record.artifactRef);
    return artifactPointer(record, value.length);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => spillLargeStrings(item, input)));
  }
  if (value && typeof value === "object") {
    const output: JsonObject = {};
    for (const [key, propertyValue] of Object.entries(value)) {
      output[key] = await spillLargeStrings(propertyValue, input);
    }
    return output;
  }
  return value;
}

function artifactPointer(record: ArtifactRecord, originalLength: number): JsonObject {
  return {
    artifactRef: record.artifactRef,
    byteLength: record.byteLength,
    originalLength,
    preview: record.preview,
    truncated: true
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractTextContent(content?: Array<{ type?: string; text?: string }>): string {
  if (!content) {
    return "";
  }
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function isAssistantMessageRole(role: unknown): boolean {
  return role === undefined || role === "assistant";
}
