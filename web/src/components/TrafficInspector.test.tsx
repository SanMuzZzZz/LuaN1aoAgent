import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTrafficBody, replayTrafficExchange } from "../api";
import type { AuthUser, TrafficExchange } from "../types";
import { TrafficInspector } from "./TrafficInspector";

vi.mock("../api", () => ({
  fetchTrafficBody: vi.fn(),
  replayTrafficExchange: vi.fn()
}));

const exchange: TrafficExchange = {
  id: 41,
  started_at: "2026-07-10T17:27:20.000Z",
  completed_at: "2026-07-10T17:27:20.125Z",
  duration_ms: 125,
  method: "POST",
  url: "https://target.test/api/items?source=replay",
  host: "target.test",
  scheme: "https",
  protocol: "HTTP/2",
  mode: "mitm",
  status: 201,
  request_observed_bytes: 16,
  response_observed_bytes: 2,
  request_captured_bytes: 16,
  response_captured_bytes: 2,
  request_body_ref: "body:req",
  response_body_ref: "body:res",
  request_capture_state: "captured",
  response_capture_state: "captured",
  request_truncated: false,
  response_truncated: true,
  headers_truncated: false,
  quota_pressure: false,
  response_truncation_reason: "quota",
  task_ref: "task:test",
  run_ref: "run:test",
  route_ref: "route:test",
  session_ref: "session:test",
  evicted_exchanges: 0,
  request_headers: [
    { name: "Cookie", value: "session=secret", ordinal: 0 },
    { name: "X-Test", value: "first", ordinal: 1 },
    { name: "X-Test", value: "second", ordinal: 2 }
  ],
  response_headers: [{ name: "Content-Type", value: "application/octet-stream", ordinal: 0 }]
};

const admin: AuthUser = {
  id: "user:admin",
  username: "admin",
  displayName: "Admin",
  role: "admin",
  createdAt: "2026-07-01T00:00:00.000Z"
};
const analyst: AuthUser = { ...admin, id: "user:analyst", username: "analyst", role: "analyst" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchTrafficBody).mockImplementation(async (_runtimeDir, _id, side) => ({
    exchange_id: 41,
    side,
    body_ref: side === "request" ? "body:req" : "body:res",
    encoding: "base64",
    data: side === "request" ? "eyJ0ZXN0Ijp0cnVlfQ==" : "/wA=",
    bytes: side === "request" ? 13 : 2,
    truncated: side === "response"
  }));
  vi.mocked(replayTrafficExchange).mockResolvedValue({ exchangeId: 42, replayOf: 41, status: 201 });
});

describe("TrafficInspector", () => {
  it("loads binary bodies on demand and renders them as inert text", async () => {
    const { container } = render(
      <TrafficInspector runtimeDir="runtime/a" exchange={exchange} user={analyst} onSelectExchange={vi.fn()} onReplayed={vi.fn()} />
    );

    const responseSection = screen.getByText("Response body").closest(".traffic-section");
    expect(responseSection).not.toBeNull();
    fireEvent.click(within(responseSection as HTMLElement).getByRole("button", { name: /加载 body/ }));

    await waitFor(() => expect(within(responseSection as HTMLElement).getByText("/wA=")).toBeInTheDocument());
    expect(within(responseSection as HTMLElement).getByText(/Body 仅显示已捕获部分/)).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();

    fireEvent.mouseDown(within(responseSection as HTMLElement).getByLabelText("Response body 展示格式"));
    fireEvent.click(await screen.findByText("Hex"));
    await waitFor(() => expect(within(responseSection as HTMLElement).getByText("ff 00")).toBeInTheDocument());
  });

  it("ignores an old body response after the selected exchange changes", async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof fetchTrafficBody>>) => void;
    let resolveCurrent!: (value: Awaited<ReturnType<typeof fetchTrafficBody>>) => void;
    vi.mocked(fetchTrafficBody)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveCurrent = resolve; }));
    const currentExchange = { ...exchange, id: 42, url: "https://target.test/current" };
    const { rerender } = render(<TrafficInspector runtimeDir="runtime/a" exchange={exchange} user={analyst} onSelectExchange={vi.fn()} onReplayed={vi.fn()} />);

    fireEvent.click(within(screen.getByText("Request body").closest(".traffic-section") as HTMLElement).getByRole("button", { name: /加载 body/ }));
    rerender(<TrafficInspector runtimeDir="runtime/a" exchange={currentExchange} user={analyst} onSelectExchange={vi.fn()} onReplayed={vi.fn()} />);
    fireEvent.click(within(screen.getByText("Request body").closest(".traffic-section") as HTMLElement).getByRole("button", { name: /加载 body/ }));
    resolveCurrent({ exchange_id: 42, side: "request", body_ref: "body:current", encoding: "base64", data: "Y3VycmVudA==", bytes: 7, truncated: false });
    await screen.findByText("current");
    resolveOld({ exchange_id: 41, side: "request", body_ref: "body:old", encoding: "base64", data: "b2xk", bytes: 3, truncated: false });

    await waitFor(() => expect(screen.getByText("current")).toBeInTheDocument());
    expect(screen.queryByText("old")).not.toBeInTheDocument();
  });

  it("keeps replay unavailable to analysts", () => {
    render(<TrafficInspector runtimeDir="runtime/a" exchange={exchange} user={analyst} onSelectExchange={vi.fn()} onReplayed={vi.fn()} />);

    expect(screen.getByText(/仅管理员可发送 Replay/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑并 Replay" })).not.toBeInTheDocument();
  });

  it("keeps the complete source body when the editor is unchanged", async () => {
    render(<TrafficInspector runtimeDir="runtime/a" exchange={exchange} user={admin} onSelectExchange={vi.fn()} onReplayed={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "编辑并 Replay" }));
    await waitFor(() => expect(screen.getByLabelText("Replay body")).toHaveValue('{"test":true}'));
    expect(screen.getByText(/Body 未修改，将由 sidecar 使用完整源 body/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "准备发送" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("使用完整源 body（无 override）")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认发送" }));

    await waitFor(() => expect(replayTrafficExchange).toHaveBeenCalled());
    const [, input] = vi.mocked(replayTrafficExchange).mock.calls[0];
    expect(input).not.toHaveProperty("body");
  });

  it("confirms the target and submits an admin replay", async () => {
    const onReplayed = vi.fn();
    render(<TrafficInspector runtimeDir="runtime/a" exchange={{ ...exchange, request_body_ref: undefined }} user={admin} onSelectExchange={vi.fn()} onReplayed={onReplayed} />);

    fireEvent.click(screen.getByRole("button", { name: "编辑并 Replay" }));
    expect(screen.getAllByDisplayValue("X-Test")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Replay body"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "准备发送" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("target.test")).toBeInTheDocument();
    expect(within(dialog).getByText("https://target.test")).toBeInTheDocument();
    expect(within(dialog).getByText(/敏感 header 与 body/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认发送" }));

    await waitFor(() => expect(replayTrafficExchange).toHaveBeenCalledWith(41, expect.objectContaining({
      runtimeDir: "runtime/a",
      method: "POST",
      url: exchange.url,
      body: { encoding: "base64", data: "aGVsbG8=" },
      headers: expect.arrayContaining([
        { name: "X-Test", value: "first", ordinal: 1 },
        { name: "X-Test", value: "second", ordinal: 2 }
      ])
    })));
    await waitFor(() => expect(onReplayed).toHaveBeenCalledWith(42));
  });
});
