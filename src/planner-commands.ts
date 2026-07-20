import type {
  PlannerCommand,
  PlannerDecision,
  PlannerTaskPatch,
  PlannerTaskSpec,
  TaskGraphStatus
} from "./types.js";

export class PlannerProtocolError extends Error {}

export function normalizePlannerDecision(value: unknown): PlannerDecision {
  if (!isRecord(value)) {
    throw new PlannerProtocolError("Planner output must be a JSON object");
  }
  const decision = value.decision;
  const reason = nonEmptyString(value.reason) ?? "Planner did not provide a reason";
  const basedOnRefs = stringArray(value.basedOnRefs);
  if (decision === "need_user_input") {
    return { decision, commands: [], reason, basedOnRefs };
  }
  if (decision !== "apply_commands") {
    throw new PlannerProtocolError(`Unsupported planner decision: ${String(decision)}`);
  }
  if (value.commands !== undefined && !Array.isArray(value.commands)) {
    throw new PlannerProtocolError("apply_commands commands must be an array");
  }
  return {
    decision,
    commands: (value.commands ?? []).map(normalizePlannerCommand),
    reason,
    basedOnRefs
  };
}

function normalizePlannerCommand(value: unknown): PlannerCommand {
  if (!isRecord(value)) {
    throw new PlannerProtocolError("Planner command must be an object");
  }
  const basis = {
    basedOnRefs: stringArray(value.basedOnRefs),
    reason: nonEmptyString(value.reason)
  };
  switch (value.kind) {
    case "create_tasks": {
      if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
        throw new PlannerProtocolError("create_tasks requires at least one task");
      }
      return {
        kind: "create_tasks",
        tasks: value.tasks.map(normalizePlannerTaskSpec),
        ...basis
      };
    }
    case "patch_task":
      return {
        kind: "patch_task",
        taskId: requireTaskId(value.taskId),
        patch: normalizePlannerTaskPatch(value.patch),
        ...basis
      };
    case "replace_dependencies":
      return {
        kind: "replace_dependencies",
        taskId: requireTaskId(value.taskId),
        dependencyTaskIds: stringArray(value.dependencyTaskIds).map(requireTaskId),
        ...basis
      };
    case "set_task_status":
      return {
        kind: "set_task_status",
        taskId: requireTaskId(value.taskId),
        status: requireTaskStatus(value.status),
        ...basis
      };
    case "set_node_status":
      return {
        kind: "set_node_status",
        nodeId: requireNodeId(value.nodeId),
        status: nonEmptyString(value.status) ?? fail("set_node_status requires status"),
        ...basis
      };
    default:
      throw new PlannerProtocolError(`Unsupported planner command: ${String(value.kind)}`);
  }
}

function normalizePlannerTaskSpec(value: unknown): PlannerTaskSpec {
  if (!isRecord(value)) {
    throw new PlannerProtocolError("Task specification must be an object");
  }
  return {
    id: requireTaskId(value.id),
    goal: nonEmptyString(value.goal) ?? fail("Task goal is required"),
    targetRefs: nonEmptyStringArray(value.targetRefs, ["goal:root"]),
    scopeRef: nonEmptyString(value.scopeRef) ?? "scope:root",
    constraints: stringArray(value.constraints),
    successCriteria: nonEmptyStringArray(value.successCriteria, ["产出可由 Observer 投影的 evidence candidate"]),
    budget: isRecord(value.budget) ? value.budget : undefined,
    priority: typeof value.priority === "number" && Number.isFinite(value.priority) ? value.priority : 1,
    parentTaskId: nonEmptyString(value.parentTaskId),
    dependsOnTaskRefs: stringArray(value.dependsOnTaskRefs).map(requireTaskId),
    parallelGroup: nonEmptyString(value.parallelGroup)
  };
}

function normalizePlannerTaskPatch(value: unknown): PlannerTaskPatch {
  if (!isRecord(value)) {
    throw new PlannerProtocolError("patch_task requires a patch object");
  }
  const patch: PlannerTaskPatch = {};
  const goal = nonEmptyString(value.goal);
  if (goal) patch.goal = goal;
  if (Array.isArray(value.constraints)) patch.constraints = stringArray(value.constraints);
  if (Array.isArray(value.successCriteria)) patch.successCriteria = stringArray(value.successCriteria);
  if (isRecord(value.budget)) patch.budget = value.budget;
  if (typeof value.priority === "number" && Number.isFinite(value.priority)) patch.priority = value.priority;
  if (typeof value.parallelGroup === "string") patch.parallelGroup = value.parallelGroup;
  if (Object.keys(patch).length === 0) {
    throw new PlannerProtocolError("patch_task patch contains no supported fields");
  }
  return patch;
}

function requireTaskId(value: unknown): string {
  const taskId = nonEmptyString(value);
  if (!taskId?.startsWith("task:")) {
    throw new PlannerProtocolError(`Invalid task id: ${String(value)}`);
  }
  return taskId;
}

function requireNodeId(value: unknown): string {
  return nonEmptyString(value) ?? fail("Node id is required");
}

function requireTaskStatus(value: unknown): TaskGraphStatus {
  if (["open", "partial", "completed", "blocked", "failed", "archived"].includes(String(value))) {
    return value as TaskGraphStatus;
  }
  throw new PlannerProtocolError(`Invalid task status: ${String(value)}`);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function nonEmptyStringArray(value: unknown, fallback: string[]): string[] {
  const values = stringArray(value);
  return values.length > 0 ? values : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new PlannerProtocolError(message);
}
