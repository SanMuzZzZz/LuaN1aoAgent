import { describe, expect, it } from "vitest";
import { buildSessionTree } from "./sessions";
import type { RuntimeSession } from "./types";

describe("buildSessionTree", () => {
  it("groups nested competition sessions by their real folder path", () => {
    const tree = buildSessionTree([
      session("root", ".agent-runtime", "", true, "2026-07-12T02:00:00Z"),
      session("single", ".agent-runtime/single", "single", false, "2026-07-12T03:00:00Z"),
      session("a-07", ".agent-runtime/competition-20260712/a-07", "competition-20260712/a-07", false, "2026-07-12T05:00:00Z"),
      session("a-03", ".agent-runtime/competition-20260712/a-03", "competition-20260712/a-03", false, "2026-07-12T04:00:00Z")
    ]);

    expect(tree.rootSessions.map((item) => item.name)).toEqual(["root"]);
    expect(tree.standalone?.sessions.map((item) => item.name)).toEqual(["single"]);
    expect(tree.folders).toHaveLength(1);
    expect(tree.folders[0].name).toBe("competition-20260712");
    expect(tree.folders[0].sessionCount).toBe(2);
    expect(tree.folders[0].sessions.map((item) => item.name)).toEqual(["a-07", "a-03"]);
  });
});

function session(name: string, runtimeDir: string, relativePath: string, isRoot: boolean, updatedAt: string): RuntimeSession {
  return {
    name,
    runtimeDir,
    relativePath,
    isRoot,
    updatedAt,
    source: "sqlite",
    nodeCount: 0,
    edgeCount: 0,
    taskCount: 1,
    eventCount: 2,
    artifactCount: 0
  };
}
