import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { ArtifactStore } from "../src/stores/artifact-store.js";
import { ExecutionLog } from "../src/stores/execution-log.js";
import { AgentCliApp } from "../src/tui/app.js";

test("renders durable intent, correlated tool output and handles interrupt input", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-tui-"));
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const terminal = new FakeTerminal();
  let interrupts = 0;
  const app = new AgentCliApp({
    executionLog,
    goal: "inspect the target",
    runtimeDir,
    terminal,
    onInterrupt: async () => {
      interrupts += 1;
    },
    onForceInterrupt: () => undefined
  });
  await app.start();

  await executionLog.append({
    taskId: "task:recon",
    role: "executor",
    eventType: "assistant_intent",
    payload: {
      text: "先读取配置，再检查端点。",
      toolCalls: [{ id: "call:1", name: "read", arguments: { path: "config.json" } }]
    }
  });
  await executionLog.append({
    taskId: "task:recon",
    role: "executor",
    eventType: "tool_started",
    payload: { toolCallId: "call:1", toolName: "read", args: { path: "config.json" } }
  });
  await executionLog.append({
    taskId: "task:recon",
    role: "executor",
    eventType: "tool_finished",
    payload: {
      toolCallId: "call:1",
      toolName: "read",
      isError: false,
      result: {
        content: [{
          type: "text",
          text: [
            "\u001b[2Jtarget=https://example.test",
            "line 2",
            "line 3",
            "line 4",
            "line 5",
            "line 6",
            "INLINE_DETAIL_END"
          ].join("\n")
        }]
      }
    }
  });

  const rawRendered = app.render(100).join("\n");
  const rendered = stripAnsi(rawRendered);
  assert.doesNotMatch(rawRendered, /\u001b\[2J/);
  assert.match(rendered, /Agent 工作台/);
  assert.match(rendered, /新运行/);
  assert.match(rendered, new RegExp(runtimeDir));
  assert.match(rendered, /先读取配置，再检查端点/);
  assert.match(rendered, /调用 read 完成/);
  assert.equal((rendered.match(/Action/g) ?? []).length, 1);
  assert.match(rendered, /返回 preview/);
  assert.match(rendered, /target=https:\/\/example\.test/);
  assert.doesNotMatch(rendered, /INLINE_DETAIL_END/);
  assert.doesNotMatch(rendered, /执行中/);

  terminal.emitInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  const expanded = stripAnsi(app.render(100).join("\n"));
  assert.match(expanded, /返回详情/);
  assert.match(expanded, /INLINE_DETAIL_END/);
  assert.match(expanded, /Enter 收起详情/);

  terminal.emitInput("\u0003");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interrupts, 1);
  assert.match(stripAnsi(app.render(100).join("\n")), /正在停止活跃 Agent 会话/);

  await app.stop();
  executionLog.close();
});

test("loads artifact-backed tool details only when the action is expanded", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-tui-artifact-"));
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const artifact = await artifactStore.write({
    taskId: "task:artifact",
    kind: "stdout",
    mediaType: "text/plain",
    data: `PREVIEW_ONLY\n${"full line\n".repeat(20)}ARTIFACT_DETAIL_END`
  });
  const terminal = new FakeTerminal();
  const app = new AgentCliApp({
    executionLog,
    artifactStore,
    goal: "artifact expansion",
    terminal,
    onInterrupt: async () => undefined,
    onForceInterrupt: () => undefined
  });
  await app.start();
  await executionLog.append({
    taskId: "task:artifact",
    role: "executor",
    eventType: "assistant_intent",
    payload: {
      text: "读取完整工具输出。",
      toolCalls: [{ id: "call:artifact", name: "bash", arguments: { command: "long-output" } }]
    }
  });
  await executionLog.append({
    taskId: "task:artifact",
    role: "executor",
    eventType: "tool_started",
    payload: { toolCallId: "call:artifact", toolName: "bash", args: { command: "long-output" } }
  });
  await executionLog.append({
    taskId: "task:artifact",
    role: "executor",
    eventType: "tool_finished",
    artifactRefs: [artifact.artifactRef],
    payload: {
      toolCallId: "call:artifact",
      toolName: "bash",
      isError: false,
      result: {
        content: [{
          type: "text",
          text: {
            artifactRef: artifact.artifactRef,
            preview: "PREVIEW_ONLY",
            truncated: true
          }
        }]
      }
    }
  });

  const collapsed = stripAnsi(app.render(100).join("\n"));
  assert.match(collapsed, /PREVIEW_ONLY/);
  assert.doesNotMatch(collapsed, /ARTIFACT_DETAIL_END/);
  terminal.emitInput("\r");
  await waitFor(() => stripAnsi(app.render(100).join("\n")).includes("ARTIFACT_DETAIL_END"));
  const expanded = stripAnsi(app.render(100).join("\n"));
  assert.match(expanded, new RegExp(artifact.artifactRef));
  assert.match(expanded, /ARTIFACT_DETAIL_END/);

  await app.stop();
  artifactStore.close();
  executionLog.close();
});

test("completes terminal tool actions from runtime control events", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-tui-runtime-control-"));
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const terminal = new FakeTerminal();
  const app = new AgentCliApp({
    executionLog,
    goal: "submit result",
    terminal,
    onInterrupt: async () => undefined,
    onForceInterrupt: () => undefined
  });
  await app.start();
  await executionLog.append({
    taskId: "task:submit",
    role: "executor",
    eventType: "assistant_intent",
    payload: {
      text: "提交任务结果。",
      toolCalls: [{ id: "call:submit", name: "task_result_submit", arguments: { status: "completed" } }]
    }
  });
  await executionLog.append({
    taskId: "task:submit",
    role: "executor",
    eventType: "tool_started",
    payload: { toolCallId: "call:submit", toolName: "task_result_submit", args: { status: "completed" } }
  });
  await executionLog.append({
    taskId: "task:submit",
    role: "executor",
    eventType: "runtime_control",
    payload: {
      toolCallId: "call:submit",
      toolName: "task_result_submit",
      isError: false,
      result: { content: [{ type: "text", text: "result accepted" }] }
    }
  });

  const rendered = stripAnsi(app.render(100).join("\n"));
  assert.match(rendered, /调用 task_result_submit 完成/);
  assert.match(rendered, /result accepted/);
  assert.doesNotMatch(rendered, /等待工具返回/);

  await app.stop();
  executionLog.close();
});

test("distinguishes parallel executors and filters the timeline by task", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-tui-parallel-"));
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const terminal = new FakeTerminal();
  const app = new AgentCliApp({
    executionLog,
    goal: "parallel inspection",
    runtimeDir,
    resumed: true,
    terminal,
    onInterrupt: async () => undefined,
    onForceInterrupt: () => undefined
  });
  await app.start();

  await appendTaskStart(executionLog, "task:auth", "验证认证边界", "recon");
  await appendTaskStart(executionLog, "task:upload", "检查上传处理", "recon");
  await executionLog.append({
    taskId: "task:auth",
    role: "executor",
    eventType: "assistant_intent",
    payload: { text: "AUTH_ONLY_EVENT" }
  });
  await executionLog.append({
    taskId: "task:upload",
    role: "executor",
    eventType: "assistant_intent",
    payload: { text: "UPLOAD_ONLY_EVENT" }
  });
  await executionLog.append({
    taskId: "task:upload",
    role: "executor",
    eventType: "task_completed",
    summary: "upload complete",
    payload: {}
  });

  const rendered = stripAnsi(app.render(120).join("\n"));
  assert.match(rendered, /恢复运行/);
  assert.match(rendered, /T1 任务开始/);
  assert.match(rendered, /T2 任务开始/);
  assert.match(rendered, /executor · T1 验证认证边界/);
  assert.match(rendered, /executor · T2 检查上传处理/);
  assert.match(rendered, /Executor 运行 1 · 完成 1/);
  assert.match(rendered, /› \[executor · T2 检查上传处理\] Action/);

  terminal.emitInput("\u001b[A");
  const previousActionSelected = stripAnsi(app.render(120).join("\n"));
  assert.match(previousActionSelected, /› \[executor · T1 验证认证边界\] Action/);

  terminal.emitInput("\t");
  const filtered = stripAnsi(app.render(120).join("\n"));
  assert.match(filtered, /筛选 T1 验证认证边界/);
  assert.match(filtered, /AUTH_ONLY_EVENT/);
  assert.doesNotMatch(filtered, /UPLOAD_ONLY_EVENT/);

  await app.stop();
  executionLog.close();
});

test("recognizes enhanced Ctrl+C and force exits on a repeated interrupt", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-tui-interrupt-"));
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const terminal = new FakeTerminal();
  let interrupts = 0;
  let forceInterrupts = 0;
  const app = new AgentCliApp({
    executionLog,
    goal: "interrupt the run",
    terminal,
    onInterrupt: () => {
      interrupts += 1;
      return new Promise(() => undefined);
    },
    onForceInterrupt: () => {
      forceInterrupts += 1;
    }
  });
  await app.start();

  terminal.emitInput("\u001b[99;5u");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interrupts, 1);
  assert.match(stripAnsi(app.render(100).join("\n")), /再次 Ctrl\+C 强制退出/);

  terminal.emitInput("\u001b[99;5u");
  assert.equal(forceInterrupts, 1);
  assert.equal(terminal.stopCount, 1);

  await app.stop();
  executionLog.close();
});

class FakeTerminal implements Terminal {
  columns = 100;
  rows = 40;
  kittyProtocolActive = false;
  stopCount = 0;
  private input?: (data: string) => void;

  start(onInput: (data: string) => void): void {
    this.input = onInput;
  }

  stop(): void {
    this.stopCount += 1;
  }
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  emitInput(data: string): void {
    this.input?.(data);
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

async function appendTaskStart(
  executionLog: ExecutionLog,
  taskId: string,
  goal: string,
  parallelGroup: string
): Promise<void> {
  await executionLog.append({
    taskId,
    epochId: `epoch:${taskId}`,
    role: "runtime",
    eventType: "epoch_transition",
    summary: `${taskId} running`,
    payload: {
      state: "running",
      attempt: 1,
      taskEnvelope: {
        taskId,
        goal,
        targetRefs: [],
        scopeRef: "scope:root",
        constraints: [],
        successCriteria: [],
        parallelGroup
      }
    }
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
