import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResizableWorkspace } from "./ResizableWorkspace";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ResizableWorkspace", () => {
  it("renders two accessible resize handles on wide screens", () => {
    mockMedia(() => false);
    render(<ResizableWorkspace sidebar={<div>sidebar</div>} main={<div>main</div>} inspector={<div>inspector</div>} />);

    expect(screen.getByRole("separator", { name: "调整导航栏宽度" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "调整详情栏宽度" })).toBeInTheDocument();
  });

  it("keeps only the sidebar resize handle on compact screens", () => {
    mockMedia((query) => query.includes("1180px"));
    render(<ResizableWorkspace sidebar={<div>sidebar</div>} main={<div>main</div>} inspector={<div>inspector</div>} />);

    expect(screen.getByRole("separator", { name: "调整导航栏宽度" })).toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "调整详情栏宽度" })).not.toBeInTheDocument();
  });

  it("uses the drawer-only layout on mobile", () => {
    mockMedia(() => true);
    render(<ResizableWorkspace sidebar={<div>sidebar</div>} main={<div>main</div>} inspector={<div>inspector</div>} />);

    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.queryByText("sidebar")).not.toBeInTheDocument();
  });
});

function mockMedia(matches: (query: string) => boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
}
