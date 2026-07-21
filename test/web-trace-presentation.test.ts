import assert from "node:assert/strict";
import test from "node:test";
import { selectExactToolCallId, selectTraceIntent, summarizePlannerCommands, summarizeTraceAction, traceActionHeading, traceNextStep } from "../src/web-trace-presentation.js";

test("uses the intent-declared tool call id instead of a nearby same-name call", () => {
  const calls = [{ id: "call:target", name: "read", arguments: { path: "target" } }];
  const availableIds = new Set(["call:wrong", "call:target"]);
  assert.equal(selectExactToolCallId(calls, availableIds), "call:target");
});

test("prefers recorded public intent over structured and derived fallbacks", () => {
  assert.deepEqual(selectTraceIntent({
    role: "executor",
    recordedText: "读取技能指南，确认当前任务适用的验证方法。",
    call: { id: "call:1", name: "read", arguments: { path: "/skills/ctf-web/SKILL.md" } }
  }), {
    text: "读取技能指南，确认当前任务适用的验证方法。",
    source: "recorded"
  });
});

test("uses structured planner and supervisor reasons", () => {
  assert.deepEqual(selectTraceIntent({
    role: "planner",
    call: {
      name: "planner_submit",
      arguments: {
        decision: "apply_commands",
        commands: [{ kind: "set_task_status", reason: "已有证据满足初始侦查成功条件。" }],
        reason: "更新任务状态。"
      }
    }
  }), {
    text: "已有证据满足初始侦查成功条件。",
    source: "structured"
  });

  assert.equal(selectTraceIntent({
    role: "observer",
    call: { name: "control_submit", arguments: { decision: "continue", reason: "仍在持续取得有效进展。" } }
  }).text, "仍在持续取得有效进展。");
});

test("derives a specific purpose for historical executor tool-only events", () => {
  assert.deepEqual(selectTraceIntent({
    role: "executor",
    call: { name: "read", arguments: { path: "/Users/test/.agents/skills/ctf-web/SKILL.md", limit: 80 } }
  }), {
    text: "读取 ctf-web 技能指南，加载当前任务所需的验证方法。",
    source: "derived"
  });
  assert.equal(summarizeTraceAction({
    name: "read",
    arguments: { path: "/Users/test/.agents/skills/ctf-web/SKILL.md", limit: 80 }
  }), "读取资料 · ctf-web/SKILL.md");
});

test("summarizes structured actions without exposing full payloads", () => {
  assert.equal(summarizeTraceAction({
    name: "task_result_submit",
    arguments: { taskId: "task:recon", status: "partial", summary: "x".repeat(500) }
  }), "提交任务结果 · partial");
  assert.equal(summarizeTraceAction({
    name: "graph_delta_submit",
    arguments: { nodes: [{}, {}], edges: [{}] }
  }), "提交图增量 · 2 节点 / 1 关系");
  assert.deepEqual(traceActionHeading("observer", { name: "control_submit", arguments: {} }), {
    title: "Observer 提交监督判断",
    eventLabel: "监督判断"
  });
  assert.equal(traceNextStep("planner", { name: "planner_submit", arguments: {} }, true), "规划决策已提交，等待 Controller 应用任务图变更。");
  assert.equal(summarizeTraceAction({
    name: "bash",
    arguments: { command: "curl -sS http://localhost:32770/" }
  }), "HTTP 验证 · GET · http://localhost:32770/");
});

test("summarizes planner commands with readable task details", () => {
  assert.deepEqual(summarizePlannerCommands([
    {
      kind: "create_tasks",
      tasks: [{
        id: "task:auth-explore",
        goal: "利用已验证的测试凭证登录后台，探索可用功能并寻找读取 /challenge/flag.txt 的路径。",
        dependsOnTaskRefs: ["task:entry-recon"]
      }]
    },
    { kind: "set_task_status", taskId: "task:entry-recon", status: "completed" },
    { kind: "replace_dependencies", taskId: "task:flag-read", dependencyTaskIds: ["task:auth-explore"] },
    { kind: "patch_task", taskId: "task:auth-explore", patch: { goal: "x", priority: 2 } }
  ]), [
    "创建任务 task:auth-explore：利用已验证的测试凭证登录后台，探索可用功能并寻找读取 /challenge/flag.txt 的路径。（依赖：task:entry-recon）",
    "标记任务 task:entry-recon 为 completed",
    "调整依赖 task:flag-read → task:auth-explore",
    "更新任务 task:auth-explore：修改 goal、priority"
  ]);
});

test("planner action summary carries the first command detail", () => {
  const action = summarizeTraceAction({
    name: "planner_submit",
    arguments: {
      decision: "apply_commands",
      commands: [{
        kind: "create_tasks",
        tasks: [{ id: "task:auth-explore", goal: "登录后台并探索功能", dependsOnTaskRefs: [] }]
      }]
    }
  });
  assert.equal(action, "提交规划决策 · apply_commands · 创建任务 task:auth-explore：登录后台并探索功能（依赖：无）");
});
