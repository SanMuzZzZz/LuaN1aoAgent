import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TraceItem } from "../types";
import { TraceCard, TraceView } from "./TraceView";

const actionItem: TraceItem = {
  id: "trace:action:1",
  eventId: "event:1",
  timestamp: "2026-07-10T17:27:20.883Z",
  taskId: "task:test",
  role: "executor",
  eventType: "agent_action",
  eventLabel: "Agent 动作",
  stage: "思考与行动",
  title: "Executor 执行动作",
  summary: "准备验证当前入口并收集直接证据。",
  intentSource: "recorded",
  detail: "Agent 动作 → 工具调用开始 → 工具调用完成",
  action: "bash · curl http://target.test",
  observation: "工具返回内容",
  evidenceRefs: [],
  artifactRefs: [],
  graphNodeRefs: ["task:test"],
  tool: {
    toolCallId: "call:1",
    toolName: "bash",
    command: "curl http://target.test",
    status: "completed",
    isError: false,
    startedAt: "2026-07-10T17:27:20.881Z",
    endedAt: "2026-07-10T17:27:20.883Z",
    durationMs: 2,
    updateCount: 0,
    eventCount: 3,
    result: "工具返回内容",
    resultPreview: "工具返回内容",
    lifecycle: [
      { eventType: "tool_started", timestamp: "2026-07-10T17:27:20.881Z" },
      { eventType: "tool_finished", timestamp: "2026-07-10T17:27:20.883Z" }
    ]
  },
  rawEvent: { id: "action:1" }
};

describe("TraceView", () => {
  it("does not expose Runtime as a LIVE TRACE role", () => {
    render(
      <TraceView
        items={[]}
        roleFilter="all"
        newestFirst
        onRoleFilterChange={vi.fn()}
        onOrderChange={vi.fn()}
        onSelectTrace={vi.fn()}
      />
    );

    expect(screen.getByText("Planner")).toBeInTheDocument();
    expect(screen.getByText("Executor")).toBeInTheDocument();
    expect(screen.getByText("Observer")).toBeInTheDocument();
    expect(screen.queryByText("Runtime")).not.toBeInTheDocument();
  });

  it("previews thought and action while keeping tool output collapsed", () => {
    render(<TraceCard item={actionItem} selected={false} onSelect={vi.fn()} />);

    expect(screen.getByText("Agent 想法")).toBeInTheDocument();
    expect(screen.getByText("准备验证当前入口并收集直接证据。")).toBeInTheDocument();
    expect(screen.getByText("执行动作")).toBeInTheDocument();
    expect(screen.getByText("bash · curl http://target.test")).toBeInTheDocument();
    expect(screen.queryByText("工具返回内容")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("展开执行细节"));

    expect(screen.getAllByText("工具返回内容").length).toBeGreaterThan(0);
    expect(screen.getByText("tool started")).toBeInTheDocument();
    expect(screen.getByText("tool finished")).toBeInTheDocument();
  });

  it("labels derived historical intent as an action purpose and keeps task refs out of Evidence", () => {
    const { container } = render(<TraceCard item={{
      ...actionItem,
      intentSource: "derived",
      summary: "读取 ctf-web 技能指南，加载当前任务所需的验证方法。",
      evidenceRefs: []
    }} selected={false} onSelect={vi.fn()} />);
    const card = within(container);

    expect(card.getByText("行动目的")).toBeInTheDocument();
    expect(card.queryByText("Agent 想法")).not.toBeInTheDocument();
    expect(card.queryByText(/^Evidence /)).not.toBeInTheDocument();
  });
});
