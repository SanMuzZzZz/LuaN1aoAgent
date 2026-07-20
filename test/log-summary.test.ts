import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSupervisorTrace } from "../src/log-summary.js";
import type { ExecutionEvent } from "../src/types.js";

test("summarizes supervisor trace as action state and loop signals", () => {
  const events: ExecutionEvent[] = [
    makeEvent("event:1", "assistant_intent", {
      text: "基线为有效会话，只改变目标参数，以权限变化为判定信号。",
      toolCalls: [{
        type: "toolCall",
        name: "bash",
        arguments: { command: "ls .agent-runtime" }
      }]
    }),
    makeEvent("event:2", "tool_execution_end", {
      toolName: "bash",
      result: {
        content: [
          {
            type: "text",
            text: "artifactRef=artifact:large-output preview=..."
          }
        ]
      }
    }),
    makeEvent("event:3", "message_end", {
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "bash",
            arguments: { command: "ls .agent-runtime" }
          }
        ]
      }
    })
  ];

  const summary = summarizeSupervisorTrace(events);

  assert.match(summary.actionTraceText, /Executor 决定调用工具：bash/);
  assert.match(summary.actionTraceText, /基线为有效会话/);
  assert.match(summary.actionTraceText, /工具 bash 完成/);
  assert.match(summary.loopSignalsText, /重复动作：bash:ls \.agent-runtime ×2/);
  assert.match(summary.loopSignalsText, /本地工作区漂移：是/);
  assert.match(summary.loopSignalsText, /大输出\/Artifact 指针结果：1 条/);
});

test("supervisor trace preserves the Executor interpretation of a breakthrough hidden in long output", () => {
  const events: ExecutionEvent[] = [
    makeEvent("event:1", "assistant_intent", { text: "比较路径规范化差异" }, 1),
    makeEvent("event:2", "tool_started", {
      toolCallId: "call:keys",
      toolName: "bash",
      args: { command: "probe traversal variants" }
    }, 2),
    makeEvent("event:3", "tool_finished", {
      toolCallId: "call:keys",
      toolName: "bash",
      result: {
        content: [{
          type: "text",
          text: `${"HTTP 403 ".repeat(100)}/keys/../public/static/README.md 200 ${"HTTP 403 ".repeat(100)}`
        }]
      }
    }, 3),
    makeEvent("event:4", "assistant_intent", {
      text: "确认 /keys 可穿越，下一步复用该能力读取密钥候选。"
    }, 4)
  ];

  const summary = summarizeSupervisorTrace(events);

  assert.match(summary.actionTraceText, /后续理解=确认 \/keys 可穿越/);
});

function makeEvent(
  id: string,
  eventType: string,
  payload: Record<string, unknown>,
  seq?: number
): ExecutionEvent {
  return {
    id,
    taskId: "task:test",
    role: "executor",
    eventType,
    timestamp: new Date(0).toISOString(),
    payload,
    seq
  };
}
