import assert from "node:assert/strict";
import test from "node:test";
import { createFallbackObserverDelta } from "../src/controller.js";
import type { TaskEnvelope, TaskResult } from "../src/types.js";

test("observer fallback does not write task or reasoning graph nodes", () => {
  const taskEnvelope: TaskEnvelope = {
    taskId: "task:fallback",
    goal: "Fallback task",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: []
  };
  const taskResult: TaskResult = {
    taskId: "task:fallback",
    status: "completed",
    summary: "Task completed with artifact evidence refs",
    evidenceRefs: ["artifact:raw-output"],
    artifactRefs: ["artifact:raw-output"]
  };

  const delta = createFallbackObserverDelta(taskEnvelope, taskResult, ["event:observer-failed"], "test");

  assert.deepEqual(delta.nodes, []);
  assert.deepEqual(delta.edges, []);
});
