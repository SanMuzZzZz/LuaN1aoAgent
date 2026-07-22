import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTrafficExchange, fetchTrafficHistory } from "../api";
import type { TrafficExchange } from "../types";
import { formatTrafficMode, TrafficView } from "./TrafficView";

vi.mock("../api", () => ({
  fetchTrafficExchange: vi.fn(),
  fetchTrafficHistory: vi.fn()
}));

const exchange: TrafficExchange = {
  id: 41,
  started_at: "2026-07-10T17:27:20.000Z",
  completed_at: "2026-07-10T17:27:20.125Z",
  duration_ms: 125,
  method: "GET",
  url: "https://target.test/api/items",
  host: "target.test",
  scheme: "https",
  protocol: "HTTP/2",
  mode: "mitm",
  status: 200,
  request_observed_bytes: 0,
  response_observed_bytes: 128,
  request_captured_bytes: 0,
  response_captured_bytes: 128,
  request_capture_state: "none",
  response_capture_state: "captured",
  request_truncated: false,
  response_truncated: false,
  headers_truncated: false,
  quota_pressure: false,
  evicted_exchanges: 0
};

const mockedHistory = vi.mocked(fetchTrafficHistory);
const mockedExchange = vi.mocked(fetchTrafficExchange);

beforeEach(() => {
  vi.clearAllMocks();
  mockedHistory.mockResolvedValue({ items: [exchange], has_more: true, next_cursor: "cursor-2" });
  mockedExchange.mockResolvedValue(exchange);
});

describe("TrafficView", () => {
  it("applies filters and navigates cursor pages", async () => {
    const onSelectExchange = vi.fn();
    render(
      <TrafficView
        runtimeDir="runtime/a"
        onSelectExchange={onSelectExchange}
        onExchangeLoaded={vi.fn()}
      />
    );

    await waitFor(() => expect(mockedHistory).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Method 过滤"), { target: { value: "POST" } });
    fireEvent.change(screen.getByLabelText("Host 过滤"), { target: { value: "api.target.test" } });
    fireEvent.change(screen.getByLabelText("Status 过滤"), { target: { value: "201" } });
    fireEvent.click(screen.getByRole("button", { name: /应用/ }));

    await waitFor(() => expect(mockedHistory).toHaveBeenLastCalledWith(
      "runtime/a",
      expect.objectContaining({
        cursor: undefined,
        limit: 50,
        filters: expect.objectContaining({ method: "POST", host: "api.target.test", status: 201 })
      }),
      expect.any(AbortSignal)
    ));

    fireEvent.click(screen.getByRole("button", { name: /下一页/ }));
    await waitFor(() => expect(mockedHistory).toHaveBeenLastCalledWith(
      "runtime/a",
      expect.objectContaining({ cursor: "cursor-2" }),
      expect.any(AbortSignal)
    ));

    fireEvent.click(screen.getByRole("button", { name: /上一页/ }));
    await waitFor(() => expect(mockedHistory).toHaveBeenLastCalledWith(
      "runtime/a",
      expect.objectContaining({ cursor: undefined }),
      expect.any(AbortSignal)
    ));
  });

  it("selects the first result and loads the controlled selection detail", async () => {
    const onSelectExchange = vi.fn();
    const onExchangeLoaded = vi.fn();
    const { rerender } = render(
      <TrafficView
        runtimeDir="runtime/a"
        onSelectExchange={onSelectExchange}
        onExchangeLoaded={onExchangeLoaded}
      />
    );

    await waitFor(() => expect(onSelectExchange).toHaveBeenCalledWith(41));
    rerender(
      <TrafficView
        runtimeDir="runtime/a"
        selectedExchangeId={41}
        onSelectExchange={onSelectExchange}
        onExchangeLoaded={onExchangeLoaded}
      />
    );

    await waitFor(() => expect(mockedExchange).toHaveBeenCalledWith("runtime/a", 41, expect.any(AbortSignal)));
    await waitFor(() => expect(onExchangeLoaded).toHaveBeenCalledWith(exchange));
    fireEvent.click(screen.getByRole("button", { name: "选择 exchange 41" }));
    expect(onSelectExchange).toHaveBeenLastCalledWith(41);
  });

  it("clears old history and detail when a runtime load fails", async () => {
    const onSelectExchange = vi.fn();
    const onExchangeLoaded = vi.fn();
    const { rerender } = render(
      <TrafficView runtimeDir="runtime/a" selectedExchangeId={41} onSelectExchange={onSelectExchange} onExchangeLoaded={onExchangeLoaded} />
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "选择 exchange 41" })).toBeInTheDocument());
    await waitFor(() => expect(onExchangeLoaded).toHaveBeenCalledWith(exchange));
    mockedHistory.mockImplementation((runtimeDir) => runtimeDir === "runtime/b"
      ? Promise.reject(new Error("runtime unavailable"))
      : Promise.resolve({ items: [exchange], has_more: true, next_cursor: "cursor-2" }));
    rerender(<TrafficView runtimeDir="runtime/b" selectedExchangeId={41} onSelectExchange={onSelectExchange} onExchangeLoaded={onExchangeLoaded} />);

    await waitFor(() => expect(screen.getByText("runtime unavailable")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "选择 exchange 41" })).not.toBeInTheDocument();
    expect(onSelectExchange).toHaveBeenCalledWith(undefined);
    expect(onExchangeLoaded).toHaveBeenLastCalledWith(undefined);
  });

  it("clears the previous detail before and after a detail load failure", async () => {
    const onExchangeLoaded = vi.fn();
    mockedExchange.mockRejectedValueOnce(new Error("detail unavailable"));
    render(<TrafficView runtimeDir="runtime/a" selectedExchangeId={41} onSelectExchange={vi.fn()} onExchangeLoaded={onExchangeLoaded} />);

    await waitFor(() => expect(screen.getByText("detail unavailable")).toBeInTheDocument());
    expect(onExchangeLoaded).toHaveBeenCalledWith(undefined);
    expect(onExchangeLoaded).not.toHaveBeenCalledWith(exchange);
  });

  it("does not label replay and forward traffic as passthrough", () => {
    expect(formatTrafficMode("replay")).toBe("Replay");
    expect(formatTrafficMode("forward")).toBe("Forward");
    expect(formatTrafficMode("https_passthrough")).toBe("Passthrough");
    expect(formatTrafficMode("mitm_best_effort")).toBe("MITM");
  });
});
