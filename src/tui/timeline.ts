import { Text, type Component } from "@earendil-works/pi-tui";
import type { ExecutionEvent } from "../types.js";

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  blue: "\u001b[34m",
  green: "\u001b[32m",
  magenta: "\u001b[35m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  brightCyan: "\u001b[96m"
} as const;

type ToolPresentation = {
  toolCallId: string;
  name: string;
  args?: unknown;
  status: "pending" | "running" | "completed" | "failed";
  result?: unknown;
  artifactRefs: string[];
};

type ActionPresentation = {
  id: string;
  taskId?: string;
  role: ExecutionEvent["role"];
  intent?: string;
  tools: ToolPresentation[];
};

type TimelineItem =
  | { kind: "action"; id: string; action: ActionPresentation }
  | { kind: "control"; id: string; text: string };

type TaskStatus = "running" | "completed" | "partial" | "blocked" | "failed" | "interrupted";

type TaskPresentation = {
  taskId: string;
  label: string;
  goal?: string;
  parallelGroup?: string;
  attempt?: number;
  status: TaskStatus;
  color: string;
};

export type TimelineStatus = "starting" | "running" | "interrupting" | "completed" | "failed";

export type ArtifactDetailLoader = (artifactRef: string) => Promise<string>;

export class AgentTimeline implements Component {
  private readonly events: ExecutionEvent[] = [];
  private readonly seenEventIds = new Set<string>();
  private readonly taskOrdinals = new Map<string, number>();
  private status: TimelineStatus = "starting";
  private statusDetail = "正在初始化运行时";
  private goal = "";
  private runtimeDir?: string;
  private resumed = false;
  private taskFilter?: string;
  private selectedActionId?: string;
  private selectionPinned = false;
  private readonly expandedActionIds = new Set<string>();
  private readonly artifactDetails = new Map<string, string>();
  private readonly loadingArtifactRefs = new Set<string>();

  constructor(
    private readonly maxEvents = 500,
    private readonly loadArtifactDetail?: ArtifactDetailLoader
  ) {}

  setGoal(goal: string): void {
    this.goal = goal;
  }

  setRuntime(runtimeDir: string, resumed: boolean): void {
    this.runtimeDir = runtimeDir;
    this.resumed = resumed;
  }

  ingest(event: ExecutionEvent): void {
    if (this.seenEventIds.has(event.id)) {
      return;
    }
    this.seenEventIds.add(event.id);
    if (event.taskId && !this.taskOrdinals.has(event.taskId)) {
      this.taskOrdinals.set(event.taskId, this.taskOrdinals.size + 1);
    }
    this.events.push(event);
    while (this.events.length > this.maxEvents) {
      const removed = this.events.shift();
      if (removed) {
        this.seenEventIds.delete(removed.id);
      }
    }
  }

  setStatus(status: TimelineStatus, detail: string): void {
    this.status = status;
    this.statusDetail = detail;
  }

  cycleTaskFilter(direction = 1): void {
    const taskIds = [...buildTaskPresentation(this.events, this.taskOrdinals).keys()];
    if (taskIds.length === 0) {
      this.taskFilter = undefined;
      return;
    }
    const choices: Array<string | undefined> = [undefined, ...taskIds];
    const currentIndex = choices.indexOf(this.taskFilter);
    const nextIndex = (currentIndex + direction + choices.length) % choices.length;
    this.taskFilter = choices[nextIndex];
    this.selectionPinned = false;
    this.selectedActionId = undefined;
    this.syncSelectedAction(this.timelineItems());
  }

  moveActionSelection(direction: number): void {
    const items = this.timelineItems();
    const actions = items.filter((item): item is Extract<TimelineItem, { kind: "action" }> => item.kind === "action");
    if (actions.length === 0) {
      this.selectedActionId = undefined;
      return;
    }
    const currentIndex = actions.findIndex((item) => item.id === this.selectedActionId);
    const baseIndex = currentIndex < 0 ? actions.length - 1 : currentIndex;
    const nextIndex = (baseIndex + direction + actions.length) % actions.length;
    this.selectedActionId = actions[nextIndex].id;
    this.selectionPinned = true;
  }

  async toggleSelectedAction(): Promise<void> {
    const items = this.timelineItems();
    this.syncSelectedAction(items);
    if (!this.selectedActionId) {
      return;
    }
    if (this.expandedActionIds.delete(this.selectedActionId)) {
      return;
    }
    this.expandedActionIds.add(this.selectedActionId);
    const action = items.find((item): item is Extract<TimelineItem, { kind: "action" }> =>
      item.kind === "action" && item.id === this.selectedActionId
    )?.action;
    if (!action || !this.loadArtifactDetail) {
      return;
    }
    const refs = [...new Set(action.tools.flatMap((tool) => tool.artifactRefs))]
      .filter((ref) => !this.artifactDetails.has(ref) && !this.loadingArtifactRefs.has(ref));
    await Promise.all(refs.map(async (ref) => {
      this.loadingArtifactRefs.add(ref);
      try {
        this.artifactDetails.set(ref, await this.loadArtifactDetail!(ref));
      } catch (error) {
        this.artifactDetails.set(ref, `无法读取完整输出: ${errorMessage(error)}`);
      } finally {
        this.loadingArtifactRefs.delete(ref);
      }
    }));
  }

  invalidate(): void {}

  render(width: number): string[] {
    const contentWidth = Math.max(20, width - 2);
    const lines: string[] = [];
    const header = new Text(
      `${ANSI.bold}${ANSI.cyan}Agent 工作台${ANSI.reset}\n` +
      `${ANSI.dim}目标${ANSI.reset}  ${this.goal || "未指定"}` +
      (this.runtimeDir
        ? `\n${ANSI.dim}${this.resumed ? "恢复运行" : "新运行"}${ANSI.reset}  ${this.runtimeDir}`
        : ""),
      1,
      0
    );
    lines.push(...header.render(width));
    lines.push("");

    const tasks = buildTaskPresentation(this.events, this.taskOrdinals);
    const items = this.timelineItems(tasks);
    this.syncSelectedAction(items);
    if (items.length === 0) {
      lines.push(...new Text(`${ANSI.dim}等待 Agent 事件...${ANSI.reset}`, 1, 0).render(width));
    } else {
      for (const item of items) {
        const text = item.kind === "action"
          ? renderAction({
            action: item.action,
            tasks,
            selected: item.id === this.selectedActionId,
            expanded: this.expandedActionIds.has(item.id),
            artifactDetails: this.artifactDetails,
            loadingArtifactRefs: this.loadingArtifactRefs
          })
          : item.text;
        lines.push(...new Text(text, 1, 0).render(width));
        lines.push("");
      }
    }

    const statusColor = this.status === "failed"
      ? ANSI.red
      : this.status === "completed"
        ? ANSI.green
        : this.status === "interrupting"
          ? ANSI.yellow
          : ANSI.cyan;
    const filterLabel = this.taskFilter
      ? `筛选 ${taskInlineLabel(tasks.get(this.taskFilter))}`
      : "全部任务";
    const footer = `${statusColor}${statusLabel(this.status)}${ANSI.reset}  ${this.statusDetail}` +
      (this.status === "running"
        ? `  ${ANSI.dim}↑↓ 动作 · Enter 展开 · Tab 任务 · Ctrl+C 中断${ANSI.reset}`
        : "");
    lines.push(...new Text(footer, 1, 0).render(contentWidth + 2));
    if (tasks.size > 0) {
      lines.push(...new Text(
        `${ANSI.dim}${filterLabel}${ANSI.reset}  ${taskStatusSummary(tasks)}`,
        1,
        0
      ).render(contentWidth + 2));
    }
    return lines;
  }

  private timelineItems(tasks = buildTaskPresentation(this.events, this.taskOrdinals)): TimelineItem[] {
    const visibleEvents = this.taskFilter
      ? this.events.filter((event) => !event.taskId || event.taskId === this.taskFilter)
      : this.events;
    return projectExecutionEvents(visibleEvents, tasks);
  }

  private syncSelectedAction(items: TimelineItem[]): void {
    const actions = items.filter((item): item is Extract<TimelineItem, { kind: "action" }> => item.kind === "action");
    const actionIds = actions.map((item) => item.id);
    for (const actionId of this.expandedActionIds) {
      if (!actionIds.includes(actionId)) {
        this.expandedActionIds.delete(actionId);
      }
    }
    const artifactRefs = new Set(actions.flatMap((item) => item.action.tools.flatMap((tool) => tool.artifactRefs)));
    for (const artifactRef of this.artifactDetails.keys()) {
      if (!artifactRefs.has(artifactRef)) {
        this.artifactDetails.delete(artifactRef);
      }
    }
    if (!this.selectionPinned) {
      this.selectedActionId = actionIds.at(-1);
      return;
    }
    if (this.selectedActionId && actionIds.includes(this.selectedActionId)) {
      return;
    }
    this.selectionPinned = false;
    this.selectedActionId = actionIds.at(-1);
  }
}

export function projectExecutionEvents(
  events: ExecutionEvent[],
  tasks = buildTaskPresentation(events)
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const actionIndexByTool = new Map<string, number>();

  const actionForTool = (event: ExecutionEvent, toolCallId: string, toolName: string): ActionPresentation => {
    const key = toolKey(event, toolCallId);
    const existingIndex = actionIndexByTool.get(key);
    if (existingIndex !== undefined) {
      const existing = items[existingIndex];
      if (existing?.kind === "action") {
        return existing.action;
      }
    }
    const action: ActionPresentation = {
      id: `action:${event.id}`,
      taskId: event.taskId,
      role: event.role,
      tools: [{ toolCallId, name: toolName, status: "pending", artifactRefs: [] }]
    };
    actionIndexByTool.set(key, items.length);
    items.push({ kind: "action", id: action.id, action });
    return action;
  };

  for (const event of events) {
    if (event.eventType === "epoch_transition" && stringValue(event.payload.state) === "running") {
      const task = event.taskId ? tasks.get(event.taskId) : undefined;
      if (task) {
        const detail = [
          task.taskId,
          task.parallelGroup ? `并行组 ${task.parallelGroup}` : undefined,
          task.attempt ? `第 ${task.attempt} 轮` : undefined
        ].filter((value): value is string => Boolean(value)).join(" · ");
        items.push({
          kind: "control",
          id: event.id,
          text: `${task.color}${ANSI.bold}${task.label} ${task.attempt && task.attempt > 1 ? "任务恢复" : "任务开始"}${ANSI.reset}` +
            (task.goal ? `\n${sanitizeTerminalText(task.goal)}` : "") +
            (detail ? `\n${ANSI.dim}${detail}${ANSI.reset}` : "")
        });
      }
      continue;
    }

    if (event.eventType === "assistant_intent") {
      const intent = stringValue(event.payload.text) ?? event.summary;
      const declaredTools = toolCallDeclarations(event.payload.toolCalls);
      const existingActionIndex = declaredTools
        .map((tool) => actionIndexByTool.get(toolKey(event, tool.toolCallId)))
        .find((index): index is number => index !== undefined);
      let action: ActionPresentation;
      if (existingActionIndex !== undefined && items[existingActionIndex]?.kind === "action") {
        action = items[existingActionIndex].action;
        action.intent = intent;
      } else {
        action = {
          id: event.id,
          taskId: event.taskId,
          role: event.role,
          intent,
          tools: []
        };
        items.push({ kind: "action", id: action.id, action });
      }
      for (const declaration of declaredTools) {
        let tool = action.tools.find((candidate) => candidate.toolCallId === declaration.toolCallId);
        if (!tool) {
          tool = {
            toolCallId: declaration.toolCallId,
            name: declaration.name,
            args: declaration.args,
            status: "pending",
            artifactRefs: []
          };
          action.tools.push(tool);
        } else {
          tool.name = declaration.name;
          tool.args = declaration.args;
        }
        actionIndexByTool.set(toolKey(event, declaration.toolCallId), items.findIndex((item) =>
          item.kind === "action" && item.action === action
        ));
      }
      continue;
    }

    if (event.eventType === "tool_started") {
      const toolCallId = stringValue(event.payload.toolCallId) ?? event.id;
      const toolName = stringValue(event.payload.toolName) ?? event.summary ?? "tool";
      const action = actionForTool(event, toolCallId, toolName);
      const tool = action.tools.find((candidate) => candidate.toolCallId === toolCallId)!;
      tool.name = toolName;
      tool.args = event.payload.args ?? tool.args;
      tool.status = "running";
      continue;
    }

    if (
      event.eventType === "tool_finished" ||
      (event.eventType === "runtime_control" && typeof event.payload.toolCallId === "string")
    ) {
      const toolCallId = stringValue(event.payload.toolCallId) ?? event.id;
      const toolName = stringValue(event.payload.toolName) ?? event.summary ?? "tool";
      const action = actionForTool(event, toolCallId, toolName);
      const tool = action.tools.find((candidate) => candidate.toolCallId === toolCallId)!;
      tool.name = toolName;
      tool.status = event.payload.isError === true ? "failed" : "completed";
      tool.result = event.payload.result;
      tool.artifactRefs = [...new Set([...(tool.artifactRefs ?? []), ...(event.artifactRefs ?? [])])];
      continue;
    }

    if (shouldShowControlEvent(event)) {
      items.push({
        kind: "control",
        id: event.id,
        text: `${roleLabel(event, tasks)} ${ANSI.bold}${controlEventLabel(event.eventType)}${ANSI.reset}` +
          (event.summary ? `\n${sanitizeTerminalText(event.summary)}` : "")
      });
    }
  }

  return items;
}

function renderAction(input: {
  action: ActionPresentation;
  tasks: Map<string, TaskPresentation>;
  selected: boolean;
  expanded: boolean;
  artifactDetails: Map<string, string>;
  loadingArtifactRefs: Set<string>;
}): string {
  const { action, selected, expanded } = input;
  const marker = selected ? `${ANSI.yellow}›${ANSI.reset}` : " ";
  const lines = [`${marker} ${actionRoleLabel(action, input.tasks)} ${ANSI.bold}Action${ANSI.reset}`];
  if (action.intent) {
    const safeIntent = sanitizeTerminalText(action.intent);
    const intent = expanded ? safeIntent : previewText(safeIntent, 420, 3).text;
    lines.push(`  ${ANSI.bold}思考${ANSI.reset}`);
    lines.push(...indentText(intent, "  "));
  }
  for (const [index, tool] of action.tools.entries()) {
    const lastTool = index === action.tools.length - 1;
    const branch = lastTool ? "└─" : "├─";
    const continuation = lastTool ? "  " : "│ ";
    const status = toolStatusPresentation(tool.status);
    lines.push(`  ${branch} ${ANSI.yellow}调用 ${tool.name}${ANSI.reset} ${status.color}${status.label}${ANSI.reset}`);
    const args = expanded ? prettyJson(tool.args) : compactJson(tool.args);
    if (args) {
      const shownArgs = expanded ? args : previewText(args, 360, 2).text;
      lines.push(`  ${continuation} ${ANSI.dim}参数${ANSI.reset}`);
      lines.push(...indentText(shownArgs, `  ${continuation} `));
    }
    const output = toolOutput(tool, expanded, input.artifactDetails, input.loadingArtifactRefs);
    if (output) {
      lines.push(`  ${continuation} ${ANSI.dim}${expanded ? "返回详情" : "返回 preview"}${ANSI.reset}`);
      lines.push(...indentText(output, `  ${continuation} `));
    } else if (tool.status === "running" || tool.status === "pending") {
      lines.push(`  ${continuation} ${ANSI.dim}等待工具返回...${ANSI.reset}`);
    }
  }
  if (selected && (action.intent || action.tools.length > 0)) {
    lines.push(`  ${ANSI.dim}Enter ${expanded ? "收起详情" : "展开详情"}${ANSI.reset}`);
  }
  return lines.join("\n");
}

function toolOutput(
  tool: ToolPresentation,
  expanded: boolean,
  artifactDetails: Map<string, string>,
  loadingArtifactRefs: Set<string>
): string {
  const inlineOutput = extractToolOutput(tool.result);
  if (!expanded) {
    return previewText(inlineOutput, 700, 5).text;
  }
  if (tool.artifactRefs.length === 0) {
    return inlineOutput;
  }
  const details = tool.artifactRefs.flatMap((ref) => {
    const detail = artifactDetails.get(ref);
    if (detail !== undefined) {
      return [`${ANSI.dim}[${ref}]${ANSI.reset}\n${sanitizeTerminalText(detail)}`];
    }
    if (loadingArtifactRefs.has(ref)) {
      return [`${ANSI.dim}[${ref}] 正在读取完整输出...${ANSI.reset}`];
    }
    return [`${ANSI.dim}[${ref}] 完整输出尚未载入${ANSI.reset}`];
  });
  return details.join("\n");
}

function previewText(value: string, maxCharacters: number, maxLines: number): { text: string; truncated: boolean } {
  if (!value) {
    return { text: "", truncated: false };
  }
  const sourceLines = value.split("\n");
  const visibleLines = sourceLines.slice(0, maxLines);
  let text = visibleLines.join("\n");
  let truncated = sourceLines.length > maxLines;
  if (text.length > maxCharacters) {
    text = text.slice(0, maxCharacters);
    truncated = true;
  }
  return {
    text: truncated ? `${text}\n${ANSI.dim}...${ANSI.reset}` : text,
    truncated
  };
}

function indentText(value: string, prefix: string): string[] {
  return value.split("\n").map((line) => `${prefix}${line}`);
}

function toolStatusPresentation(status: ToolPresentation["status"]): { label: string; color: string } {
  return ({
    pending: { label: "待执行", color: ANSI.dim },
    running: { label: "运行中", color: ANSI.yellow },
    completed: { label: "完成", color: ANSI.green },
    failed: { label: "失败", color: ANSI.red }
  } as const)[status];
}

function toolCallDeclarations(value: unknown): Array<{ toolCallId: string; name: string; args?: unknown }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    const declaration = recordValue(candidate);
    const toolCallId = stringValue(declaration?.id);
    const name = stringValue(declaration?.name);
    return toolCallId && name
      ? [{ toolCallId, name, args: declaration?.arguments }]
      : [];
  });
}

function toolKey(event: Pick<ExecutionEvent, "taskId" | "role">, toolCallId: string): string {
  return `${event.taskId ?? event.role}:${toolCallId}`;
}

export function extractToolOutput(value: unknown): string {
  const textParts: string[] = [];
  collectOutputText(value, textParts);
  return sanitizeTerminalText(textParts.join("\n").trim());
}

export function buildTaskPresentation(
  events: ExecutionEvent[],
  taskOrdinals = new Map<string, number>()
): Map<string, TaskPresentation> {
  const tasks = new Map<string, TaskPresentation>();
  const ensureTask = (taskId: string): TaskPresentation => {
    const existing = tasks.get(taskId);
    if (existing) {
      return existing;
    }
    const task: TaskPresentation = {
      taskId,
      label: `T${taskOrdinals.get(taskId) ?? tasks.size + 1}`,
      status: "running",
      color: taskColor(taskId)
    };
    tasks.set(taskId, task);
    return task;
  };

  for (const event of events) {
    if (event.taskId) {
      const task = ensureTask(event.taskId);
      if (event.eventType === "epoch_transition" && stringValue(event.payload.state) === "running") {
        const envelope = recordValue(event.payload.taskEnvelope);
        task.goal = stringValue(envelope?.goal) ?? task.goal;
        task.parallelGroup = stringValue(envelope?.parallelGroup) ?? task.parallelGroup;
        task.attempt = numberValue(event.payload.attempt) ?? task.attempt;
        task.status = "running";
      }
      const terminalStatus = taskStatusForEvent(event.eventType);
      if (terminalStatus) {
        task.status = terminalStatus;
      }
    }
    if (event.eventType === "run_interrupted") {
      for (const task of tasks.values()) {
        if (task.status === "running") {
          task.status = "interrupted";
        }
      }
    }
  }
  return tasks;
}

function collectOutputText(value: unknown, target: string[]): void {
  if (typeof value === "string") {
    target.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectOutputText(item, target);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if ("preview" in value && typeof value.preview === "string") {
    target.push(value.preview);
    return;
  }
  if ("content" in value) {
    collectOutputText(value.content, target);
    return;
  }
  if ("text" in value) {
    collectOutputText(value.text, target);
  }
}

function shouldShowControlEvent(event: ExecutionEvent): boolean {
  if (event.eventType.startsWith("run_")) {
    return true;
  }
  return [
    "planner_cycle_started",
    "planner_cycle_completed",
    "task_started",
    "task_completed",
    "task_partial",
    "task_blocked",
    "task_failed",
    "supervisor_check_succeeded",
    "projection_job_succeeded",
    "provider_error"
  ].includes(event.eventType);
}

function controlEventLabel(eventType: string): string {
  return ({
    run_started: "运行开始",
    run_result_decided: "运行结果已确定",
    run_interrupted: "运行已中断",
    run_completed: "运行结束",
    run_failed: "运行失败",
    planner_cycle_started: "Planner 开始规划",
    planner_cycle_completed: "Planner 完成规划",
    task_started: "任务开始",
    task_completed: "任务完成",
    task_partial: "任务阶段完成",
    task_blocked: "任务阻塞",
    task_failed: "任务失败",
    supervisor_check_succeeded: "Supervisor 检查完成",
    projection_job_succeeded: "Observer 投影完成",
    provider_error: "模型调用错误"
  } as Record<string, string>)[eventType] ?? eventType;
}

function roleLabel(event: ExecutionEvent, tasks: Map<string, TaskPresentation>): string {
  const task = event.taskId ? tasks.get(event.taskId) : undefined;
  if (!task) {
    return `${ANSI.cyan}[${event.role}]${ANSI.reset}`;
  }
  return `${task.color}[${event.role} · ${taskInlineLabel(task)}]${ANSI.reset}`;
}

function actionRoleLabel(action: ActionPresentation, tasks: Map<string, TaskPresentation>): string {
  const task = action.taskId ? tasks.get(action.taskId) : undefined;
  if (!task) {
    return `${ANSI.cyan}[${action.role}]${ANSI.reset}`;
  }
  return `${task.color}[${action.role} · ${taskInlineLabel(task)}]${ANSI.reset}`;
}

function statusLabel(status: TimelineStatus): string {
  return ({
    starting: "初始化",
    running: "运行中",
    interrupting: "正在中断",
    completed: "已完成",
    failed: "失败"
  } as const)[status];
}

function compactJson(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  const serialized = JSON.stringify(value);
  return serialized.length > 600 ? `${serialized.slice(0, 600)}...` : serialized;
}

function prettyJson(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}

function taskInlineLabel(task: TaskPresentation | undefined): string {
  if (!task) {
    return "未知任务";
  }
  return task.goal
    ? `${task.label} ${truncatePlain(sanitizeTerminalText(task.goal), 22)}`
    : `${task.label} ${sanitizeTerminalText(task.taskId)}`;
}

function taskStatusSummary(tasks: Map<string, TaskPresentation>): string {
  const counts = new Map<TaskStatus, number>();
  for (const task of tasks.values()) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }
  const parts = ([
    ["running", "运行", ANSI.cyan],
    ["completed", "完成", ANSI.green],
    ["partial", "阶段", ANSI.yellow],
    ["blocked", "阻塞", ANSI.yellow],
    ["failed", "失败", ANSI.red],
    ["interrupted", "中断", ANSI.magenta]
  ] as Array<[TaskStatus, string, string]>).flatMap(([status, label, color]) => {
    const count = counts.get(status) ?? 0;
    return count > 0 ? [`${color}${label} ${count}${ANSI.reset}`] : [];
  });
  return `${ANSI.bold}Executor${ANSI.reset} ${parts.join(` ${ANSI.dim}·${ANSI.reset} `)}`;
}

function taskStatusForEvent(eventType: string): TaskStatus | undefined {
  return ({
    task_completed: "completed",
    task_partial: "partial",
    task_blocked: "blocked",
    task_failed: "failed"
  } as Partial<Record<string, TaskStatus>>)[eventType];
}

function taskColor(taskId: string): string {
  const colors = [ANSI.cyan, ANSI.magenta, ANSI.blue, ANSI.yellow, ANSI.green, ANSI.brightCyan];
  let hash = 0;
  for (const character of taskId) {
    hash = ((hash * 31) + character.codePointAt(0)!) >>> 0;
  }
  return colors[hash % colors.length];
}

function truncatePlain(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 3))}...` : value;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeTerminalText(value: string): string {
  const withoutAnsi = value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n");
  return [...withoutAnsi].filter((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint === 9 || codePoint === 10 || (codePoint >= 32 && codePoint !== 127);
  }).join("");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
