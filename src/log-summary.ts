import type { ExecutionEvent, JsonObject } from "./types.js";
import { buildProjectionObservations, type ProjectionObservation } from "./projection.js";

export function compactExecutionEvents(events: ExecutionEvent[]): Array<Record<string, unknown>> {
  return events.map(compactExecutionEvent);
}

export function compactExecutionEvent(event: ExecutionEvent): Record<string, unknown> {
  return {
    id: event.id,
    taskId: event.taskId,
    role: event.role,
    eventType: event.eventType,
    timestamp: event.timestamp,
    summary: event.summary,
    artifactRefs: event.artifactRefs,
    payload: compactJson(event.payload, 0)
  };
}

export function compactJson(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > 900 ? `${value.slice(0, 900)}...[truncated:${value.length}]` : value;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => compactJson(item, depth + 1));
  }
  if (depth > 4) {
    return "[truncated:depth]";
  }
  const compacted: JsonObject = {};
  for (const [key, propertyValue] of Object.entries(value)) {
    if (["thinking", "thinkingSignature", "messages"].includes(key)) {
      continue;
    }
    compacted[key] = compactJson(propertyValue, depth + 1);
  }
  return compacted;
}

export type SupervisorTraceSummary = {
  actionTraceText: string;
  loopSignalsText: string;
};

export function summarizeSupervisorTrace(events: ExecutionEvent[]): SupervisorTraceSummary {
  const fallbackTraceLines: string[] = [];
  const actionKeys: string[] = [];
  const failureKeys: string[] = [];
  let localWorkspaceDrift = false;
  let artifactOnlyResultCount = 0;

  for (const event of events) {
    const payload = event.payload;
    const line = summarizeSupervisorEvent(event, payload);
    if (line) {
      fallbackTraceLines.push(`${fallbackTraceLines.length + 1}. ${line}`);
    }
    const actionKey = actionFingerprint(event, payload);
    if (actionKey) {
      actionKeys.push(actionKey);
    }
    const failureKey = failureFingerprint(event, payload);
    if (failureKey) {
      failureKeys.push(failureKey);
    }
    if (detectLocalWorkspaceDrift(event, payload)) {
      localWorkspaceDrift = true;
    }
    if (resultText(payload).includes("artifactRef")) {
      artifactOnlyResultCount += 1;
    }
  }

  const repeatedAction = mostRepeated(actionKeys);
  const repeatedFailure = mostRepeated(failureKeys);
  const causalObservations = buildProjectionObservations(events).slice(-8);
  const visibleTraceLines = causalObservations.length > 0
    ? causalObservations.map((observation, index) => `${index + 1}. ${summarizeCausalObservation(observation)}`)
    : fallbackTraceLines.slice(-16).map((line) => truncateOneLine(line, 120));
  const loopSignals = [
    repeatedAction.count >= 2 ? `重复动作：${repeatedAction.key} ×${repeatedAction.count}` : "重复动作：未明显出现",
    repeatedFailure.count >= 2 ? `重复失败：${repeatedFailure.key} ×${repeatedFailure.count}` : "重复失败：未明显出现",
    `本地工作区漂移：${localWorkspaceDrift ? "是" : "否"}`,
    `大输出/Artifact 指针结果：${artifactOnlyResultCount} 条`
  ];

  return {
    actionTraceText: visibleTraceLines.length > 0
      ? visibleTraceLines.join("\n")
      : "暂无可监督的近期执行轨迹。",
    loopSignalsText: loopSignals.join("\n")
  };
}

function summarizeCausalObservation(observation: ProjectionObservation): string {
  return truncateOneLine([
    observation.intent ? `执行前意图=${observation.intent}` : undefined,
    observation.action ? `动作=${observation.action}` : undefined,
    observation.inputDigest ? `输入=${observation.inputDigest}` : undefined,
    observation.interpretation ? `后续理解=${observation.interpretation}` : "后续理解=尚未形成",
    `结果=${observation.outcomeDigest}`
  ].filter((part): part is string => Boolean(part)).join("；"), 300);
}

function summarizeSupervisorEvent(event: ExecutionEvent, payload: JsonObject): string | undefined {
  if (event.eventType === "assistant_intent") {
    const text = stringValue(payload.text, "");
    const toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls.filter(isRecord) : [];
    if (toolCalls.length > 0) {
      const intent = text ? `Executor 意图：${truncateOneLine(text, 180)}；` : "";
      return `${intent}Executor 决定调用工具：${toolCalls.map((call) => `${stringValue(call.name, "unknown")}(${truncateOneLine(JSON.stringify(compactJson(call.arguments, 0)), 180)})`).join("；")}。event=${event.id}`;
    }
    return text ? `Executor 意图：${truncateOneLine(text, 260)}。event=${event.id}` : undefined;
  }
  if (event.eventType === "message_end" || event.eventType === "turn_end") {
    return summarizeMessageEvent(event, payload);
  }
  if (event.eventType === "tool_started" || event.eventType === "tool_execution_start") {
    const toolName = stringValue(payload.toolName, "unknown");
    const argsPreview = truncateOneLine(JSON.stringify(compactJson(payload.args, 0) ?? {}), 220);
    return `计划/开始调用工具 ${toolName}，参数摘要：${argsPreview}。event=${event.id}`;
  }
  if (event.eventType === "tool_finished" || event.eventType === "tool_execution_end") {
    const toolName = stringValue(payload.toolName, "unknown");
    const status = payload.isError === true || event.summary?.includes(":error") ? "失败" : "完成";
    const outcome = truncateOneLine(resultText(payload), 260);
    return `工具 ${toolName} ${status}，结果摘要：${outcome || event.summary || "无结果摘要"}。event=${event.id}`;
  }
  if (event.eventType.startsWith("task_")) {
    const taskResult = isRecord(payload.taskResult) ? payload.taskResult : undefined;
    return `任务阶段结果：${stringValue(taskResult?.status, event.eventType)}；${truncateOneLine(stringValue(taskResult?.summary, event.summary ?? ""), 260)}。event=${event.id}`;
  }
  if (event.eventType === "executor_stop_requested") {
    const controlSignal = isRecord(payload.controlSignal) ? payload.controlSignal : undefined;
    return `运行时请求停止 Executor：${truncateOneLine(stringValue(controlSignal?.reason, event.summary ?? ""), 260)}。event=${event.id}`;
  }
  return event.summary ? `${event.eventType}: ${truncateOneLine(event.summary, 220)}。event=${event.id}` : undefined;
}

function summarizeMessageEvent(event: ExecutionEvent, payload: JsonObject): string | undefined {
  const message = isRecord(payload.message) ? payload.message : undefined;
  const role = stringValue(message?.role, "");
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolCalls = content
    .filter(isRecord)
    .filter((item) => item.type === "toolCall")
    .map((item) => {
      const name = stringValue(item.name, "unknown");
      const argsPreview = truncateOneLine(JSON.stringify(compactJson(item.arguments, 0) ?? {}), 220);
      return `${name}(${argsPreview})`;
    });
  if (toolCalls.length > 0) {
    return `Executor 决定调用工具：${toolCalls.join("；")}。event=${event.id}`;
  }
  if (role === "toolResult") {
    const text = extractContentText(content);
    return `工具结果进入上下文：${truncateOneLine(text, 260)}。event=${event.id}`;
  }
  const text = extractContentText(content);
  if (text) {
    return `${role || event.role} 输出：${truncateOneLine(text, 260)}。event=${event.id}`;
  }
  if (event.summary?.includes("budget_abort")) {
    return `Executor 因预算或外部中止结束本轮。event=${event.id}`;
  }
  return undefined;
}

function extractContentText(content: unknown[]): string {
  return content
    .filter(isRecord)
    .map((item) => {
      if (typeof item.text === "string") {
        return item.text;
      }
      if (isRecord(item.text)) {
        return JSON.stringify(compactJson(item.text, 0));
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function actionFingerprint(event: ExecutionEvent, payload: JsonObject): string | undefined {
  if (!["assistant_intent", "message_end", "turn_end", "tool_started", "tool_execution_start"].includes(event.eventType)) {
    return undefined;
  }
  const message = isRecord(payload.message) ? payload.message : undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  const legacyToolCall = content.filter(isRecord).find((item) => item.type === "toolCall");
  const canonicalToolCall = Array.isArray(payload.toolCalls) ? payload.toolCalls.filter(isRecord)[0] : undefined;
  const toolCall = canonicalToolCall ?? legacyToolCall;
  const toolName = stringValue(toolCall?.name, stringValue(payload.toolName, ""));
  const args = isRecord(toolCall?.arguments) ? toolCall.arguments : isRecord(payload.args) ? payload.args : undefined;
  if (!toolName) {
    return undefined;
  }
  return `${toolName}:${normalizeActionArgs(args)}`;
}

function failureFingerprint(event: ExecutionEvent, payload: JsonObject): string | undefined {
  const text = `${event.summary ?? ""} ${resultText(payload)} ${stringValue(payload.partialResult, "")}`.toLowerCase();
  if (text.includes("timeout") || text.includes("timed out")) {
    return "timeout";
  }
  if (text.includes("connection refused")) {
    return "connection refused";
  }
  if (text.includes("bad gateway") || text.includes("502")) {
    return "502/bad gateway";
  }
  if (text.includes("forbidden") || text.includes("403")) {
    return "403/forbidden";
  }
  if (event.summary?.includes(":error") || payload.isError === true) {
    return "tool error";
  }
  return undefined;
}

function detectLocalWorkspaceDrift(event: ExecutionEvent, payload: JsonObject): boolean {
  const text = `${event.summary ?? ""} ${JSON.stringify(compactJson(payload, 0) ?? "")} ${resultText(payload)}`.toLowerCase();
  return text.includes(".agent-runtime") || text.includes("node_modules") || text.includes("package.json") || text.includes("tsconfig.json");
}

function normalizeActionArgs(args: Record<string, unknown> | undefined): string {
  if (!args) {
    return "no-args";
  }
  const command = stringValue(args.command, "");
  if (command) {
    return truncateOneLine(command.replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, "<uuid>"), 90);
  }
  const path = stringValue(args.path, "");
  const pattern = stringValue(args.pattern, "");
  return truncateOneLine([path, pattern].filter(Boolean).join("|") || JSON.stringify(compactJson(args, 0)), 90);
}

function resultText(payload: JsonObject): string {
  if (!isRecord(payload.result)) {
    return "";
  }
  const content = Array.isArray(payload.result.content) ? payload.result.content : [];
  return extractContentText(content);
}

function mostRepeated(values: string[]): { key: string; count: number } {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = { key: "", count: 0 };
  for (const [key, count] of counts) {
    if (count > best.count) {
      best = { key, count };
    }
  }
  return best;
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
