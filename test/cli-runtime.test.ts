import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { parseCliOptions } from "../src/cli-options.js";
import { resolveCliRunContext } from "../src/cli-runtime.js";
import { ExecutionLog } from "../src/stores/execution-log.js";
import { SQLiteGraphStore } from "../src/stores/graph-store.js";

test("creates isolated runtime directories for separate default CLI runs", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "luanniao-cli-fresh-"));
  const options = parseCliOptions(["--goal", "fresh goal", "--scope", "fresh scope"]);
  const first = resolveCliRunContext(options, cwd, {
    now: new Date("2026-07-20T08:00:00.000Z"),
    uniqueId: "first"
  });
  const second = resolveCliRunContext(options, cwd, {
    now: new Date("2026-07-20T08:00:01.000Z"),
    uniqueId: "second"
  });
  assert.notEqual(first.runtimeDir, second.runtimeDir);
  assert.equal(first.resumed, false);
  assert.match(first.runtimeDir, /\.agent-runtime\/sessions/);

  const firstLog = new ExecutionLog(join(first.runtimeDir, "execution.jsonl"));
  await firstLog.append({
    role: "runtime",
    eventType: "run_started",
    summary: first.userGoal,
    payload: { userGoal: first.userGoal, scopeSummary: first.scopeSummary }
  });
  firstLog.close();

  const secondLog = new ExecutionLog(join(second.runtimeDir, "execution.jsonl"));
  assert.deepEqual(await secondLog.readAll(), []);
  secondLog.close();
});

test("resumes one named session and restores its stored Goal and Scope", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "luanniao-cli-resume-"));
  const runtimeDir = join(cwd, ".agent-runtime", "sessions", "session-a");
  await seedRuntime(runtimeDir, "stored goal", "stored scope", "open");

  const context = resolveCliRunContext(parseCliOptions(["--resume", "session-a"]), cwd);
  assert.equal(context.runtimeDir, runtimeDir);
  assert.equal(context.userGoal, "stored goal");
  assert.equal(context.scopeSummary, "stored scope");
  assert.equal(context.resumed, true);

  const events = new ExecutionLog(join(context.runtimeDir, "execution.jsonl"));
  assert.equal((await events.readAll()).some((event) => event.eventType === "run_started"), true);
  events.close();
});

test("resume rejects Goal or Scope input and missing sessions", () => {
  assert.throws(
    () => parseCliOptions(["--resume", "session-a", "--goal", "new goal"]),
    /--goal cannot be used with --resume/
  );
  assert.throws(
    () => parseCliOptions(["--resume", "session-a", "--scope", "new scope"]),
    /--scope cannot be used with --resume/
  );
  assert.throws(
    () => parseCliOptions(["--resume"]),
    /Missing value for --resume/
  );
  assert.throws(
    () => resolveCliRunContext(parseCliOptions(["--resume", "missing"]), process.cwd()),
    /state\.sqlite does not exist/
  );
});

test("custom new runtime refuses to overwrite an existing session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "luanniao-cli-runtime-dir-"));
  const runtimeDir = join(cwd, "existing");
  await seedRuntime(runtimeDir, "goal", "scope", "open");
  const options = parseCliOptions(["--runtime-dir", runtimeDir, "--goal", "new goal"]);
  assert.throws(() => resolveCliRunContext(options, cwd), /Use --resume to continue it/);
});

async function seedRuntime(
  runtimeDir: string,
  userGoal: string,
  scopeSummary: string,
  status: "open" | "completed"
): Promise<void> {
  const databasePath = join(runtimeDir, "state.sqlite");
  const graphStore = new SQLiteGraphStore(databasePath, join(runtimeDir, "graph-deltas.jsonl"));
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"), databasePath);
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [
      {
        id: "goal:root",
        graphKind: "task",
        type: "Goal",
        label: userGoal,
        properties: { status }
      },
      {
        id: "scope:root",
        graphKind: "task",
        type: "Scope",
        label: "Authorized scope",
        properties: { summary: scopeSummary }
      }
    ],
    edges: [{ from: "goal:root", to: "scope:root", type: "within_scope" }]
  });
  await executionLog.append({
    role: "runtime",
    eventType: "run_started",
    summary: userGoal,
    payload: { userGoal, scopeSummary, sessionName: basename(runtimeDir) }
  });
  executionLog.close();
  graphStore.close();
}
