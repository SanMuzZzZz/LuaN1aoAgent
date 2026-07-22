import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  it("opens Web Traffic through the dedicated traffic view", () => {
    const onViewChange = vi.fn();
    render(
      <Sidebar
        activeView="trace"
        runtimeDir="runtime/a"
        sessions={[]}
        agents={{}}
        onViewChange={onViewChange}
        onRuntimeChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Web Traffic"));
    expect(onViewChange).toHaveBeenCalledWith("traffic");
  });
});
