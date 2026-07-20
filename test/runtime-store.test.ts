import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeStore } from "../src/stores/runtime-store.js";

test("tracks multiple epochs for one task without shared lifecycle state", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const store = new RuntimeStore(join(runtimeDir, "state.sqlite"));
  store.createEpoch({ epochId: "epoch:1", taskId: "task:test", attempt: 1 });
  store.transitionEpoch({ epochId: "epoch:1", state: "running" });
  store.transitionEpoch({ epochId: "epoch:1", state: "closed", terminationReason: "budget_exhausted" });
  store.createEpoch({ epochId: "epoch:2", taskId: "task:test", attempt: 2 });

  assert.equal(store.countTaskEpochs("task:test"), 2);
  assert.equal(store.getEpoch("epoch:1")?.terminationReason, "budget_exhausted");
  assert.equal(store.getEpoch("epoch:2")?.state, "created");
  assert.deepEqual(store.stats(), {
    epochCount: 2,
    activeEpochCount: 1,
    byState: { closed: 1, created: 1 },
    byTerminationReason: { budget_exhausted: 1, none: 1 }
  });
});

test("projection desired sequence does not advance committed sequence", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const store = new RuntimeStore(join(runtimeDir, "state.sqlite"));
  store.raiseProjectionDesired("task:test", 3);
  store.raiseProjectionDesired("task:test", 9);
  const claim = store.claimProjection("task:test");

  assert.deepEqual(claim, { taskId: "task:test", fromSeq: 0, toSeq: 9, generation: 1 });
  assert.equal(store.getProjectionState("task:test").committedSeq, 0);
});

test("releases interrupted projection claims without advancing committed sequence", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const firstStore = new RuntimeStore(databasePath);
  firstStore.raiseProjectionDesired("task:test", 9);
  assert.ok(firstStore.claimProjection("task:test"));
  firstStore.close();

  const recoveredStore = new RuntimeStore(databasePath);
  const state = recoveredStore.getProjectionState("task:test");

  assert.equal(recoveredStore.recoveredProjectionClaims, 1);
  assert.equal(state.activeGeneration, undefined);
  assert.equal(state.committedSeq, 0);
  assert.equal(state.desiredSeq, 9);
  assert.deepEqual(recoveredStore.listPendingProjectionTasks().map((item) => item.taskId), ["task:test"]);
  recoveredStore.close();
});
