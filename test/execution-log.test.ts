import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionLog } from "../src/stores/execution-log.js";

test("notifies live subscribers after durable append and supports unsubscribe", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-execution-subscribe-"));
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const received: string[] = [];
  const unsubscribe = executionLog.subscribe((event) => {
    received.push(event.eventType);
  });

  await executionLog.append({
    role: "runtime",
    eventType: "run_started",
    payload: {}
  });
  unsubscribe();
  await executionLog.append({
    role: "runtime",
    eventType: "run_completed",
    payload: {}
  });

  assert.deepEqual(received, ["run_started"]);
  assert.deepEqual((await executionLog.readAll()).map((event) => event.eventType), ["run_started", "run_completed"]);
  executionLog.close();
});

test("aggregates Pi usage, invocation, projector, supervisor and tool metrics", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-execution-log-"));
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const runStarted = await executionLog.append({
    role: "runtime",
    eventType: "run_started",
    summary: "metrics test",
    payload: {}
  });
  await executionLog.append({
    taskId: "task:test",
    role: "executor",
    eventType: "tool_started",
    summary: "bash",
    payload: { toolName: "bash" }
  });
  await executionLog.append({
    taskId: "task:test",
    role: "executor",
    eventType: "tool_finished",
    summary: "bash failed",
    payload: { toolName: "bash", isError: true }
  });
  await executionLog.append({
    taskId: "task:test",
    role: "executor",
    eventType: "provider_error",
    summary: "rate limited",
    payload: { errorKind: "provider_rate_limit" }
  });
  await executionLog.append({
    taskId: "task:test",
    role: "executor",
    eventType: "turn_usage",
    summary: "turn usage",
    payload: {
      provider: "test-provider",
      model: "test-model",
      usage: {
        input: 100,
        output: 20,
        cacheRead: 40,
        cacheWrite: 0,
        totalTokens: 160,
        cost: { total: 0.001 }
      }
    }
  });
  await executionLog.append({
    taskId: "task:test",
    role: "runtime",
    eventType: "invocation_metrics",
    summary: "executor metrics",
    payload: {
      invocationKind: "executor",
      status: "completed",
      durationMs: 120,
      inputBytes: 2048,
      stats: {
        usage: {
          input: 100,
          output: 20,
          cacheRead: 40,
          cacheWrite: 0,
          totalTokens: 160,
          cost: { total: 0.001 }
        }
      }
    }
  });
  await executionLog.append({
    taskId: "task:test",
    role: "runtime",
    eventType: "invocation_metrics",
    summary: "projector metrics",
    payload: {
      invocationKind: "projector",
      status: "completed",
      durationMs: 450,
      inputBytes: 8000,
      stats: {
        usage: {
          input: 30,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 40,
          cost: { total: 0.0002 }
        }
      }
    }
  });
  await executionLog.append({
    taskId: "task:test",
    role: "runtime",
    eventType: "projection_input_built",
    summary: "projection input",
    payload: { observationCount: 4, inputBytes: 8000 }
  });
  await executionLog.append({
    taskId: "task:test",
    role: "observer",
    eventType: "projection_job_succeeded",
    summary: "projection complete",
    payload: {
      nodeCounts: { "reasoning:Evidence": 2, "operation:WebEndpoint": 1 },
      edgeCount: 4,
      durationMs: 450
    }
  });
  await executionLog.append({
    taskId: "task:test",
    role: "runtime",
    eventType: "supervisor_check_started",
    summary: "supervisor started",
    payload: {}
  });
  await executionLog.append({
    taskId: "task:test",
    role: "observer",
    eventType: "supervisor_check_succeeded",
    summary: "checkpoint",
    payload: { controlSignal: { decision: "checkpoint" } }
  });
  await executionLog.append({
    taskId: "task:test",
    role: "runtime",
    eventType: "task_completed",
    summary: "done",
    payload: {}
  });

  const metrics = executionLog.metrics(runStarted.seq) as {
    toolCalls: number;
    toolErrors: number;
    toolCallsByName: Record<string, number>;
    toolErrorsByName: Record<string, number>;
    providerErrors: number;
    providerErrorsByKind: Record<string, number>;
    taskOutcomes: Record<string, number>;
    turnUsage: {
      input: number;
      output: number;
      cacheRead: number;
      totalTokens: number;
      cost: number;
      byModel: Record<string, { totalTokens: number }>;
    };
    invocations: {
      count: number;
      input: number;
      output: number;
      totalTokens: number;
      cost: number;
      durationMs: { total: number; max: number; average: number };
      byKind: Record<string, { count: number; usage: { totalTokens: number } }>;
    };
    projector: {
      inputsBuilt: number;
      succeeded: number;
      observations: number;
      graphNodes: number;
      graphEdges: number;
      inputBytes: { total: number };
      durationMs: { total: number };
    };
    supervisor: { started: number; succeeded: number; decisions: Record<string, number> };
  };

  assert.equal(metrics.toolCalls, 1);
  assert.equal(metrics.toolErrors, 1);
  assert.equal(metrics.toolCallsByName.bash, 1);
  assert.equal(metrics.toolErrorsByName.bash, 1);
  assert.equal(metrics.providerErrors, 1);
  assert.equal(metrics.providerErrorsByKind.provider_rate_limit, 1);
  assert.equal(metrics.taskOutcomes.completed, 1);
  assert.deepEqual(
    {
      input: metrics.turnUsage.input,
      output: metrics.turnUsage.output,
      cacheRead: metrics.turnUsage.cacheRead,
      totalTokens: metrics.turnUsage.totalTokens,
      cost: metrics.turnUsage.cost
    },
    { input: 100, output: 20, cacheRead: 40, totalTokens: 160, cost: 0.001 }
  );
  assert.equal(metrics.turnUsage.byModel["test-provider/test-model"].totalTokens, 160);
  assert.equal(metrics.invocations.count, 2);
  assert.equal(metrics.invocations.totalTokens, 200);
  assert.ok(Math.abs(metrics.invocations.cost - 0.0012) < 1e-12);
  assert.equal(metrics.invocations.durationMs.total, 570);
  assert.equal(metrics.invocations.durationMs.max, 450);
  assert.equal(metrics.invocations.durationMs.average, 285);
  assert.equal(metrics.invocations.byKind.executor.usage.totalTokens, 160);
  assert.equal(metrics.invocations.byKind.projector.usage.totalTokens, 40);
  assert.equal(metrics.projector.inputsBuilt, 1);
  assert.equal(metrics.projector.succeeded, 1);
  assert.equal(metrics.projector.observations, 4);
  assert.equal(metrics.projector.graphNodes, 3);
  assert.equal(metrics.projector.graphEdges, 4);
  assert.equal(metrics.projector.inputBytes.total, 8000);
  assert.equal(metrics.projector.durationMs.total, 450);
  assert.equal(metrics.supervisor.started, 1);
  assert.equal(metrics.supervisor.succeeded, 1);
  assert.equal(metrics.supervisor.decisions.checkpoint, 1);
  executionLog.close();
});
