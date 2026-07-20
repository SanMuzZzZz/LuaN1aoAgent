import { basename, dirname } from "node:path";

export type TraceIntentSource = "recorded" | "structured" | "derived";

export type TraceToolCall = {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type TraceIntentPresentation = {
  text: string;
  source: TraceIntentSource;
};

export function selectExactToolCallId(calls: TraceToolCall[], availableIds: ReadonlySet<string>): string | undefined {
  return calls.find((call) => call.id && availableIds.has(call.id))?.id;
}

export function selectTraceIntent(input: {
  role: string;
  recordedText?: unknown;
  call?: TraceToolCall;
  relatedReasons?: unknown[];
}): TraceIntentPresentation {
  const recorded = textValue(input.recordedText);
  if (recorded) return { text: recorded, source: "recorded" };

  const structured = structuredIntent(input.call, input.relatedReasons ?? []);
  if (structured) return { text: structured, source: "structured" };

  return {
    text: deriveToolPurpose(input.role, input.call),
    source: "derived"
  };
}

export function summarizeTraceAction(call: TraceToolCall | undefined): string | undefined {
  if (!call) return undefined;
  const args = call.arguments;
  switch (call.name) {
    case "read":
      return `读取资料 · ${compactPath(textValue(args.path)) || "未指定路径"}`;
    case "artifact_read":
      return `读取 Artifact · ${textValue(args.artifactRef) || textValue(args.path) || "未指定引用"}`;
    case "bash":
      return summarizeBashAction(textValue(args.command));
    case "artifact_write":
      return `归档 Artifact · ${[textValue(args.kind), textValue(args.mediaType)].filter(Boolean).join(" / ") || "运行材料"}`;
    case "task_result_submit":
      return `提交任务结果 · ${textValue(args.status) || "unknown"}`;
    case "planner_submit":
      return summarizePlannerAction(args);
    case "control_submit":
      return `提交监督信号 · ${textValue(args.decision) || "unknown"}`;
    case "graph_delta_submit":
      return `提交图增量 · ${arrayLength(args.nodes)} 节点 / ${arrayLength(args.edges)} 关系`;
    default: {
      const path = compactPath(textValue(args.path));
      const taskId = textValue(args.taskId);
      const decision = textValue(args.decision);
      return [call.name, path || taskId || decision].filter(Boolean).join(" · ");
    }
  }
}

export function traceActionHeading(role: string, call: TraceToolCall | undefined): { title: string; eventLabel: string } {
  if (role === "planner") {
    const decision = textValue(call?.arguments.decision);
    return decision === "need_user_input"
      ? { title: "Planner 请求用户输入", eventLabel: "规划判断" }
      : { title: "Planner 更新任务计划", eventLabel: "规划判断" };
  }
  if (role === "observer") {
    return call?.name === "control_submit"
      ? { title: "Observer 提交监督判断", eventLabel: "监督判断" }
      : { title: "Observer 更新三图", eventLabel: "证据投影" };
  }
  switch (call?.name) {
    case "read": return { title: "Executor 读取任务资料", eventLabel: "执行动作" };
    case "artifact_read": return { title: "Executor 读取关联 Artifact", eventLabel: "执行动作" };
    case "bash": return { title: "Executor 执行验证", eventLabel: "执行动作" };
    case "artifact_write": return { title: "Executor 归档执行证据", eventLabel: "证据归档" };
    case "task_result_submit": return { title: "Executor 提交任务结果", eventLabel: "任务结果" };
    default: return { title: "Executor 执行动作", eventLabel: "执行动作" };
  }
}

export function traceNextStep(role: string, call: TraceToolCall | undefined, completed: boolean): string {
  if (!completed) return "工具仍在运行或等待最终事件。";
  if (role === "planner") return "规划决策已提交，等待 Controller 应用任务图变更。";
  if (role === "observer" && call?.name === "control_submit") return "监督判断已提交，等待 Controller 执行控制信号。";
  if (role === "observer") return "图增量已提交，等待 Runtime 校验并合并。";
  if (call?.name === "task_result_submit") return "任务结果已提交，等待 Controller 与 Planner 更新任务状态。";
  if (call?.name === "artifact_write") return "执行材料已归档，可供任务结果和后续步骤引用。";
  return "工具调用已完成，等待 Executor 消化结果或推进任务。";
}

function structuredIntent(call: TraceToolCall | undefined, relatedReasons: unknown[]): string | undefined {
  const args = call?.arguments ?? {};
  if (call?.name === "planner_submit") {
    const commands = arrayRecords(args.commands);
    const commandReasons = commands.map((command) => textValue(command.reason)).filter((value): value is string => Boolean(value));
    if (commands.length === 1 && commandReasons[0]) return commandReasons[0];
    const reason = textValue(args.reason);
    if (reason) return reason;
    if (commandReasons.length) return truncate(commandReasons.join("；"), 360);
  }
  if (call?.name === "task_result_submit") {
    const summary = textValue(args.summary);
    if (summary) return summary;
    const checkpointReason = textValue(args.checkpointReason);
    if (checkpointReason) return checkpointReason;
  }
  const directReason = textValue(args.reason);
  if (directReason) return directReason;
  for (const reason of relatedReasons) {
    const text = textValue(reason);
    if (text) return text;
  }
  return undefined;
}

function deriveToolPurpose(role: string, call: TraceToolCall | undefined): string {
  if (!call) return `${roleLabel(role)} 正在推进当前任务。`;
  const args = call.arguments;
  switch (call.name) {
    case "read": {
      const path = textValue(args.path);
      if (path?.endsWith("/SKILL.md")) {
        const skillName = basename(dirname(path));
        return `读取 ${skillName} 技能指南，加载当前任务所需的验证方法。`;
      }
      return `读取 ${compactPath(path) || "相关资料"}，补充当前任务所需上下文。`;
    }
    case "artifact_read":
      return "读取关联 Artifact，恢复此前执行产生的关键证据与上下文。";
    case "bash": {
      const command = textValue(args.command);
      const target = firstUrl(command);
      if (command?.includes("curl")) {
        return target
          ? `对 ${target} 执行受控 HTTP 验证，收集响应与直接证据。`
          : "执行受控 HTTP 验证，收集目标响应与直接证据。";
      }
      return "执行受控命令，验证当前任务目标并收集直接证据。";
    }
    case "artifact_write":
      return "归档本轮关键证据与执行结果，供任务结论和后续步骤引用。";
    case "task_result_submit":
      return "汇总当前任务的验证结果、证据与后续建议，并提交任务状态。";
    case "graph_delta_submit":
      return `将本轮观察投影为 ${arrayLength(args.nodes)} 个节点和 ${arrayLength(args.edges)} 条关系，更新三图状态。`;
    case "planner_submit":
      return "根据当前任务与图状态提交下一步规划决策。";
    case "control_submit":
      return "根据近期执行进展提交监督判断，决定 Executor 是否继续或收束。";
    default:
      return `${roleLabel(role)} 选择 ${call.name} 推进当前任务。`;
  }
}

function summarizeBashAction(command: string | undefined): string {
  if (!command) return "执行验证命令";
  const target = firstUrl(command);
  if (command.includes("curl")) {
    const explicitMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
      .filter((method) => new RegExp(`(?:-X\\s+${method}\\b|\\b${method}\\s+https?://)`, "i").test(command));
    const methods = explicitMethods.length
      ? explicitMethods
      : /(?:^|\s)(?:-I|--head)(?:\s|$)/.test(command)
        ? ["HEAD"]
        : /(?:--data(?:-raw|-binary|-urlencode)?|-d)(?:\s|=)/.test(command)
          ? ["POST"]
          : ["GET"];
    const methodSummary = methods.length ? [...new Set(methods)].join("/") : "HTTP";
    return `HTTP 验证 · ${methodSummary}${target ? ` · ${target}` : ""}`;
  }
  return `执行验证命令 · ${truncate(oneLine(command), 120)}`;
}

function summarizePlannerAction(args: Record<string, unknown>): string {
  const decision = textValue(args.decision) || "unknown";
  const commands = arrayRecords(args.commands);
  if (!commands.length) return `提交规划决策 · ${decision}`;
  const kinds = [...new Set(commands.map((command) => textValue(command.kind)).filter((value): value is string => Boolean(value)))];
  return `提交规划决策 · ${decision} · ${kinds.join(" / ")}`;
}

function compactPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const name = basename(path);
  const parent = basename(dirname(path));
  return parent && parent !== "." ? `${parent}/${name}` : name;
}

function firstUrl(value: string | undefined): string | undefined {
  return value?.match(/https?:\/\/[^\s'"`]+/i)?.[0]?.replace(/[),;]+$/, "");
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function roleLabel(role: string): string {
  if (role === "planner") return "Planner";
  if (role === "observer") return "Observer";
  if (role === "executor") return "Executor";
  return role || "Agent";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
