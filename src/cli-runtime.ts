import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CliOptions } from "./cli-options.js";

export type CliRunContext = {
  runtimeDir: string;
  userGoal: string;
  scopeSummary: string;
  resumed: boolean;
};

type StoredRunIdentity = {
  userGoal?: string;
  scopeSummary?: string;
};

export function resolveCliRunContext(
  options: CliOptions,
  cwd: string,
  input: { now?: Date; uniqueId?: string } = {}
): CliRunContext {
  if (options.resumeDir) {
    const runtimeDir = resolveResumeRuntime(cwd, options.resumeDir);
    const stored = readStoredRunIdentity(runtimeDir);
    if (!stored.userGoal) {
      throw new Error(`Cannot resume ${runtimeDir}: the session has no stored Root Goal`);
    }
    if (!stored.scopeSummary) {
      throw new Error(`Cannot resume ${runtimeDir}: the session has no stored authorized scope`);
    }
    return {
      runtimeDir,
      userGoal: stored.userGoal,
      scopeSummary: stored.scopeSummary,
      resumed: true
    };
  }

  if (options.runtimeDir) {
    const runtimeDir = absolutePath(cwd, options.runtimeDir);
    assertFreshRuntimeDir(runtimeDir);
    return { runtimeDir, userGoal: options.goal, scopeSummary: options.scope, resumed: false };
  }

  const timestamp = formatTimestamp(input.now ?? new Date());
  const uniqueId = input.uniqueId ?? randomUUID().slice(0, 8);
  const runtimeDir = join(cwd, ".agent-runtime", "sessions", `${timestamp}-${uniqueId}`);
  assertFreshRuntimeDir(runtimeDir);
  return { runtimeDir, userGoal: options.goal, scopeSummary: options.scope, resumed: false };
}

function readStoredRunIdentity(runtimeDir: string): StoredRunIdentity {
  const databasePath = join(runtimeDir, "state.sqlite");
  if (!existsSync(databasePath)) {
    throw new Error(`Cannot resume ${runtimeDir}: state.sqlite does not exist`);
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rootGoal = tryGet(database, "SELECT label FROM nodes WHERE id = 'goal:root'") as { label?: string } | undefined;
    const rootScope = tryGet(database, "SELECT properties_json FROM nodes WHERE id = 'scope:root'") as {
      properties_json?: string;
    } | undefined;
    const scopeProperties = parseJsonObject(rootScope?.properties_json);
    const latestRun = tryGet(database, `
      SELECT payload_json FROM execution_events
      WHERE event_type = 'run_started' ORDER BY seq DESC LIMIT 1
    `) as { payload_json?: string } | undefined;
    const payload = parseJsonObject(latestRun?.payload_json);
    return {
      userGoal: rootGoal?.label ?? stringValue(payload?.userGoal),
      scopeSummary: stringValue(scopeProperties?.summary) ?? stringValue(payload?.scopeSummary)
    };
  } finally {
    database.close();
  }
}

function tryGet(database: DatabaseSync, sql: string): unknown {
  try {
    return database.prepare(sql).get();
  } catch {
    return undefined;
  }
}

function assertFreshRuntimeDir(runtimeDir: string): void {
  if (existsSync(runtimeDir) && readdirSync(runtimeDir).length > 0) {
    throw new Error(
      `Runtime directory already contains state: ${runtimeDir}. ` +
      "Use --resume to continue it or choose a new --runtime-dir."
    );
  }
}

function absolutePath(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function resolveResumeRuntime(cwd: string, value: string): string {
  const directPath = absolutePath(cwd, value);
  if (existsSync(join(directPath, "state.sqlite"))) {
    return directPath;
  }
  const sessionPath = join(cwd, ".agent-runtime", "sessions", value);
  return existsSync(join(sessionPath, "state.sqlite")) ? sessionPath : directPath;
}

function formatTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
