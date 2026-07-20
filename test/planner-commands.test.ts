import assert from "node:assert/strict";
import test from "node:test";
import { normalizePlannerDecision } from "../src/planner-commands.js";

test("allows empty apply_commands as a no-op graph update", () => {
  const decision = normalizePlannerDecision({
    decision: "apply_commands",
    commands: [],
    reason: "No graph mutation is needed; schedule existing ready tasks.",
    basedOnRefs: ["task:ready"]
  });

  assert.equal(decision.decision, "apply_commands");
  assert.deepEqual(decision.commands, []);
  assert.equal(decision.reason, "No graph mutation is needed; schedule existing ready tasks.");
});

test("defaults omitted apply_commands commands to an empty no-op list", () => {
  const decision = normalizePlannerDecision({
    decision: "apply_commands",
    reason: "No graph mutation is needed.",
    basedOnRefs: []
  });

  assert.deepEqual(decision.commands, []);
});

test("accepts archived as the logical deletion status for old tasks", () => {
  const decision = normalizePlannerDecision({
    decision: "apply_commands",
    commands: [{
      kind: "set_task_status",
      taskId: "task:obsolete",
      status: "archived",
      reason: "Superseded by a confirmed path"
    }],
    reason: "Remove the obsolete task from active scheduling",
    basedOnRefs: ["task:replacement"]
  });

  assert.equal(decision.commands?.[0]?.kind, "set_task_status");
  assert.equal(
    decision.commands?.[0]?.kind === "set_task_status" ? decision.commands[0].status : undefined,
    "archived"
  );
});
