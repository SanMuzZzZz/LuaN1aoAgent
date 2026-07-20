import type { GraphKind, Role } from "./types";

export const ROLE_LABELS: Record<string, string> = {
  planner: "Planner",
  executor: "Executor",
  observer: "Observer",
  runtime: "Runtime"
};

export const GRAPH_LABELS: Record<GraphKind, string> = {
  reasoning: "推理图",
  operation: "作战图",
  task: "任务图"
};

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role] || role || "Unknown";
}

export function graphSubtitle(kind: GraphKind): string {
  return {
    reasoning: "追踪证据、假设、漏洞与利用之间的推导关系。",
    operation: "梳理主机、服务、端点、参数与凭据组成的攻击面。",
    task: "查看范围、目标与任务的树状关系；里程碑和阻塞项收纳在所属任务中。"
  }[kind];
}

export function formatTime(value?: string): string {
  if (!value) return "-";
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toLocaleString("zh-CN", { hour12: false }) : "-";
}

export function formatRelative(value?: string): string {
  if (!value) return "-";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "-";
  const diff = Date.now() - time;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function shortRef(value?: string, max = 38): string {
  if (!value) return "-";
  return value.length > max ? `${value.slice(0, Math.ceil(max / 2))}…${value.slice(-Math.floor(max / 3))}` : value;
}

export function valueText(value: unknown): string {
  if (value == null) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function isRecent(value?: string): boolean {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && Date.now() - time < 120_000;
}
