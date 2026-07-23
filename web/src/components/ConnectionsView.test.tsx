import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchConnections, mutateConnection } from "../api";
import type { AuthUser, ConnectionItem } from "../types";
import { ConnectionsView } from "./ConnectionsView";

vi.mock("../api", () => ({
  fetchConnections: vi.fn(),
  mutateConnection: vi.fn()
}));

const connection: ConnectionItem = {
  id: "connectivity-tunnel:primary",
  externalId: "primary",
  kind: "tunnel",
  direction: "host-a → host-b",
  transport: "ssh",
  managed: true,
  desiredState: "running",
  observedState: "degraded",
  lastHeartbeat: "2026-07-20T10:00:00.000Z",
  error: "SSH probe failed",
  available: false,
  graphUrl: "?view=operation&nodeId=connectivity-tunnel%3Aprimary"
};

const admin: AuthUser = {
  id: "admin-1",
  username: "admin",
  displayName: "Admin",
  role: "admin",
  createdAt: "2026-07-20T00:00:00.000Z"
};
const analyst: AuthUser = { ...admin, id: "analyst-1", username: "analyst", role: "analyst" };
const mockedFetch = vi.mocked(fetchConnections);
const mockedMutate = vi.mocked(mutateConnection);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue({ runtimeDir: "runtime/a", loadedAt: new Date().toISOString(), connections: [connection] });
  mockedMutate.mockResolvedValue({ ...connection, desiredState: "stopped", observedState: "stale" });
});

describe("ConnectionsView", () => {
  it("shows lifecycle state, attribution limits and graph navigation", async () => {
    render(<ConnectionsView runtimeDir="runtime/a" user={analyst} />);

    await screen.findByText("primary");
    expect(screen.getByText("host-a → host-b")).toBeInTheDocument();
    expect(screen.getByText("ssh")).toBeInTheDocument();
    expect(screen.getByText("托管")).toBeInTheDocument();
    expect(screen.getByText("期望状态: 运行中")).toBeInTheDocument();
    expect(screen.getByText("异常")).toBeInTheDocument();
    expect(screen.getByText("不可用")).toBeInTheDocument();
    expect(screen.queryByText(/credential:ssh-primary|Credential/)).not.toBeInTheDocument();
    expect(screen.getByText("SSH probe failed")).toBeInTheDocument();
    expect(screen.getByText(/不会自动归因/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /状态图/ })).toHaveAttribute("href", connection.graphUrl);
    expect(screen.queryByRole("button", { name: "启动" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password|private key/i)).not.toBeInTheDocument();
  });

  it("clears connections when switching to a runtime that fails to load", async () => {
    const { rerender } = render(<ConnectionsView runtimeDir="runtime/a" user={analyst} />);
    await screen.findByText("primary");

    mockedFetch.mockRejectedValueOnce(new Error("runtime unavailable"));
    rerender(<ConnectionsView runtimeDir="runtime/b" user={analyst} />);

    await screen.findByText("runtime unavailable");
    expect(screen.queryByText("primary")).not.toBeInTheDocument();
    expect(screen.getByText("当前 Runtime 暂无连接")).toBeInTheDocument();
  });

  it("lets only admins mutate managed connection lifecycle", async () => {
    render(<ConnectionsView runtimeDir="runtime/a" user={admin} />);
    await screen.findByText("primary");

    fireEvent.click(screen.getByRole("button", { name: /停止/ }));
    await waitFor(() => expect(mockedMutate).toHaveBeenCalledWith("runtime/a", connection.id, "stop"));
    expect(await screen.findByText("期望状态: 已停止")).toBeInTheDocument();
  });
});
