import type { GraphEdge, GraphKind, GraphNode, JsonValue } from "./types";

export interface FilteredGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface NodePalette {
  color: string;
  background: string;
}

export interface TaskProgressItem {
  id: string;
  type: "Milestone" | "Blocker";
  label: string;
  status?: string;
  reason?: string;
  evidenceRefs: string[];
  artifactRefs: string[];
  updatedAt?: string;
}

const TASK_NODE_TYPES = new Set(["Scope", "Goal", "Task"]);

const PALETTES: Record<string, NodePalette> = {
  Scope: { color: "#0f766e", background: "#f0fdfa" },
  Goal: { color: "#1d4ed8", background: "#eff6ff" },
  Task: { color: "#2563eb", background: "#eff6ff" },
  Milestone: { color: "#b45309", background: "#fffbeb" },
  Blocker: { color: "#be123c", background: "#fff1f2" },
  Evidence: { color: "#0369a1", background: "#f0f9ff" },
  Hypothesis: { color: "#a16207", background: "#fefce8" },
  Vulnerability: { color: "#be123c", background: "#fff1f2" },
  Exploit: { color: "#7e22ce", background: "#faf5ff" },
  Host: { color: "#4338ca", background: "#eef2ff" },
  Port: { color: "#475569", background: "#f8fafc" },
  Service: { color: "#0f766e", background: "#f0fdfa" },
  WebEndpoint: { color: "#c2410c", background: "#fff7ed" },
  WebEntry: { color: "#c2410c", background: "#fff7ed" },
  Parameter: { color: "#7e22ce", background: "#faf5ff" },
  Credential: { color: "#be185d", background: "#fdf2f8" },
  AgentSession: { color: "#047857", background: "#ecfdf5" },
  ShellSession: { color: "#15803d", background: "#f0fdf4" },
  Session: { color: "#047857", background: "#ecfdf5" }
};

export function nodePalette(type: string): NodePalette {
  return PALETTES[type] || { color: "#64748b", background: "#f8fafc" };
}

export interface EdgePresentation {
  status: "live" | "degraded" | "stale" | "closed";
  color: string;
  lineStyle: "solid" | "dashed" | "dotted";
  opacity: number;
}

export function edgePresentation(edge: GraphEdge): EdgePresentation {
  const status = edge.properties.status;
  if (status === "degraded") return { status, color: "#f59e0b", lineStyle: "solid", opacity: 0.82 };
  if (status === "stale") return { status, color: "#94a3b8", lineStyle: "dashed", opacity: 0.58 };
  if (status === "closed") return { status, color: "#cbd5e1", lineStyle: "dotted", opacity: 0.28 };
  if (status === "live") return { status, color: "#16a34a", lineStyle: "solid", opacity: 0.82 };
  return { status: "live", color: "#a8b4c8", lineStyle: "solid", opacity: 0.72 };
}

export function filterGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  kind: GraphKind,
  query: string,
  nodeTypes: string[],
  edgeTypes: string[]
): FilteredGraph {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const allowedNodeTypes = new Set(nodeTypes);
  const allowedEdgeTypes = new Set(edgeTypes);
  const kindNodes = nodes.filter((node) => node.graphKind === kind);
  const kindNodeIds = new Set(kindNodes.map((node) => node.id));
  const kindEdges = edges.filter((edge) => kindNodeIds.has(edge.from) && kindNodeIds.has(edge.to));
  const projected = kind === "task" ? projectTaskTree(kindNodes, kindEdges) : { nodes: kindNodes, edges: kindEdges };
  const visibleNodes = projected.nodes.filter((node) => {
    if (allowedNodeTypes.size && !allowedNodeTypes.has(node.type)) return false;
    if (!normalizedQuery) return true;
    return `${node.label} ${node.id} ${node.type} ${JSON.stringify(node.properties)}`.toLocaleLowerCase().includes(normalizedQuery);
  });
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = projected.edges.filter((edge) => {
    if (!visibleIds.has(edge.from) || !visibleIds.has(edge.to)) return false;
    return !allowedEdgeTypes.size || allowedEdgeTypes.has(edge.type);
  });
  return { nodes: visibleNodes, edges: visibleEdges };
}

export function projectTaskTree(nodes: GraphNode[], edges: GraphEdge[]): FilteredGraph {
  const taskKindNodes = nodes.filter((node) => node.graphKind === "task");
  const taskKindNodeIds = new Set(taskKindNodes.map((node) => node.id));
  const taskKindEdges = edges.filter((edge) => taskKindNodeIds.has(edge.from) && taskKindNodeIds.has(edge.to));
  const rawNodeById = new Map(taskKindNodes.map((node) => [node.id, node]));
  const progressByTask = collectTaskProgress(taskKindNodes, taskKindEdges, rawNodeById);
  const treeNodes = taskKindNodes
    .filter((node) => TASK_NODE_TYPES.has(node.type))
    .map((node) => node.type === "Task" ? attachTaskProgress(node, progressByTask.get(node.id)) : node);
  const nodeById = new Map(treeNodes.map((node) => [node.id, node]));
  const scopes = treeNodes.filter((node) => node.type === "Scope").sort(compareNode);
  const goals = treeNodes.filter((node) => node.type === "Goal").sort(compareNode);
  const tasks = treeNodes.filter((node) => node.type === "Task").sort(compareNode);
  const parentByChild = new Map<string, string>();
  const treeEdges: GraphEdge[] = [];

  const addTreeEdge = (parentId: string, childId: string, type: string, sourceEdge?: GraphEdge) => {
    if (parentId === childId || parentByChild.has(childId) || !nodeById.has(parentId) || !nodeById.has(childId)) return false;
    if (createsParentCycle(childId, parentId, parentByChild)) return false;
    parentByChild.set(childId, parentId);
    treeEdges.push({
      id: `tree:${parentId}:${type}:${childId}`,
      from: parentId,
      to: childId,
      type,
      properties: sourceEdge?.properties || {},
      evidenceRefs: sourceEdge?.evidenceRefs || [],
      updatedAt: sourceEdge?.updatedAt
    });
    return true;
  };

  for (const goal of goals) {
    const scopeEdge = taskKindEdges.find((edge) => edge.type === "within_scope" && edge.from === goal.id && nodeById.get(edge.to)?.type === "Scope");
    const scope = scopeEdge ? nodeById.get(scopeEdge.to) : scopes[0];
    if (scope) addTreeEdge(scope.id, goal.id, "contains_goal", scopeEdge);
  }

  for (const task of tasks) {
    const dependencyEdges = taskKindEdges
      .filter((edge) => edge.type === "depends_on" && edge.from === task.id && nodeById.get(edge.to)?.type === "Task")
      .sort(compareEdge);
    let attached = dependencyEdges.some((edge) => addTreeEdge(edge.to, task.id, "depends_on", edge));

    if (!attached) {
      const parentTaskId = typeof task.properties.parentTaskId === "string" ? task.properties.parentTaskId : undefined;
      if (parentTaskId && nodeById.get(parentTaskId)?.type === "Task") {
        attached = addTreeEdge(parentTaskId, task.id, "parent_task");
      }
    }

    if (!attached) {
      const decomposition = taskKindEdges
        .filter((edge) => edge.type === "decomposes_to" && edge.to === task.id && nodeById.get(edge.from)?.type === "Goal")
        .sort(compareEdge)[0];
      const goal = decomposition ? nodeById.get(decomposition.from) : goals[0];
      if (goal) addTreeEdge(goal.id, task.id, "decomposes_to", decomposition);
    }
  }

  const fallbackRoot = goals[0] || scopes[0];
  if (fallbackRoot) {
    for (const node of treeNodes) {
      if (node.id !== fallbackRoot.id && !parentByChild.has(node.id) && node.type === "Task") {
        addTreeEdge(fallbackRoot.id, node.id, "contains");
      }
    }
  }

  return { nodes: treeNodes, edges: treeEdges };
}

export function graphSignature(runtimeDir: string, kind: GraphKind, graph: FilteredGraph): string {
  const nodes = graph.nodes.map((node) => `${node.id}:${node.updatedAt || ""}:${node.label}:${JSON.stringify(node.properties)}`).sort();
  const edges = graph.edges.map((edge) => `${edge.id || ""}:${edge.from}:${edge.type}:${edge.to}:${edge.updatedAt || ""}:${JSON.stringify(edge.properties)}`).sort();
  return `${runtimeDir}|${kind}|${nodes.join("|")}|${edges.join("|")}`;
}

export function elkLayout(kind: GraphKind, nodeCount: number): Record<string, unknown> {
  const taskTree = kind === "task";
  return {
    name: "elk",
    fit: true,
    animate: false,
    padding: 42,
    nodeDimensionsIncludeLabels: true,
    elk: {
      algorithm: taskTree ? "mrtree" : "layered",
      "elk.direction": kind === "operation" ? "RIGHT" : "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": nodeCount > 250 ? 52 : taskTree ? 92 : 78,
      "elk.spacing.nodeNode": nodeCount > 250 ? 30 : taskTree ? 56 : 48,
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.edgeRouting": "ORTHOGONAL"
    }
  };
}

export function nodeDisplayLabel(node: GraphNode, kind: GraphKind): string {
  if (kind === "task") {
    const characters = [...node.label];
    const clipped = characters.slice(0, 30);
    const lines = [clipped.slice(0, 15), clipped.slice(15, 30)].filter((line) => line.length > 0).map((line) => line.join(""));
    if (characters.length > 30 && lines.length) lines[lines.length - 1] += "…";
    const progress = node.type === "Task" ? taskProgressSummary(node) : undefined;
    return `${node.type}\n${lines.join("\n")}${progress ? `\n${progress}` : ""}`;
  }
  const max = kind === "operation" ? 28 : 38;
  const label = node.label.length > max ? `${node.label.slice(0, max)}…` : node.label;
  return `${node.type}\n${label}`;
}

export function taskProgressItems(node: GraphNode, type: "milestones" | "blockers"): TaskProgressItem[] {
  const value = node.properties[type];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isJsonRecord(item) || typeof item.id !== "string" || typeof item.label !== "string") return [];
    const itemType = item.type === "Blocker" ? "Blocker" : "Milestone";
    return [{
      id: item.id,
      type: itemType,
      label: item.label,
      status: typeof item.status === "string" ? item.status : undefined,
      reason: typeof item.reason === "string" ? item.reason : undefined,
      evidenceRefs: stringArray(item.evidenceRefs),
      artifactRefs: stringArray(item.artifactRefs),
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined
    }];
  });
}

export function taskProgressSummary(node: GraphNode): string | undefined {
  const milestoneCount = taskProgressItems(node, "milestones").length;
  const blockerCount = taskProgressItems(node, "blockers").length;
  const parts = [
    milestoneCount ? `${milestoneCount} 里程碑` : undefined,
    blockerCount ? `${blockerCount} 阻塞` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ") || undefined;
}

function collectTaskProgress(
  nodes: GraphNode[],
  edges: GraphEdge[],
  nodeById: Map<string, GraphNode>
): Map<string, { milestones: TaskProgressItem[]; blockers: TaskProgressItem[] }> {
  const progressByTask = new Map<string, { milestones: TaskProgressItem[]; blockers: TaskProgressItem[] }>();
  const taskIds = new Set(nodes.filter((node) => node.type === "Task").map((node) => node.id));

  for (const progressNode of nodes.filter((node) => node.type === "Milestone" || node.type === "Blocker").sort(compareNode)) {
    const relationType = progressNode.type === "Blocker" ? "blocked_by" : "produces_milestone";
    const relation = edges
      .filter((edge) => edge.type === relationType && edge.to === progressNode.id && taskIds.has(edge.from))
      .sort(compareEdge)[0];
    const propertyTaskId = typeof progressNode.properties.taskId === "string" ? progressNode.properties.taskId : undefined;
    const taskId = relation?.from || (propertyTaskId && nodeById.get(propertyTaskId)?.type === "Task" ? propertyTaskId : undefined);
    if (!taskId) continue;
    const bucket = progressByTask.get(taskId) || { milestones: [], blockers: [] };
    const item = toTaskProgressItem(progressNode);
    if (progressNode.type === "Blocker") bucket.blockers.push(item);
    else bucket.milestones.push(item);
    progressByTask.set(taskId, bucket);
  }

  return progressByTask;
}

function attachTaskProgress(
  task: GraphNode,
  progress?: { milestones: TaskProgressItem[]; blockers: TaskProgressItem[] }
): GraphNode {
  const milestones = progress?.milestones || [];
  const blockers = progress?.blockers || [];
  return {
    ...task,
    properties: {
      ...task.properties,
      milestones: milestones.map(toJsonRecord),
      blockers: blockers.map(toJsonRecord),
      milestoneCount: milestones.length,
      blockerCount: blockers.length
    }
  };
}

function toTaskProgressItem(node: GraphNode): TaskProgressItem {
  return {
    id: node.id,
    type: node.type === "Blocker" ? "Blocker" : "Milestone",
    label: node.label,
    status: typeof node.properties.status === "string" ? node.properties.status : undefined,
    reason: typeof node.properties.reason === "string" ? node.properties.reason : undefined,
    evidenceRefs: node.evidenceRefs,
    artifactRefs: stringArray(node.properties.artifactRefs),
    updatedAt: node.updatedAt
  };
}

function toJsonRecord(item: TaskProgressItem): { [key: string]: JsonValue } {
  const record: { [key: string]: JsonValue } = {
    id: item.id,
    type: item.type,
    label: item.label,
    evidenceRefs: item.evidenceRefs,
    artifactRefs: item.artifactRefs
  };
  if (item.status) record.status = item.status;
  if (item.reason) record.reason = item.reason;
  if (item.updatedAt) record.updatedAt = item.updatedAt;
  return record;
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function createsParentCycle(childId: string, parentId: string, parentByChild: Map<string, string>): boolean {
  let current: string | undefined = parentId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (current === childId) return true;
    visited.add(current);
    current = parentByChild.get(current);
  }
  return false;
}

function compareNode(left: GraphNode, right: GraphNode): number {
  return left.id.localeCompare(right.id);
}

function compareEdge(left: GraphEdge, right: GraphEdge): number {
  return `${left.from}:${left.type}:${left.to}`.localeCompare(`${right.from}:${right.type}:${right.to}`);
}
