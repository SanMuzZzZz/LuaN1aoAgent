import { describe, expect, it } from "vitest";
import { edgePresentation, elkLayout, filterGraph, graphSignature, nodeDisplayLabel, nodePalette, projectTaskTree } from "./graph";
import type { GraphEdge, GraphNode } from "./types";

const nodes: GraphNode[] = [
  { id: "task:1", graphKind: "task", type: "Task", label: "Collect evidence", properties: {}, evidenceRefs: [] },
  { id: "goal:1", graphKind: "task", type: "Goal", label: "Finish target", properties: {}, evidenceRefs: [] },
  { id: "host:1", graphKind: "operation", type: "Host", label: "10.0.0.1", properties: {}, evidenceRefs: [] }
];
const edges: GraphEdge[] = [
  { from: "goal:1", to: "task:1", type: "decomposes_to", properties: {}, evidenceRefs: [] },
  { from: "host:1", to: "task:1", type: "unrelated", properties: {}, evidenceRefs: [] }
];

describe("filterGraph", () => {
  it("keeps only edges whose two endpoints remain visible", () => {
    const result = filterGraph(nodes, edges, "task", "", [], []);
    expect(result.nodes.map((node) => node.id)).toEqual(["task:1", "goal:1"]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].type).toBe("decomposes_to");
  });

  it("filters by query and semantic types", () => {
    expect(filterGraph(nodes, edges, "task", "collect", [], []).nodes).toHaveLength(1);
    expect(filterGraph(nodes, edges, "task", "", ["Goal"], []).nodes[0].id).toBe("goal:1");
  });

  it("matches task progress text without showing progress as nodes", () => {
    const progressNodes: GraphNode[] = [
      ...nodes,
      { id: "blocker:1", graphKind: "task", type: "Blocker", label: "Bash execution blocked by missing sandbox-exec profile", properties: {}, evidenceRefs: [] }
    ];
    const progressEdges: GraphEdge[] = [
      ...edges,
      { from: "task:1", to: "blocker:1", type: "blocked_by", properties: {}, evidenceRefs: [] }
    ];
    const result = filterGraph(progressNodes, progressEdges, "task", "sandbox-exec", [], []);
    expect(result.nodes.map((node) => node.id)).toEqual(["task:1"]);
    expect(result.nodes.some((node) => node.type === "Blocker")).toBe(false);
  });
});

describe("graph presentation", () => {
  it("uses vertical layouts for task graphs and horizontal layouts for operation graphs", () => {
    expect((elkLayout("task", 10).elk as Record<string, string>)["elk.direction"]).toBe("DOWN");
    expect((elkLayout("task", 10).elk as Record<string, string>).algorithm).toBe("mrtree");
    expect((elkLayout("operation", 10).elk as Record<string, string>)["elk.direction"]).toBe("RIGHT");
  });

  it("produces stable signatures and semantic palettes", () => {
    expect(graphSignature("run", "task", { nodes: nodes.slice(0, 2), edges: edges.slice(0, 1) }))
      .toBe(graphSignature("run", "task", { nodes: nodes.slice(0, 2).reverse(), edges: edges.slice(0, 1) }));
    expect(nodePalette("Vulnerability").color).toBe("#be123c");
  });

  it("presents operational edge states and includes properties in signatures", () => {
    const edge = { from: "host:1", to: "host:2", type: "tunnels_to", properties: {}, evidenceRefs: [] };
    expect(edgePresentation({ ...edge, properties: { status: "live" } })).toMatchObject({ color: "#16a34a", lineStyle: "solid" });
    expect(edgePresentation({ ...edge, properties: { status: "degraded" } })).toMatchObject({ color: "#f59e0b", lineStyle: "solid" });
    expect(edgePresentation({ ...edge, properties: { status: "stale" } })).toMatchObject({ lineStyle: "dashed" });
    expect(edgePresentation({ ...edge, properties: { status: "closed" } })).toMatchObject({ lineStyle: "dotted", opacity: 0.28 });
    expect(edgePresentation(edge).color).toBe("#a8b4c8");
    const first = graphSignature("run", "operation", { nodes: [], edges: [edge] });
    const second = graphSignature("run", "operation", { nodes: [], edges: [{ ...edge, properties: { status: "closed" } }] });
    expect(first).not.toBe(second);
  });

  it("wraps long task labels into bounded lines", () => {
    const label = nodeDisplayLabel({
      id: "task:long",
      graphKind: "task",
      type: "Task",
      label: "这是一个需要在任务树节点中自动换行并且不能溢出边界的很长中文任务名称",
      properties: {},
      evidenceRefs: []
    }, "task");
    expect(label.split("\n")).toHaveLength(3);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("projectTaskTree", () => {
  it("projects duplicate task graph relations into one top-down parent per node", () => {
    const taskNodes: GraphNode[] = [
      { id: "scope:root", graphKind: "task", type: "Scope", label: "Scope", properties: {}, evidenceRefs: [] },
      { id: "goal:root", graphKind: "task", type: "Goal", label: "Goal", properties: {}, evidenceRefs: [] },
      { id: "task:recon", graphKind: "task", type: "Task", label: "Recon", properties: {}, evidenceRefs: [] },
      { id: "task:assess", graphKind: "task", type: "Task", label: "Assess", properties: {}, evidenceRefs: [] },
      { id: "task:finalize", graphKind: "task", type: "Task", label: "Finalize", properties: {}, evidenceRefs: [] },
      { id: "milestone:recon", graphKind: "task", type: "Milestone", label: "Attack surface collected", properties: { status: "achieved" }, evidenceRefs: ["evidence:1"] },
      { id: "blocker:assess", graphKind: "task", type: "Blocker", label: "Sandbox profile missing", properties: { status: "blocked", reason: "sandbox-exec profile is unavailable" }, evidenceRefs: ["evidence:2"] }
    ];
    const taskEdges: GraphEdge[] = [
      { from: "goal:root", to: "scope:root", type: "within_scope", properties: {}, evidenceRefs: [] },
      { from: "goal:root", to: "task:recon", type: "decomposes_to", properties: {}, evidenceRefs: [] },
      { from: "goal:root", to: "task:assess", type: "decomposes_to", properties: {}, evidenceRefs: [] },
      { from: "goal:root", to: "task:finalize", type: "decomposes_to", properties: {}, evidenceRefs: [] },
      { from: "task:assess", to: "task:recon", type: "depends_on", properties: {}, evidenceRefs: [] },
      { from: "task:finalize", to: "task:assess", type: "depends_on", properties: {}, evidenceRefs: [] },
      { from: "task:recon", to: "milestone:recon", type: "produces_milestone", properties: {}, evidenceRefs: [] },
      { from: "task:assess", to: "blocker:assess", type: "blocked_by", properties: {}, evidenceRefs: [] },
      { from: "task:recon", to: "goal:root", type: "requires_evidence", properties: {}, evidenceRefs: [] }
    ];

    const result = projectTaskTree(taskNodes, taskEdges);
    expect(result.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      "scope:root->goal:root",
      "task:recon->task:assess",
      "task:assess->task:finalize",
      "goal:root->task:recon"
    ]);
    expect(result.nodes.map((node) => node.type)).toEqual(["Scope", "Goal", "Task", "Task", "Task"]);
    const recon = result.nodes.find((node) => node.id === "task:recon");
    const assess = result.nodes.find((node) => node.id === "task:assess");
    expect(recon?.properties.milestoneCount).toBe(1);
    expect(recon?.properties.milestones).toEqual([expect.objectContaining({ id: "milestone:recon", label: "Attack surface collected" })]);
    expect(assess?.properties.blockerCount).toBe(1);
    expect(assess?.properties.blockers).toEqual([expect.objectContaining({ id: "blocker:assess", reason: "sandbox-exec profile is unavailable" })]);
  });

  it("breaks dependency cycles by falling back to the goal root", () => {
    const cycleNodes: GraphNode[] = [
      { id: "goal:root", graphKind: "task", type: "Goal", label: "Goal", properties: {}, evidenceRefs: [] },
      { id: "task:a", graphKind: "task", type: "Task", label: "A", properties: {}, evidenceRefs: [] },
      { id: "task:b", graphKind: "task", type: "Task", label: "B", properties: {}, evidenceRefs: [] }
    ];
    const cycleEdges: GraphEdge[] = [
      { from: "task:a", to: "task:b", type: "depends_on", properties: {}, evidenceRefs: [] },
      { from: "task:b", to: "task:a", type: "depends_on", properties: {}, evidenceRefs: [] }
    ];
    const result = projectTaskTree(cycleNodes, cycleEdges);
    expect(result.edges).toHaveLength(2);
    expect(new Set(result.edges.map((edge) => edge.to))).toEqual(new Set(["task:a", "task:b"]));
  });
});
