import { formatDateTime, formatRelativeTime, getLocale, translate, type Locale } from "./language";
import type { GraphKind, Role } from "./types";

export const ROLE_LABELS: Record<string, string> = {
  planner: "Planner",
  executor: "Executor",
  observer: "Observer",
  runtime: "Runtime"
};

export function graphLabel(kind: GraphKind, locale: Locale = getLocale()): string {
  return translate(kind === "reasoning" ? "nav.reasoning" : kind === "operation" ? "nav.operation" : "nav.task", undefined, locale);
}

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role] || role || translate("common.unknown");
}

export function graphSubtitle(kind: GraphKind, locale: Locale = getLocale()): string {
  return translate(kind === "reasoning" ? "graph.reasoningSubtitle" : kind === "operation" ? "graph.operationSubtitle" : "graph.taskSubtitle", undefined, locale);
}

export function statusLabel(status?: string, locale: Locale = getLocale()): string {
  if (!status) return status || "-";
  const keys = {
    live: "status.live",
    degraded: "status.degraded",
    stale: "status.stale",
    closed: "status.closed",
    running: "status.running",
    stopped: "status.stopped",
    completed: "status.completed",
    blocked: "status.blocked",
    pending: "status.pending",
    failed: "status.failed"
  } as const;
  const key = keys[status as keyof typeof keys];
  return key ? translate(key, undefined, locale) : status;
}

export function formatTime(value?: string): string {
  return formatDateTime(value, getLocale());
}

export function formatRelative(value?: string): string {
  return formatRelativeTime(value, getLocale());
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
