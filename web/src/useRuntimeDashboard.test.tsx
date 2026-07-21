import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeState, SessionsResponse } from "./types";
import { useRuntimeDashboard } from "./useRuntimeDashboard";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useRuntimeDashboard", () => {
  it("loads fresh state when the runtime directory changes", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const runtimeDir = url.includes("session-b") ? "session-b" : "session-a";
      const payload = url.startsWith("/api/state") ? stateFixture(runtimeDir) : sessionsFixture(runtimeDir);
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    }));

    const { result, rerender } = renderHook(({ runtimeDir }) => useRuntimeDashboard(runtimeDir), {
      initialProps: { runtimeDir: "session-a" }
    });
    await waitFor(() => expect(result.current.data?.runtimeDir).toBe("session-a"));
    rerender({ runtimeDir: "session-b" });
    await waitFor(() => expect(result.current.data?.runtimeDir).toBe("session-b"));
  });

  it("aborts in-flight requests when the hook unmounts", () => {
    const aborted = vi.fn();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", aborted);
      return new Promise<Response>(() => undefined);
    }));
    const { unmount } = renderHook(() => useRuntimeDashboard("session-a"));
    unmount();
    expect(aborted).toHaveBeenCalled();
  });

  it("polls every five seconds while auto refresh is enabled", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const payload = String(input).startsWith("/api/state") ? stateFixture("session-a") : sessionsFixture("session-a");
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useRuntimeDashboard("session-a"));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});

function stateFixture(runtimeDir: string): RuntimeState {
  return {
    runtimeDir,
    loadedAt: "2026-07-11T00:00:00.000Z",
    overview: {
      graph: { nodeCount: 0, edgeCount: 0, byKind: {}, byType: {} },
      events: { count: 0, byRole: {}, byType: {} },
      tasks: { count: 0, byStatus: {}, items: [] },
      artifacts: { count: 0, totalBytes: 0 },
      agents: {}
    },
    traceItems: [],
    graph: { nodes: [], edges: [], source: "sqlite", summary: {} },
    events: [],
    artifacts: { records: [], summary: { count: 0, totalBytes: 0 } }
  };
}

function sessionsFixture(runtimeDir: string): SessionsResponse {
  return {
    rootDir: runtimeDir,
    loadedAt: "2026-07-11T00:00:00.000Z",
    sessions: [],
    summary: { count: 0, totalTasks: 0, totalEvents: 0 }
  };
}
