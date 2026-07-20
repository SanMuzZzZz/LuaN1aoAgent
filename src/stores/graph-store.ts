import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { toJsonLine } from "../json.js";
import type {
  GraphDelta,
  GraphEdge,
  GraphKind,
  GraphNode,
  GraphSnapshot,
  GraphView,
  PlannerDecision,
  PlannerDecisionView,
  PlannerDigestItem,
  PlannerTaskLedgerItem,
  PlannerTaskPatch,
  TaskBudget,
  TaskEnvelope,
  TaskGraphStatus,
  TaskResult
} from "../types.js";

export class GraphValidationError extends Error {}

export type PlannerDecisionConflictItem = {
  nodeId: string;
  expectedVersion: number;
  currentVersion: number;
  type: string;
  label: string;
  status?: string;
};

export class PlannerDecisionConflict extends GraphValidationError {
  constructor(readonly conflicts: PlannerDecisionConflictItem[]) {
    super(`Planner decision version conflict: ${conflicts.map((conflict) => (
      `${conflict.nodeId} expected ${conflict.expectedVersion}, current ${conflict.currentVersion}`
    )).join("; ")}`);
    this.name = "PlannerDecisionConflict";
  }
}

export type TaskCreateInput = {
  parentTaskId?: string;
  taskId: string;
  goal: string;
  targetRefs: string[];
  scopeRef: string;
  constraints: string[];
  successCriteria: string[];
  dependsOnTaskRefs?: string[];
  parallelGroup?: string;
  budget?: TaskBudget;
  priority: number;
};

export type PlannerTaskBatchCommand =
  | {
      commandIndex: number;
      kind: "patch_task";
      taskId: string;
      patch: PlannerTaskPatch;
      expectedVersion?: number;
      sourceEventIds?: string[];
      reason?: string;
    }
  | {
      commandIndex: number;
      kind: "replace_dependencies";
      taskId: string;
      dependencyTaskIds: string[];
      expectedVersion?: number;
      sourceEventIds?: string[];
      reason?: string;
    }
  | {
      commandIndex: number;
      kind: "set_task_status";
      taskId: string;
      status: TaskGraphStatus;
      expectedVersion?: number;
      sourceEventIds?: string[];
      reason?: string;
    };

export type AppliedPlannerTaskBatchCommand = {
  commandIndex: number;
  kind: PlannerTaskBatchCommand["kind"];
  taskId: string;
  node: GraphNode;
};

type PlannerNodeStatusBatchCommand = {
  commandIndex: number;
  nodeId: string;
  status: string;
  expectedVersion?: number;
  sourceEventIds?: string[];
  reason?: string;
};

export type AppliedPlannerDecision = {
  createdNodes: GraphNode[];
  taskCommands: AppliedPlannerTaskBatchCommand[];
  nodeStatusCommands: Array<{ commandIndex: number; node: GraphNode }>;
};

export class SQLiteGraphStore {
  readonly databasePath: string;
  readonly deltaLogPath: string;
  private readonly database: DatabaseSync;

  constructor(databasePath: string, deltaLogPath: string) {
    this.databasePath = databasePath;
    this.deltaLogPath = deltaLogPath;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.initialize();
  }

  close(): void {
    this.database.close();
  }

  upsertDelta(delta: GraphDelta): void {
    this.applyDelta(delta);
  }

  commitProjection(input: {
    taskId: string;
    fromSeq: number;
    toSeq: number;
    generation: number;
    delta: GraphDelta;
  }): void {
    validateGraphDelta(input.delta);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.database.prepare(`
        SELECT committed_seq, desired_seq, active_generation
        FROM projection_states WHERE task_id = ?
      `).get(input.taskId) as {
        committed_seq: number;
        desired_seq: number;
        active_generation: number | null;
      } | undefined;
      if (!state) {
        throw new GraphValidationError(`Projection state not found for ${input.taskId}`);
      }
      if (Number(state.committed_seq) !== input.fromSeq) {
        throw new GraphValidationError(
          `Projection committed sequence conflict for ${input.taskId}: expected ${input.fromSeq}, current ${state.committed_seq}`
        );
      }
      if (Number(state.active_generation) !== input.generation) {
        throw new GraphValidationError(
          `Projection generation conflict for ${input.taskId}: expected ${input.generation}, current ${state.active_generation}`
        );
      }
      if (input.toSeq > Number(state.desired_seq)) {
        throw new GraphValidationError(
          `Projection range exceeds desired sequence for ${input.taskId}: ${input.toSeq} > ${state.desired_seq}`
        );
      }
      this.applyDeltaInTransaction(input.delta, []);
      const updated = this.database.prepare(`
        UPDATE projection_states
        SET committed_seq = ?, active_generation = NULL, updated_at = ?
        WHERE task_id = ? AND committed_seq = ? AND active_generation = ?
      `).run(
        input.toSeq,
        new Date().toISOString(),
        input.taskId,
        input.fromSeq,
        input.generation
      );
      if (Number(updated.changes) !== 1) {
        throw new GraphValidationError(`Projection state changed while committing ${input.taskId}`);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    appendDeltaLog(this.deltaLogPath, input.delta);
  }

  private applyDelta(
    delta: GraphDelta,
    edgeReplacements: Array<{ from: string; type: string }> = []
  ): void {
    validateGraphDelta(delta);
    this.database.exec("BEGIN");
    try {
      this.applyDeltaInTransaction(delta, edgeReplacements);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    appendDeltaLog(this.deltaLogPath, delta);
  }

  private applyDeltaInTransaction(
    delta: GraphDelta,
    edgeReplacements: Array<{ from: string; type: string }>
  ): void {
    for (const replacement of edgeReplacements) {
      this.database.prepare("DELETE FROM edges WHERE from_id = ? AND type = ?")
        .run(replacement.from, replacement.type);
    }
    for (const node of delta.nodes) {
      const existing = this.database.prepare(`
        SELECT graph_kind, type, properties_json, evidence_refs_json FROM nodes WHERE id = ?
      `).get(node.id) as {
        graph_kind: GraphKind;
        type: string;
        properties_json: string;
        evidence_refs_json: string;
      } | undefined;
      if (existing && (existing.graph_kind !== node.graphKind || existing.type !== node.type)) {
        throw new GraphValidationError(
          `Node identity conflict for ${node.id}: existing ${existing.graph_kind}/${existing.type}, submitted ${node.graphKind}/${node.type}`
        );
      }
      const properties = existing
        ? { ...(JSON.parse(existing.properties_json) as Record<string, unknown>), ...(node.properties ?? {}) }
        : node.properties ?? {};
      const evidenceRefs = dedupeStringValues([
        ...(existing ? JSON.parse(existing.evidence_refs_json) as string[] : []),
        ...(node.evidenceRefs ?? [])
      ]);
      this.database.prepare(`
        INSERT INTO nodes (id, graph_kind, type, label, properties_json, evidence_refs_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          graph_kind = excluded.graph_kind,
          type = excluded.type,
          label = excluded.label,
          properties_json = excluded.properties_json,
          evidence_refs_json = excluded.evidence_refs_json,
          updated_at = excluded.updated_at
      `).run(
        node.id,
        node.graphKind,
        node.type,
        node.label,
        JSON.stringify(properties),
        JSON.stringify(evidenceRefs),
        new Date().toISOString()
      );
    }
    for (const edge of delta.edges) {
      if (edge.type === "depends_on") {
        const fromNode = this.database.prepare("SELECT graph_kind, type FROM nodes WHERE id = ?")
          .get(edge.from) as { graph_kind: GraphKind; type: string } | undefined;
        const toNode = this.database.prepare("SELECT graph_kind, type FROM nodes WHERE id = ?")
          .get(edge.to) as { graph_kind: GraphKind; type: string } | undefined;
        if (fromNode?.graph_kind !== "task" || fromNode.type !== "Task"
          || toNode?.graph_kind !== "task" || toNode.type !== "Task") {
          throw new GraphValidationError(`depends_on requires Task -> Task, received ${edge.from} -> ${edge.to}`);
        }
      }
      const edgeId = edgeIdFor(edge);
      const existing = this.database.prepare(`
        SELECT properties_json, evidence_refs_json FROM edges WHERE id = ?
      `).get(edgeId) as { properties_json: string; evidence_refs_json: string } | undefined;
      const properties = existing
        ? { ...(JSON.parse(existing.properties_json) as Record<string, unknown>), ...(edge.properties ?? {}) }
        : edge.properties ?? {};
      const evidenceRefs = dedupeStringValues([
        ...(existing ? JSON.parse(existing.evidence_refs_json) as string[] : []),
        ...(edge.evidenceRefs ?? [])
      ]);
      this.database.prepare(`
        INSERT INTO edges (id, from_id, to_id, type, properties_json, evidence_refs_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          properties_json = excluded.properties_json,
          evidence_refs_json = excluded.evidence_refs_json,
          updated_at = excluded.updated_at
      `).run(
        edgeId,
        edge.from,
        edge.to,
        edge.type,
        JSON.stringify(properties),
        JSON.stringify(evidenceRefs),
        new Date().toISOString()
      );
    }
    this.database.prepare(`
      INSERT INTO graph_deltas (id, source_event_ids_json, delta_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      `delta:${randomUUID()}`,
      JSON.stringify(delta.sourceEventIds),
      JSON.stringify(delta),
      new Date().toISOString()
    );
  }

  query(view: GraphView, focusNodeIds: string[] = [], limit = 200): GraphSnapshot {
    if (view === "sessions") {
      return this.queryByNodeTypes(view, ["Session", "Credential"], limit);
    }
    if (view === "planner") {
      return this.queryPlannerView(limit);
    }
    const graphKind = view as GraphKind;
    let rawNodes: GraphNode[];
    if (focusNodeIds.length > 0) {
      const focusNodes = this.readNodes({ focusNodeIds, limit });
      const focusEdges = this.readEdgesForNodes(focusNodes.map((node) => node.id), limit * 2);
      const neighborhoodIds = dedupeStringValues([
        ...focusNodeIds,
        ...focusEdges.flatMap((edge) => [edge.from, edge.to])
      ]);
      const focusOrder = new Map(focusNodeIds.map((id, index) => [id, index]));
      rawNodes = this.readNodes({
        graphKind,
        focusNodeIds: neighborhoodIds,
        limit: Math.max(limit, neighborhoodIds.length)
      }).sort((left, right) => {
        const leftOrder = focusOrder.get(left.id);
        const rightOrder = focusOrder.get(right.id);
        if (leftOrder !== undefined || rightOrder !== undefined) {
          return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
        }
        return left.id.localeCompare(right.id);
      }).slice(0, limit);
    } else {
      rawNodes = this.readNodes({ graphKind, limit });
    }
    const edges = this.readEdgesForNodes(rawNodes.map((node) => node.id), limit);
    const nodes = withDerivedTaskDependencies(rawNodes, edges);
    return {
      view,
      nodes,
      edges,
      summary: summarize(nodes, edges)
    };
  }

  stats(): Record<string, unknown> {
    const totals = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS node_count,
        (SELECT COUNT(*) FROM edges) AS edge_count,
        (SELECT COUNT(*) FROM graph_deltas) AS delta_count,
        (SELECT COUNT(*) FROM nodes WHERE evidence_refs_json <> '[]') AS evidence_backed_node_count,
        (SELECT COUNT(*) FROM edges WHERE evidence_refs_json <> '[]') AS evidence_backed_edge_count
    `).get() as {
      node_count: number;
      edge_count: number;
      delta_count: number;
      evidence_backed_node_count: number;
      evidence_backed_edge_count: number;
    };
    const nodesByKind = Object.fromEntries((this.database.prepare(`
      SELECT graph_kind, COUNT(*) AS count FROM nodes GROUP BY graph_kind ORDER BY graph_kind
    `).all() as Array<{ graph_kind: string; count: number }>).map((row) => [row.graph_kind, Number(row.count)]));
    return {
      nodeCount: Number(totals.node_count),
      edgeCount: Number(totals.edge_count),
      deltaCount: Number(totals.delta_count),
      evidenceBackedNodeCount: Number(totals.evidence_backed_node_count),
      evidenceBackedEdgeCount: Number(totals.evidence_backed_edge_count),
      nodesByKind
    };
  }

  trace(input: { nodeId?: string; evidenceId?: string }): GraphSnapshot {
    const focusNodeIds = input.nodeId ? [input.nodeId] : input.evidenceId ? [input.evidenceId] : [];
    const directNodes = this.readNodes({ focusNodeIds, limit: 50 });
    const connectedEdges = this.readEdgesForNodes(directNodes.map((node) => node.id), 100);
    const connectedIds = new Set<string>();
    for (const edge of connectedEdges) {
      connectedIds.add(edge.from);
      connectedIds.add(edge.to);
    }
    const connectedNodes = this.readNodes({ focusNodeIds: [...connectedIds], limit: 100 });
    const nodes = withDerivedTaskDependencies(dedupeNodes([...directNodes, ...connectedNodes]), connectedEdges);
    return {
      view: "planner",
      nodes,
      edges: connectedEdges,
      summary: { focusNodeIds }
    };
  }

  projectionClosure(input: {
    taskId: string;
    scopeRef: string;
    dependencyTaskIds?: string[];
    targetRefs?: string[];
    anchors?: string[];
    nodeLimit?: number;
    edgeLimit?: number;
  }): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodeLimit = Math.max(8, input.nodeLimit ?? 24);
    const edgeLimit = Math.max(12, input.edgeLimit ?? 36);
    const taskMemoryRefs = dedupeStringValues([
      input.taskId,
      ...(input.dependencyTaskIds ?? []),
      ...(input.targetRefs ?? []).filter((ref) => ref.startsWith("task:"))
    ]);
    const taskContextRefs = dedupeStringValues([...taskMemoryRefs, input.scopeRef]);
    const taskNodes = this.readNodes({ focusNodeIds: taskContextRefs, limit: Math.max(taskContextRefs.length, 8) });
    const operationNodes = this.readNodes({ graphKind: "operation", limit: 500 });
    const reasoningNodes = this.readNodes({ graphKind: "reasoning", limit: 500 });
    const semanticNodes = [...operationNodes, ...reasoningNodes];
    const nodeById = new Map([...taskNodes, ...semanticNodes].map((node) => [node.id, node]));
    const semanticEdges = this.readEdgesForNodes(semanticNodes.map((node) => node.id), 5000)
      .filter((edge) => nodeById.has(edge.from) && nodeById.has(edge.to));
    const taskEdges = this.readEdgesForNodes(taskNodes.map((node) => node.id), 200)
      .filter((edge) => nodeById.has(edge.from) && nodeById.has(edge.to));
    const anchorTokens = dedupeStringValues(input.anchors ?? [])
      .map(normalizeProjectionToken)
      .filter((token) => token.length >= 3);
    const exactSemanticRefs = new Set((input.targetRefs ?? []).filter((ref) => nodeById.get(ref)?.graphKind !== "task"));
    const anchorSeedNodes = semanticNodes.filter((node) => (
      exactSemanticRefs.has(node.id)
      || anchorTokens.some((token) => projectionNodeSearchText(node).includes(token))
    ));

    const selectedIds = new Set(taskNodes.slice(0, 8).map((node) => node.id));
    const allEdges = [...new Map([...taskEdges, ...semanticEdges].map((edge) => [edgeIdFor(edge), edge])).values()];
    const adjacency = buildEdgeAdjacency(allEdges);
    const allowedTaskIds = new Set(taskMemoryRefs);
    const collectNeighborhood = (seedIds: string[], maxNewNodes: number, maxDepth: number): void => {
      const queue = seedIds.map((nodeId) => ({ nodeId, depth: 0 }));
      const queued = new Set(seedIds);
      const expanded = new Set<string>();
      let added = 0;
      while (queue.length > 0 && selectedIds.size < nodeLimit && added < maxNewNodes) {
        const current = queue.shift();
        if (!current || expanded.has(current.nodeId)) {
          continue;
        }
        expanded.add(current.nodeId);
        const currentNode = nodeById.get(current.nodeId);
        if (currentNode && !selectedIds.has(current.nodeId)) {
          selectedIds.add(current.nodeId);
          added += 1;
        }
        if (current.depth >= maxDepth) {
          continue;
        }
        const neighbors = (adjacency.get(current.nodeId) ?? [])
          .map((nodeId) => nodeById.get(nodeId))
          .filter((node): node is GraphNode => Boolean(node))
          .filter((node) => node.graphKind !== "task" || allowedTaskIds.has(node.id))
          .sort(compareProjectionSeedNodes);
        for (const neighbor of neighbors) {
          if (!queued.has(neighbor.id)) {
            queued.add(neighbor.id);
            queue.push({ nodeId: neighbor.id, depth: current.depth + 1 });
          }
        }
      }
    };
    const availableSemanticSlots = Math.max(0, nodeLimit - selectedIds.size);
    collectNeighborhood(taskMemoryRefs, Math.min(8, Math.ceil(availableSemanticSlots * 0.65)), 4);
    collectNeighborhood(
      anchorSeedNodes.sort(compareProjectionSeedNodes).map((node) => node.id),
      Math.max(0, nodeLimit - selectedIds.size),
      3
    );

    const nodes = [...selectedIds]
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is GraphNode => Boolean(node))
      .slice(0, nodeLimit);
    const includedIds = new Set(nodes.map((node) => node.id));
    const edges = allEdges
      .filter((edge) => includedIds.has(edge.from) && includedIds.has(edge.to))
      .sort(compareProjectionEdges)
      .slice(0, edgeLimit);
    return { nodes, edges };
  }

  plannerDecisionView(limit = 200): PlannerDecisionView {
    const rawTaskNodes = this.readNodes({ graphKind: "task", limit });
    const taskNodes = withDerivedTaskDependencies(
      rawTaskNodes,
      this.readEdgesForNodes(rawTaskNodes.map((node) => node.id), limit * 2)
    );
    const reasoningNodes = this.readNodes({ graphKind: "reasoning", limit });
    const operationNodes = this.readNodes({ graphKind: "operation", limit });
    const allNodes = dedupeNodes([...taskNodes, ...reasoningNodes, ...operationNodes]);
    const allEdges = this.readEdgesForNodes(allNodes.map((node) => node.id), limit * 4);
    const fullTaskLedger = buildTaskLedger(taskNodes);
    const taskLedger = [
      ...fullTaskLedger.filter((item) => ["open", "partial", "blocked", "failed"].includes(item.status)),
      ...fullTaskLedger.filter((item) => item.status === "completed").slice(0, 8),
      ...fullTaskLedger.filter((item) => item.status === "archived").slice(0, 4)
    ]
      .filter((item, index, items) => items.findIndex((candidate) => candidate.taskId === item.taskId) === index)
      .slice(0, 20);
    const context = createPlannerDigestContext(taskNodes, allEdges);
    return {
      view: "planner_decision",
      taskLedger,
      reasoningDigest: topDigestItems(reasoningNodes, allEdges, context, 10),
      operationDigest: topDigestItems(operationNodes, allEdges, context, 10),
      blockers: topDigestItems(
        taskNodes.filter((node) => node.type === "Blocker"),
        allEdges,
        context,
        5
      ),
      graphSummary: {
        ...summarize(allNodes, allEdges),
        taskStatusCounts: countTaskStatuses(taskNodes),
        digestLimits: {
          reasoningDigest: 10,
          operationDigest: 10,
          blockers: 5,
          taskLedger: 20
        }
      },
      retrievalHints: {
        tools: ["graph_query", "graph_trace"],
        note: "Planner 初始输入是压缩决策视图；信息不足时只能用 graph_query / graph_trace 按需读取限定图窗口或节点邻域。"
      }
    };
  }

  createTask(input: TaskCreateInput): void {
    this.createTasks([input]);
  }

  createTasks(inputs: TaskCreateInput[], sourceEventIds: string[] = []): GraphNode[] {
    const existingTaskIds = new Set(
      this.readNodes({ graphKind: "task", limit: 5000 })
        .filter((node) => node.type === "Task")
        .map((node) => node.id)
    );
    const newTaskIds = new Set<string>();
    for (const input of inputs) {
      if (existingTaskIds.has(input.taskId) || newTaskIds.has(input.taskId)) {
        throw new GraphValidationError(`Task ${input.taskId} already exists`);
      }
      newTaskIds.add(input.taskId);
    }
    const availableTaskIds = new Set([...existingTaskIds, ...newTaskIds]);
    const dependencyOverrides = new Map<string, string[]>();
    for (const input of inputs) {
      const dependencyTaskIds = [...new Set(input.dependsOnTaskRefs ?? [])];
      if (dependencyTaskIds.includes(input.taskId)) {
        throw new GraphValidationError(`Task ${input.taskId} cannot depend on itself`);
      }
      for (const dependencyTaskId of dependencyTaskIds) {
        if (!availableTaskIds.has(dependencyTaskId)) {
          throw new GraphValidationError(`Dependency task ${dependencyTaskId} does not exist`);
        }
      }
      dependencyOverrides.set(input.taskId, dependencyTaskIds);
    }
    this.assertDependencyGraphAcyclic(dependencyOverrides);
    const nodes: GraphNode[] = inputs.map((input) => ({
      id: input.taskId,
      graphKind: "task",
      type: "Task",
      label: input.goal,
      properties: {
        status: "open",
        version: 1,
        targetRefs: input.targetRefs,
        scopeRef: input.scopeRef,
        constraints: input.constraints,
        successCriteria: input.successCriteria,
        parentTaskId: input.parentTaskId,
        parallelGroup: input.parallelGroup,
        budget: input.budget,
        priority: input.priority
      }
    }));
    const edges: GraphEdge[] = inputs.flatMap((input) => {
      const taskEdges: GraphEdge[] = [
        { from: input.taskId, to: input.scopeRef, type: "within_scope" },
        ...input.targetRefs.map((targetRef) => ({ from: input.taskId, to: targetRef, type: "requires_evidence" })),
        ...(dependencyOverrides.get(input.taskId) ?? []).map((dependencyRef) => ({
          from: input.taskId,
          to: dependencyRef,
          type: "depends_on"
        }))
      ];
      if (input.parentTaskId) {
        taskEdges.push({ from: input.parentTaskId, to: input.taskId, type: "decomposes_to" });
      }
      return taskEdges;
    });
    this.upsertDelta({ sourceEventIds, nodes, edges });
    return nodes;
  }

  plannerVersionSnapshot(): Record<string, number> {
    return Object.fromEntries(this.readNodes({ graphKind: "task", limit: 5000 })
      .map((node) => [node.id, nodeVersion(node)]));
  }

  validatePlannerDecision(decision: PlannerDecision): void {
    if (decision.decision !== "apply_commands") {
      return;
    }
    const commands = decision.commands ?? [];
    const existingNodes = this.readNodes({ graphKind: "task", limit: 5000 });
    const existingById = new Map(existingNodes.map((node) => [node.id, node]));
    const existingTaskIds = new Set(existingNodes.filter((node) => node.type === "Task").map((node) => node.id));
    const newTaskIds = new Set<string>();
    const dependencyOverrides = new Map<string, string[]>();

    for (const command of commands) {
      if (command.kind !== "create_tasks") {
        continue;
      }
      for (const task of command.tasks) {
        if (existingById.has(task.id) || newTaskIds.has(task.id)) {
          throw new GraphValidationError(`Task ${task.id} already exists`);
        }
        newTaskIds.add(task.id);
        dependencyOverrides.set(task.id, [...new Set(task.dependsOnTaskRefs ?? [])]);
      }
    }

    for (const command of commands) {
      if (command.kind === "create_tasks") {
        continue;
      }
      if (command.kind === "set_node_status") {
        if (!existingById.has(command.nodeId) && !newTaskIds.has(command.nodeId)) {
          throw new GraphValidationError(`Node ${command.nodeId} does not exist`);
        }
        continue;
      }
      if (!existingTaskIds.has(command.taskId) && !newTaskIds.has(command.taskId)) {
        throw new GraphValidationError(`Task ${command.taskId} does not exist`);
      }
      if (command.kind === "replace_dependencies") {
        dependencyOverrides.set(command.taskId, [...new Set(command.dependencyTaskIds)]);
      }
    }

    const availableTaskIds = new Set([...existingTaskIds, ...newTaskIds]);
    for (const [taskId, dependencies] of dependencyOverrides) {
      if (dependencies.includes(taskId)) {
        throw new GraphValidationError(`Task ${taskId} cannot depend on itself`);
      }
      for (const dependencyTaskId of dependencies) {
        if (!availableTaskIds.has(dependencyTaskId)) {
          throw new GraphValidationError(`Dependency task ${dependencyTaskId} does not exist`);
        }
      }
    }
    this.assertDependencyGraphAcyclic(dependencyOverrides);
  }

  applyPlannerDecision(input: {
    createTasks: TaskCreateInput[];
    taskCommands: PlannerTaskBatchCommand[];
    nodeStatusCommands: PlannerNodeStatusBatchCommand[];
    sourceEventIds: string[];
  }): AppliedPlannerDecision {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.applyPlannerDecisionInTransaction(input);
      this.database.exec("COMMIT");
      if (result.delta.nodes.length > 0 || result.delta.edges.length > 0) {
        appendDeltaLog(this.deltaLogPath, result.delta);
      }
      return result.applied;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private applyPlannerDecisionInTransaction(input: {
    createTasks: TaskCreateInput[];
    taskCommands: PlannerTaskBatchCommand[];
    nodeStatusCommands: PlannerNodeStatusBatchCommand[];
    sourceEventIds: string[];
  }): { applied: AppliedPlannerDecision; delta: GraphDelta } {
    if (input.createTasks.length === 0 && input.taskCommands.length === 0 && input.nodeStatusCommands.length === 0) {
      return {
        applied: { createdNodes: [], taskCommands: [], nodeStatusCommands: [] },
        delta: { sourceEventIds: input.sourceEventIds, nodes: [], edges: [] }
      };
    }
    const existingTaskNodes = this.readNodes({ graphKind: "task", limit: 5000 });
    const existingById = new Map(existingTaskNodes.map((node) => [node.id, node]));
    const existingTaskIds = new Set(existingTaskNodes.filter((node) => node.type === "Task").map((node) => node.id));
    const newTaskIds = new Set<string>();
    for (const task of input.createTasks) {
      if (existingById.has(task.taskId) || newTaskIds.has(task.taskId)) {
        throw new GraphValidationError(`Task ${task.taskId} already exists`);
      }
      newTaskIds.add(task.taskId);
    }
    const conflicts: PlannerDecisionConflictItem[] = [];
    const collectConflict = (node: GraphNode, expectedVersion: number): void => {
      const currentVersion = nodeVersion(node);
      if (currentVersion === expectedVersion) {
        return;
      }
      conflicts.push({
        nodeId: node.id,
        expectedVersion,
        currentVersion,
        type: node.type,
        label: node.label,
        status: stringProperty(node.properties.status)
      });
    };
    for (const command of input.taskCommands) {
      const node = existingById.get(command.taskId);
      if (!node || node.type !== "Task") {
        if (!newTaskIds.has(command.taskId)) {
          throw new GraphValidationError(`Task ${command.taskId} does not exist`);
        }
        continue;
      }
      if (command.expectedVersion === undefined) {
        throw new GraphValidationError(`Runtime version snapshot missing for ${command.taskId}`);
      }
      collectConflict(node, command.expectedVersion);
    }
    for (const command of input.nodeStatusCommands) {
      const node = existingById.get(command.nodeId);
      if (!node) {
        if (!newTaskIds.has(command.nodeId)) {
          throw new GraphValidationError(`Node ${command.nodeId} does not exist`);
        }
        continue;
      }
      if (command.expectedVersion === undefined) {
        throw new GraphValidationError(`Runtime version snapshot missing for ${command.nodeId}`);
      }
      collectConflict(node, command.expectedVersion);
    }
    if (conflicts.length > 0) {
      throw new PlannerDecisionConflict(dedupeConflictItems(conflicts));
    }

    const createdNodes = input.createTasks.map((task) => ({
      id: task.taskId,
      graphKind: "task" as const,
      type: "Task",
      label: task.goal,
      properties: {
        status: "open",
        version: 1,
        targetRefs: task.targetRefs,
        scopeRef: task.scopeRef,
        constraints: task.constraints,
        successCriteria: task.successCriteria,
        parentTaskId: task.parentTaskId,
        parallelGroup: task.parallelGroup,
        budget: task.budget,
        priority: task.priority
      },
      evidenceRefs: input.sourceEventIds
    }));
    const workingById = new Map<string, GraphNode>([
      ...existingById.entries(),
      ...createdNodes.map((node) => [node.id, node] as const)
    ]);
    const mutatedExistingIds = new Set<string>();
    const sourceEventIdsByNode = new Map<string, string[]>();
    const plannerReasonsByNode = new Map<string, string[]>();
    const dependencyOverrides = new Map<string, string[]>();
    for (const task of input.createTasks) {
      dependencyOverrides.set(task.taskId, [...new Set(task.dependsOnTaskRefs ?? [])]);
    }
    const recordMutation = (nodeId: string, sourceEventIds: string[], reason?: string): void => {
      sourceEventIdsByNode.set(nodeId, mergeStrings(sourceEventIdsByNode.get(nodeId) ?? [], sourceEventIds));
      if (reason?.trim()) {
        plannerReasonsByNode.set(nodeId, mergeStrings(plannerReasonsByNode.get(nodeId) ?? [], [reason]));
      }
      if (existingById.has(nodeId)) {
        mutatedExistingIds.add(nodeId);
      }
    };
    for (const command of input.taskCommands) {
      const current = workingById.get(command.taskId);
      if (!current || current.type !== "Task") {
        throw new GraphValidationError(`Task ${command.taskId} does not exist`);
      }
      recordMutation(command.taskId, command.sourceEventIds ?? [], command.reason);
      if (command.kind === "patch_task") {
        workingById.set(command.taskId, applyPlannerTaskPatch(current, command.patch, command.reason));
      } else if (command.kind === "set_task_status") {
        workingById.set(command.taskId, {
          ...current,
          properties: {
            ...withoutTaskDependencyProperty(current.properties),
            status: command.status,
            ...(command.reason ? { plannerReason: command.reason } : {})
          }
        });
      } else {
        const dependencyTaskIds = [...new Set(command.dependencyTaskIds)];
        if (dependencyTaskIds.includes(command.taskId)) {
          throw new GraphValidationError(`Task ${command.taskId} cannot depend on itself`);
        }
        dependencyOverrides.set(command.taskId, dependencyTaskIds);
      }
    }
    for (const command of input.nodeStatusCommands) {
      const current = workingById.get(command.nodeId);
      if (!current) {
        throw new GraphValidationError(`Node ${command.nodeId} does not exist`);
      }
      recordMutation(command.nodeId, command.sourceEventIds ?? [], command.reason);
      const normalizedStatus = current.type === "Goal" && command.status === "achieved" ? "completed" : command.status;
      workingById.set(command.nodeId, {
        ...current,
        properties: {
          ...current.properties,
          status: normalizedStatus,
          ...(command.reason ? { plannerReason: command.reason } : {})
        }
      });
    }

    const availableTaskIds = new Set([...existingTaskIds, ...newTaskIds]);
    for (const [taskId, dependencies] of dependencyOverrides) {
      if (dependencies.includes(taskId)) {
        throw new GraphValidationError(`Task ${taskId} cannot depend on itself`);
      }
      for (const dependencyTaskId of dependencies) {
        if (!availableTaskIds.has(dependencyTaskId)) {
          throw new GraphValidationError(`Dependency task ${dependencyTaskId} does not exist`);
        }
      }
    }
    this.assertDependencyGraphAcyclic(dependencyOverrides);

    const finalNodes = [...new Set([...newTaskIds, ...mutatedExistingIds])].map((nodeId) => {
      const node = workingById.get(nodeId)!;
      const plannerReasons = plannerReasonsByNode.get(nodeId) ?? [];
      const existing = existingById.get(nodeId);
      return {
        ...node,
        properties: {
          ...(node.type === "Task" ? withoutTaskDependencyProperty(node.properties) : node.properties),
          ...(plannerReasons.length > 0 ? { plannerReason: plannerReasons.join("；") } : {}),
          version: existing ? nodeVersion(existing) + 1 : 1
        },
        evidenceRefs: mergeStrings(node.evidenceRefs ?? [], sourceEventIdsByNode.get(nodeId) ?? input.sourceEventIds)
      };
    });
    const finalById = new Map(finalNodes.map((node) => [node.id, node]));
    const creationEdges: GraphEdge[] = input.createTasks.flatMap((task) => [
      { from: task.taskId, to: task.scopeRef, type: "within_scope", evidenceRefs: input.sourceEventIds },
      ...task.targetRefs.map((targetRef) => ({ from: task.taskId, to: targetRef, type: "requires_evidence", evidenceRefs: input.sourceEventIds })),
      ...(task.parentTaskId ? [{ from: task.parentTaskId, to: task.taskId, type: "decomposes_to", evidenceRefs: input.sourceEventIds }] : [])
    ]);
    const dependencyEdges = [...dependencyOverrides.entries()].flatMap(([taskId, dependencies]) => (
      dependencies.map((dependencyTaskId) => ({
        from: taskId,
        to: dependencyTaskId,
        type: "depends_on",
        evidenceRefs: input.sourceEventIds
      }))
    ));
    const delta: GraphDelta = {
      sourceEventIds: input.sourceEventIds,
      nodes: finalNodes,
      edges: [...creationEdges, ...dependencyEdges]
    };
    validateGraphDelta(delta);
    this.applyDeltaInTransaction(
      delta,
      [...dependencyOverrides.keys()]
        .filter((taskId) => existingTaskIds.has(taskId))
        .map((taskId) => ({ from: taskId, type: "depends_on" }))
    );
    return {
      applied: {
        createdNodes: createdNodes.map((node) => finalById.get(node.id) ?? node),
        taskCommands: input.taskCommands.map((command) => ({
          commandIndex: command.commandIndex,
          kind: command.kind,
          taskId: command.taskId,
          node: finalById.get(command.taskId) ?? workingById.get(command.taskId)!
        })),
        nodeStatusCommands: input.nodeStatusCommands.map((command) => ({
          commandIndex: command.commandIndex,
          node: finalById.get(command.nodeId) ?? workingById.get(command.nodeId)!
        }))
      },
      delta
    };
  }

  markTaskStatus(input: {
    taskId: string;
    status: string;
    sourceEventIds?: string[];
    properties?: Record<string, unknown>;
  }): void {
    const task = this.getTaskNode(input.taskId);
    if (!task) {
      return;
    }
    const sourceEventIds = input.sourceEventIds ?? [];
    const nextTask: GraphNode = {
      ...task,
      properties: {
        ...withoutTaskDependencyProperty(task.properties),
        ...(input.properties ?? {}),
        status: input.status,
        version: taskVersion(task),
        runtimeVersion: taskRuntimeVersion(task) + 1
      },
      evidenceRefs: mergeStrings(task.evidenceRefs ?? [], sourceEventIds)
    };
    this.upsertDelta({ sourceEventIds, nodes: [nextTask], edges: [] });
  }

  updateTaskResult(input: {
    taskEnvelope: TaskEnvelope;
    taskResult: TaskResult;
    sourceEventIds: string[];
  }): GraphDelta {
    const task = this.requireTaskNode(input.taskEnvelope.taskId);
    const dependsOnTaskRefs = input.taskEnvelope.dependsOnTaskRefs ?? this.taskDependencyRefs(input.taskEnvelope.taskId);
    const nextTask: GraphNode = {
      ...task,
      label: input.taskEnvelope.goal,
      properties: {
        ...withoutTaskDependencyProperty(task.properties),
        status: input.taskResult.status,
        targetRefs: input.taskEnvelope.targetRefs,
        scopeRef: input.taskEnvelope.scopeRef,
        constraints: input.taskEnvelope.constraints,
        successCriteria: input.taskEnvelope.successCriteria,
        parentTaskId: input.taskEnvelope.parentTaskId,
        parallelGroup: input.taskEnvelope.parallelGroup,
        budget: input.taskEnvelope.budget,
        resultSummary: input.taskResult.summary,
        evidenceRefs: mergeStrings(stringArray(task.properties.evidenceRefs), input.taskResult.evidenceRefs),
        artifactRefs: mergeStrings(stringArray(task.properties.artifactRefs), input.taskResult.artifactRefs),
        blockerReason: input.taskResult.blockerReason,
        suggestedNextGoal: input.taskResult.suggestedNextGoal,
        checkpointReason: input.taskResult.checkpointReason,
        checkpointed: input.taskResult.status === "partial" && Boolean(input.taskResult.checkpointReason),
        retryable: input.taskResult.retryable,
        attempt: input.taskResult.attempt,
        resumeCursor: input.taskResult.resumeCursor,
        lastEventId: input.taskResult.lastEventId,
        version: taskVersion(task),
        runtimeVersion: taskRuntimeVersion(task) + 1
      },
      evidenceRefs: mergeStrings(task.evidenceRefs ?? [], input.sourceEventIds)
    };
    const delta: GraphDelta = {
      sourceEventIds: input.sourceEventIds,
      nodes: [nextTask],
      edges: [
        { from: input.taskEnvelope.taskId, to: input.taskEnvelope.scopeRef, type: "within_scope", evidenceRefs: input.sourceEventIds },
        ...input.taskEnvelope.targetRefs.map((targetRef) => ({
          from: input.taskEnvelope.taskId,
          to: targetRef,
          type: "requires_evidence",
          evidenceRefs: input.sourceEventIds
        })),
        ...dependsOnTaskRefs.map((dependencyRef) => ({
          from: input.taskEnvelope.taskId,
          to: dependencyRef,
          type: "depends_on",
          evidenceRefs: input.sourceEventIds
        }))
      ]
    };
    this.applyDelta(delta, [
      { from: input.taskEnvelope.taskId, type: "within_scope" },
      { from: input.taskEnvelope.taskId, type: "requires_evidence" },
      { from: input.taskEnvelope.taskId, type: "depends_on" }
    ]);
    return delta;
  }

  patchTask(input: {
    taskId: string;
    patch: PlannerTaskPatch;
    expectedVersion?: number;
    sourceEventIds?: string[];
    reason?: string;
  }): GraphNode {
    const task = this.requireTaskNode(input.taskId);
    assertExpectedVersion(task, input.expectedVersion);
    const patchedTask = applyPlannerTaskPatch(task, input.patch, input.reason);
    const nextTask: GraphNode = {
      ...patchedTask,
      properties: {
        ...patchedTask.properties,
        version: taskVersion(task) + 1
      },
      evidenceRefs: mergeStrings(task.evidenceRefs ?? [], input.sourceEventIds ?? [])
    };
    this.upsertDelta({ sourceEventIds: input.sourceEventIds ?? [], nodes: [nextTask], edges: [] });
    return nextTask;
  }

  setTaskStatus(input: {
    taskId: string;
    status: TaskGraphStatus;
    expectedVersion?: number;
    sourceEventIds?: string[];
    reason?: string;
  }): GraphNode {
    const task = this.requireTaskNode(input.taskId);
    assertExpectedVersion(task, input.expectedVersion);
    return this.upsertTaskNode(task, {
      status: input.status,
      ...(input.reason ? { plannerReason: input.reason } : {})
    }, input.sourceEventIds ?? []);
  }

  setNodeStatus(input: {
    nodeId: string;
    status: string;
    expectedVersion?: number;
    sourceEventIds?: string[];
    reason?: string;
  }): GraphNode {
    const node = this.readNodes({ focusNodeIds: [input.nodeId], limit: 1 })[0];
    if (!node) {
      throw new GraphValidationError(`Node ${input.nodeId} does not exist`);
    }
    assertExpectedVersion(node, input.expectedVersion);
    const normalizedStatus = node.type === "Goal" && input.status === "achieved"
      ? "completed"
      : input.status;
    const nextNode: GraphNode = {
      ...node,
      properties: {
        ...node.properties,
        status: normalizedStatus,
        ...(input.reason ? { plannerReason: input.reason } : {}),
        version: nodeVersion(node) + 1
      },
      evidenceRefs: mergeStrings(node.evidenceRefs ?? [], input.sourceEventIds ?? [])
    };
    this.upsertDelta({ sourceEventIds: input.sourceEventIds ?? [], nodes: [nextNode], edges: [] });
    return nextNode;
  }

  replaceTaskDependencies(input: {
    taskId: string;
    dependencyTaskIds: string[];
    expectedVersion?: number;
    sourceEventIds?: string[];
    reason?: string;
  }): GraphNode {
    const task = this.requireTaskNode(input.taskId);
    assertExpectedVersion(task, input.expectedVersion);
    const dependencyTaskIds = [...new Set(input.dependencyTaskIds)];
    if (dependencyTaskIds.includes(input.taskId)) {
      throw new GraphValidationError(`Task ${input.taskId} cannot depend on itself`);
    }
    for (const dependencyTaskId of dependencyTaskIds) {
      this.requireTaskNode(dependencyTaskId);
    }
    this.assertNoDependencyCycle(input.taskId, dependencyTaskIds);
    const nextTask: GraphNode = {
      ...task,
      properties: {
        ...withoutTaskDependencyProperty(task.properties),
        ...(input.reason ? { plannerReason: input.reason } : {}),
        version: taskVersion(task) + 1
      },
      evidenceRefs: mergeStrings(task.evidenceRefs ?? [], input.sourceEventIds ?? [])
    };
    const edges = dependencyTaskIds.map((dependencyTaskId) => ({
      from: input.taskId,
      to: dependencyTaskId,
      type: "depends_on"
    }));
    this.applyDelta(
      { sourceEventIds: input.sourceEventIds ?? [], nodes: [nextTask], edges },
      [{ from: input.taskId, type: "depends_on" }]
    );
    return nextTask;
  }

  applyTaskCommandBatch(commands: PlannerTaskBatchCommand[]): AppliedPlannerTaskBatchCommand[] {
    if (commands.length === 0) {
      return [];
    }
    const snapshotByTaskId = new Map<string, GraphNode>();
    const workingByTaskId = new Map<string, GraphNode>();
    const sourceEventIdsByTaskId = new Map<string, string[]>();
    const plannerReasonsByTaskId = new Map<string, string[]>();
    const dependencyOverrides = new Map<string, string[]>();
    for (const command of commands) {
      let snapshot = snapshotByTaskId.get(command.taskId);
      if (!snapshot) {
        snapshot = this.requireTaskNode(command.taskId);
        snapshotByTaskId.set(command.taskId, snapshot);
        workingByTaskId.set(command.taskId, snapshot);
      }
      assertExpectedVersion(snapshot, command.expectedVersion);
      sourceEventIdsByTaskId.set(command.taskId, mergeStrings(
        sourceEventIdsByTaskId.get(command.taskId) ?? [],
        command.sourceEventIds ?? []
      ));
      if (command.reason?.trim()) {
        plannerReasonsByTaskId.set(command.taskId, mergeStrings(
          plannerReasonsByTaskId.get(command.taskId) ?? [],
          [command.reason]
        ));
      }
      const current = workingByTaskId.get(command.taskId) ?? snapshot;
      if (command.kind === "patch_task") {
        workingByTaskId.set(command.taskId, applyPlannerTaskPatch(current, command.patch, command.reason));
        continue;
      }
      if (command.kind === "set_task_status") {
        workingByTaskId.set(command.taskId, {
          ...current,
          properties: {
            ...withoutTaskDependencyProperty(current.properties),
            status: command.status,
            ...(command.reason ? { plannerReason: command.reason } : {})
          }
        });
        continue;
      }
      const dependencyTaskIds = [...new Set(command.dependencyTaskIds)];
      if (dependencyTaskIds.includes(command.taskId)) {
        throw new GraphValidationError(`Task ${command.taskId} cannot depend on itself`);
      }
      for (const dependencyTaskId of dependencyTaskIds) {
        this.requireTaskNode(dependencyTaskId);
      }
      dependencyOverrides.set(command.taskId, dependencyTaskIds);
      workingByTaskId.set(command.taskId, {
        ...current,
        properties: {
          ...withoutTaskDependencyProperty(current.properties),
          ...(command.reason ? { plannerReason: command.reason } : {})
        }
      });
    }
    if (dependencyOverrides.size > 0) {
      this.assertDependencyGraphAcyclic(dependencyOverrides);
    }
    const nextNodes = [...workingByTaskId.entries()].map(([taskId, workingTask]) => {
      const snapshot = snapshotByTaskId.get(taskId) ?? workingTask;
      const plannerReasons = plannerReasonsByTaskId.get(taskId) ?? [];
      return {
        ...workingTask,
        properties: {
          ...withoutTaskDependencyProperty(workingTask.properties),
          ...(plannerReasons.length > 0 ? { plannerReason: plannerReasons.join("；") } : {}),
          version: taskVersion(snapshot) + 1
        },
        evidenceRefs: mergeStrings(snapshot.evidenceRefs ?? [], sourceEventIdsByTaskId.get(taskId) ?? [])
      };
    });
    const nodeByTaskId = new Map(nextNodes.map((node) => [node.id, node]));
    const edges: GraphEdge[] = [...dependencyOverrides.entries()].flatMap(([taskId, dependencyTaskIds]) =>
      dependencyTaskIds.map((dependencyTaskId) => ({
        from: taskId,
        to: dependencyTaskId,
        type: "depends_on"
      }))
    );
    this.applyDelta(
      {
        sourceEventIds: mergeStrings([], commands.flatMap((command) => command.sourceEventIds ?? [])),
        nodes: nextNodes,
        edges
      },
      [...dependencyOverrides.keys()].map((taskId) => ({ from: taskId, type: "depends_on" }))
    );
    return commands.map((command) => ({
      commandIndex: command.commandIndex,
      kind: command.kind,
      taskId: command.taskId,
      node: nodeByTaskId.get(command.taskId) ?? this.requireTaskNode(command.taskId)
    }));
  }

  getTaskNode(taskId: string): GraphNode | undefined {
    return this.readNodes({ focusNodeIds: [taskId], limit: 1 })
      .find((node) => node.graphKind === "task" && node.type === "Task");
  }

  getTaskEnvelope(taskId: string): TaskEnvelope | undefined {
    const task = this.getTaskNode(taskId);
    return task ? taskNodeToEnvelope(task, this.taskDependencyRefs(taskId)) : undefined;
  }

  listReadyTasks(limit = 4): TaskEnvelope[] {
    const taskNodes = this.readNodes({ graphKind: "task", limit: 1000 })
      .filter((node) => node.type === "Task");
    const taskById = new Map(taskNodes.map((node) => [node.id, node]));
    const taskIds = taskNodes.map((node) => node.id);
    const taskDependencyEdges = this.readEdgesForNodes(taskIds, 5000)
      .filter((edge) => edge.type === "depends_on" && taskById.has(edge.from) && taskById.has(edge.to));
    const readyTasks = taskNodes
      .filter((task) => isRunnableTaskStatus(task.properties.status))
      .filter((task) => taskDependencyEdges
        .filter((edge) => edge.from === task.id)
        .every((edge) => isDependencyOutcomeAvailable(taskById.get(edge.to)?.properties)))
      .sort(compareTaskPriorityThenId)
      .slice(0, limit);
    return readyTasks.map((task) => taskNodeToEnvelope(
      task,
      taskDependencyEdges.filter((edge) => edge.from === task.id).map((edge) => edge.to)
    ));
  }

  private requireTaskNode(taskId: string): GraphNode {
    const task = this.getTaskNode(taskId);
    if (!task) {
      throw new GraphValidationError(`Task ${taskId} does not exist`);
    }
    return task;
  }

  private upsertTaskNode(
    task: GraphNode,
    propertyPatch: Record<string, unknown>,
    sourceEventIds: string[]
  ): GraphNode {
    const nextTask: GraphNode = {
      ...task,
      properties: {
        ...withoutTaskDependencyProperty(task.properties),
        ...propertyPatch,
        version: taskVersion(task) + 1
      },
      evidenceRefs: mergeStrings(task.evidenceRefs ?? [], sourceEventIds)
    };
    this.upsertDelta({ sourceEventIds, nodes: [nextTask], edges: [] });
    return nextTask;
  }

  private taskDependencyRefs(taskId: string): string[] {
    return this.database.prepare(
      "SELECT to_id FROM edges WHERE from_id = ? AND type = 'depends_on' ORDER BY to_id"
    ).all(taskId).map((row) => (row as { to_id: string }).to_id);
  }

  private assertNoDependencyCycle(taskId: string, replacementDependencies: string[]): void {
    this.assertDependencyGraphAcyclic(new Map([[taskId, replacementDependencies]]));
  }

  private assertDependencyGraphAcyclic(dependencyOverrides: Map<string, string[]>): void {
    const rows = this.database.prepare(
      "SELECT from_id, to_id FROM edges WHERE type = 'depends_on'"
    ).all() as Array<{ from_id: string; to_id: string }>;
    const dependencyMap = new Map<string, Set<string>>();
    for (const row of rows) {
      if (dependencyOverrides.has(row.from_id)) {
        continue;
      }
      const dependencies = dependencyMap.get(row.from_id) ?? new Set<string>();
      dependencies.add(row.to_id);
      dependencyMap.set(row.from_id, dependencies);
    }
    for (const [taskId, dependencies] of dependencyOverrides) {
      dependencyMap.set(taskId, new Set(dependencies));
    }
    const visited = new Set<string>();
    const activeIndex = new Map<string, number>();
    const path: string[] = [];
    const visit = (currentTaskId: string): string[] | undefined => {
      const cycleStart = activeIndex.get(currentTaskId);
      if (cycleStart !== undefined) {
        return [...path.slice(cycleStart), currentTaskId];
      }
      if (visited.has(currentTaskId)) {
        return undefined;
      }
      activeIndex.set(currentTaskId, path.length);
      path.push(currentTaskId);
      for (const dependencyTaskId of [...(dependencyMap.get(currentTaskId) ?? [])].sort()) {
        const cycle = visit(dependencyTaskId);
        if (cycle) {
          return cycle;
        }
      }
      path.pop();
      activeIndex.delete(currentTaskId);
      visited.add(currentTaskId);
      return undefined;
    };
    for (const taskId of [...dependencyMap.keys()].sort()) {
      const cycle = visit(taskId);
      if (cycle) {
        throw new GraphValidationError(`Dependency graph would contain a cycle: ${cycle.join(" -> ")}`);
      }
    }
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        graph_kind TEXT NOT NULL,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        properties_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        properties_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS graph_deltas (
        id TEXT PRIMARY KEY,
        source_event_ids_json TEXT NOT NULL,
        delta_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_states (
        task_id TEXT PRIMARY KEY,
        committed_seq INTEGER NOT NULL DEFAULT 0,
        desired_seq INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 0,
        active_generation INTEGER,
        priority INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_kind_type ON nodes(graph_kind, type);
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
    `);
    this.database.exec(`
      UPDATE nodes SET graph_kind = 'task', type = 'Task' WHERE id LIKE 'task:%' AND type <> 'Task';
      UPDATE nodes SET graph_kind = 'task', type = 'Goal' WHERE id LIKE 'goal:%' AND type <> 'Goal';
      UPDATE nodes SET graph_kind = 'task', type = 'Scope' WHERE id LIKE 'scope:%' AND type <> 'Scope';
      UPDATE nodes SET graph_kind = 'task', type = 'Milestone' WHERE id LIKE 'milestone:%' AND type <> 'Milestone';
      UPDATE nodes SET graph_kind = 'task', type = 'Blocker' WHERE id LIKE 'blocker:%' AND type <> 'Blocker';
    `);
  }

  private queryPlannerView(limit: number): GraphSnapshot {
    const taskNodes = this.readNodes({ graphKind: "task", limit });
    const reasoningNodes = this.readNodes({ graphKind: "reasoning", limit: Math.floor(limit / 2) });
    const operationNodes = this.readNodes({ graphKind: "operation", limit: Math.floor(limit / 2) });
    const rawNodes = dedupeNodes([...taskNodes, ...reasoningNodes, ...operationNodes]);
    const edges = this.readEdgesForNodes(rawNodes.map((node) => node.id), limit * 2);
    const nodes = withDerivedTaskDependencies(rawNodes, edges);
    return {
      view: "planner",
      nodes,
      edges,
      summary: summarize(nodes, edges)
    };
  }

  private queryByNodeTypes(view: GraphView, nodeTypes: string[], limit: number): GraphSnapshot {
    const placeholders = nodeTypes.map(() => "?").join(",");
    const rows = this.database.prepare(`
      SELECT * FROM nodes WHERE type IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?
    `).all(...nodeTypes, limit) as StoredNodeRow[];
    const nodes = rows.map(rowToNode);
    const edges = this.readEdgesForNodes(nodes.map((node) => node.id), limit);
    return {
      view,
      nodes,
      edges,
      summary: summarize(nodes, edges)
    };
  }

  private readNodes(input: { graphKind?: GraphKind; focusNodeIds?: string[]; limit: number }): GraphNode[] {
    if (input.focusNodeIds && input.focusNodeIds.length > 0) {
      const placeholders = input.focusNodeIds.map(() => "?").join(",");
      const graphKindClause = input.graphKind ? " AND graph_kind = ?" : "";
      const parameters = input.graphKind
        ? [...input.focusNodeIds, input.graphKind, input.limit]
        : [...input.focusNodeIds, input.limit];
      const rows = this.database.prepare(`
        SELECT * FROM nodes WHERE id IN (${placeholders})${graphKindClause} LIMIT ?
      `).all(...parameters) as StoredNodeRow[];
      return rows.map(rowToNode);
    }
    if (input.graphKind) {
      const rows = this.database.prepare(`
        SELECT * FROM nodes WHERE graph_kind = ? ORDER BY updated_at DESC LIMIT ?
      `).all(input.graphKind, input.limit) as StoredNodeRow[];
      return rows.map(rowToNode);
    }
    const rows = this.database.prepare(`
      SELECT * FROM nodes ORDER BY updated_at DESC LIMIT ?
    `).all(input.limit) as StoredNodeRow[];
    return rows.map(rowToNode);
  }

  private readEdgesForNodes(nodeIds: string[], limit: number): GraphEdge[] {
    if (nodeIds.length === 0) {
      return [];
    }
    const placeholders = nodeIds.map(() => "?").join(",");
    const rows = this.database.prepare(`
      SELECT * FROM edges
      WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})
      ORDER BY updated_at DESC LIMIT ?
    `).all(...nodeIds, ...nodeIds, limit) as StoredEdgeRow[];
    return rows.map(rowToEdge);
  }
}

function buildEdgeAdjacency(edges: GraphEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.from, dedupeStringValues([...(adjacency.get(edge.from) ?? []), edge.to]));
    adjacency.set(edge.to, dedupeStringValues([...(adjacency.get(edge.to) ?? []), edge.from]));
  }
  return adjacency;
}

function projectionNodeSearchText(node: GraphNode): string {
  return normalizeProjectionToken(`${node.id} ${node.label} ${JSON.stringify(node.properties)}`);
}

function normalizeProjectionToken(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function compareProjectionSeedNodes(left: GraphNode, right: GraphNode): number {
  return projectionNodePriority(right) - projectionNodePriority(left) || left.id.localeCompare(right.id);
}

function projectionNodePriority(node: GraphNode): number {
  const typeScore: Record<string, number> = {
    Exploit: 100,
    Vulnerability: 90,
    Hypothesis: 80,
    Session: 75,
    Credential: 70,
    Evidence: 65,
    WebEndpoint: 60,
    Service: 50,
    Host: 40
  };
  return typeScore[node.type] ?? 20;
}

function compareProjectionEdges(left: GraphEdge, right: GraphEdge): number {
  const priority: Record<string, number> = {
    confirms: 100,
    exploited_by: 95,
    supports: 90,
    contradicts: 85,
    observed_on: 80,
    affects: 75,
    creates_session: 70,
    authenticates_to: 65,
    exposes_endpoint: 60,
    runs_service: 55,
    has_port: 50,
    depends_on: 45,
    within_scope: 40
  };
  return (priority[right.type] ?? 20) - (priority[left.type] ?? 20)
    || left.from.localeCompare(right.from)
    || left.to.localeCompare(right.to);
}

type StoredNodeRow = {
  id: string;
  graph_kind: GraphKind;
  type: string;
  label: string;
  properties_json: string;
  evidence_refs_json: string;
};

type StoredEdgeRow = {
  from_id: string;
  to_id: string;
  type: string;
  properties_json: string;
  evidence_refs_json: string;
};

function validateGraphDelta(delta: GraphDelta): void {
  for (const node of delta.nodes) {
    validateGraphNodeCategory(node);
    validateReservedNodeIdentity(node);
    const evidenceRefs = node.evidenceRefs ?? [];
    if (node.type === "Vulnerability" && evidenceRefs.length === 0) {
      throw new GraphValidationError(`Vulnerability node ${node.id} must include evidenceRefs`);
    }
    if (node.type === "Exploit" && node.properties.status === "succeeded" && evidenceRefs.length === 0) {
      throw new GraphValidationError(`Succeeded Exploit node ${node.id} must include evidenceRefs`);
    }
  }
}

function validateGraphNodeCategory(node: GraphNode): void {
  const expectedGraphKind = expectedGraphKindForNodeType(node.type);
  if (expectedGraphKind && node.graphKind !== expectedGraphKind) {
    throw new GraphValidationError(
      `Graph node type ${node.type} requires graphKind=${expectedGraphKind}, received ${node.graphKind} for ${node.id}`
    );
  }
}

function expectedGraphKindForNodeType(type: string): GraphKind | undefined {
  if (["Evidence", "Hypothesis", "Vulnerability", "Exploit"].includes(type)) {
    return "reasoning";
  }
  if (["Host", "Port", "Service", "WebEndpoint", "Parameter", "Credential", "Session", "File", "Process"].includes(type)) {
    return "operation";
  }
  if (["Goal", "Task", "Milestone", "Blocker", "Scope"].includes(type)) {
    return "task";
  }
  return undefined;
}

function validateReservedNodeIdentity(node: GraphNode): void {
  const reservedPrefixes: Array<{ prefix: string; graphKind: GraphKind; type: string }> = [
    { prefix: "task:", graphKind: "task", type: "Task" },
    { prefix: "goal:", graphKind: "task", type: "Goal" },
    { prefix: "scope:", graphKind: "task", type: "Scope" },
    { prefix: "milestone:", graphKind: "task", type: "Milestone" },
    { prefix: "blocker:", graphKind: "task", type: "Blocker" }
  ];
  const reservation = reservedPrefixes.find((candidate) => node.id.startsWith(candidate.prefix));
  if (reservation && (node.graphKind !== reservation.graphKind || node.type !== reservation.type)) {
    throw new GraphValidationError(
      `Reserved node id ${node.id} requires ${reservation.graphKind}/${reservation.type}, received ${node.graphKind}/${node.type}`
    );
  }
}

function rowToNode(row: StoredNodeRow): GraphNode {
  return {
    id: row.id,
    graphKind: row.graph_kind,
    type: row.type,
    label: row.label,
    properties: JSON.parse(row.properties_json) as Record<string, unknown>,
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[]
  };
}

function rowToEdge(row: StoredEdgeRow): GraphEdge {
  return {
    from: row.from_id,
    to: row.to_id,
    type: row.type,
    properties: JSON.parse(row.properties_json) as Record<string, unknown>,
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[]
  };
}

function edgeIdFor(edge: GraphEdge): string {
  return `${edge.from}::${edge.type}::${edge.to}`;
}

function summarize(nodes: GraphNode[], edges: GraphEdge[]): Record<string, unknown> {
  const nodeCounts: Record<string, number> = {};
  for (const node of nodes) {
    const key = `${node.graphKind}:${node.type}`;
    nodeCounts[key] = (nodeCounts[key] ?? 0) + 1;
  }
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodeCounts
  };
}

function buildTaskLedger(taskNodes: GraphNode[]): PlannerTaskLedgerItem[] {
  return taskNodes
    .filter((node) => node.type === "Task")
    .map((node) => ({
      taskId: node.id,
      status: stringProperty(node.properties.status) ?? "open",
      goal: compactPlannerText(node.label, 320) ?? node.label,
      resultSummary: compactPlannerText(stringProperty(node.properties.resultSummary), 520),
      checkpointReason: compactPlannerText(stringProperty(node.properties.checkpointReason), 240),
      resumeCursor: stringProperty(node.properties.resumeCursor),
      blockerReason: compactPlannerText(stringProperty(node.properties.blockerReason), 240),
      suggestedNextGoal: compactPlannerText(stringProperty(node.properties.suggestedNextGoal), 240),
      retryable: booleanProperty(node.properties.retryable),
      attempt: numberProperty(node.properties.attempt),
      priority: numberProperty(node.properties.priority),
      dependsOnTaskRefs: stringArray(node.properties.dependsOnTaskRefs)
    }))
    .sort(compareLedgerItems);
}

type PlannerDigestContext = {
  relevantIds: Set<string>;
  degreeById: Map<string, number>;
  taskStatusById: Map<string, string>;
};

function createPlannerDigestContext(taskNodes: GraphNode[], edges: GraphEdge[]): PlannerDigestContext {
  const relevantIds = new Set<string>(["goal:root", "scope:root"]);
  const taskStatusById = new Map<string, string>();
  for (const node of taskNodes) {
    if (node.type === "Task") {
      taskStatusById.set(node.id, stringProperty(node.properties.status) ?? "open");
      relevantIds.add(node.id);
      for (const targetRef of stringArray(node.properties.targetRefs)) {
        relevantIds.add(targetRef);
      }
      const scopeRef = stringProperty(node.properties.scopeRef);
      if (scopeRef) {
        relevantIds.add(scopeRef);
      }
    }
    if (node.type === "Goal" || node.type === "Scope" || node.type === "Blocker") {
      relevantIds.add(node.id);
    }
  }
  const degreeById = new Map<string, number>();
  for (const edge of edges) {
    degreeById.set(edge.from, (degreeById.get(edge.from) ?? 0) + 1);
    degreeById.set(edge.to, (degreeById.get(edge.to) ?? 0) + 1);
  }
  return { relevantIds, degreeById, taskStatusById };
}

function topDigestItems(
  nodes: GraphNode[],
  edges: GraphEdge[],
  context: PlannerDigestContext,
  limit: number
): PlannerDigestItem[] {
  return nodes
    .map((node, index) => scoreDigestItem(node, edges, context, index))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
}

function scoreDigestItem(
  node: GraphNode,
  edges: GraphEdge[],
  context: PlannerDigestContext,
  recencyIndex: number
): PlannerDigestItem {
  const reasons: string[] = [];
  let score = 0;
  const degree = context.degreeById.get(node.id) ?? 0;
  const relatedEdges = edges.filter((edge) => edge.from === node.id || edge.to === node.id);
  if (context.relevantIds.has(node.id) || relatedEdges.some((edge) => context.relevantIds.has(edge.from) || context.relevantIds.has(edge.to))) {
    score += 8;
    reasons.push("target_or_task_related");
  }
  const status = stringProperty(node.properties.status);
  const stateScore = scoreStateImportance(node, status);
  if (stateScore > 0) {
    score += stateScore;
    reasons.push(`important_state:${status ?? node.type}`);
  }
  const impactScore = scoreDecisionImpact(node);
  if (impactScore > 0) {
    score += impactScore;
    reasons.push(`decision_impact:${node.type}`);
  }
  const evidenceRefCount = (node.evidenceRefs ?? []).length
    + relatedEdges.reduce((count, edge) => count + (edge.evidenceRefs?.length ?? 0), 0);
  if (evidenceRefCount > 0) {
    score += Math.min(6, evidenceRefCount * 2);
    reasons.push("has_evidence_refs");
  }
  if (containsDecisionKeyword(node)) {
    score += 5;
    reasons.push("decision_keyword");
  }
  if (recencyIndex < 20) {
    score += Math.max(1, 4 - Math.floor(recencyIndex / 5));
    reasons.push("recent");
  }
  if (degree > 0) {
    score += Math.min(4, degree);
    reasons.push("graph_connected");
  }
  return {
    id: node.id,
    graphKind: node.graphKind,
    type: node.type,
    label: node.label,
    status,
    score,
    reasons: [...new Set(reasons)],
    edgeCount: degree,
    evidenceRefCount,
    properties: pickDigestProperties(node)
  };
}

function scoreStateImportance(node: GraphNode, status: string | undefined): number {
  if (node.type === "Blocker") {
    return status === "resolved" || status === "completed" ? 2 : 10;
  }
  if (["confirmed", "succeeded", "valid", "privileged", "authenticated"].includes(status ?? "")) {
    return 10;
  }
  if (["partial", "blocked", "running", "open"].includes(status ?? "")) {
    return 6;
  }
  if (["failed", "invalid", "closed"].includes(status ?? "")) {
    return 3;
  }
  if (node.type === "Vulnerability" || node.type === "Exploit") {
    return 7;
  }
  if (node.type === "Hypothesis") {
    return 5;
  }
  return 0;
}

function scoreDecisionImpact(node: GraphNode): number {
  switch (node.type) {
    case "Vulnerability":
    case "Exploit":
      return 10;
    case "Session":
    case "Credential":
      return 9;
    case "Hypothesis":
      return 7;
    case "WebEndpoint":
    case "Parameter":
      return 6;
    case "Evidence":
      return 5;
    case "Service":
    case "Host":
      return 4;
    default:
      return 0;
  }
}

const DECISION_KEYWORDS = [
  "flag",
  "admin",
  "auth",
  "login",
  "session",
  "credential",
  "password",
  "token",
  "file",
  "path",
  "traversal",
  "upload",
  "shell",
  "rce",
  "cmd",
  "exec",
  "sqli",
  "ssrf",
  "ssti"
];

function containsDecisionKeyword(node: GraphNode): boolean {
  const haystack = `${node.id} ${node.label} ${JSON.stringify(node.properties)}`.toLowerCase();
  return DECISION_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

const DIGEST_PROPERTY_ALLOWLIST = [
  "status",
  "confidence",
  "severity",
  "method",
  "path",
  "route",
  "url",
  "host",
  "hostname",
  "ip",
  "port",
  "scheme",
  "service",
  "technology",
  "parameter",
  "parameterName",
  "name",
  "kind",
  "role",
  "username",
  "scopeRef",
  "targetRefs",
  "successCriteria",
  "checkpointReason",
  "resultSummary"
];

function pickDigestProperties(node: GraphNode): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of DIGEST_PROPERTY_ALLOWLIST) {
    if (node.properties[key] !== undefined) {
      output[key] = compactDigestProperty(node.properties[key], key === "resultSummary" ? 320 : 180);
    }
  }
  return output;
}

function compactDigestProperty(value: unknown, textLimit: number): unknown {
  if (typeof value === "string") {
    return compactPlannerText(value, textLimit);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => typeof item === "string" ? compactPlannerText(item, 120) : item);
  }
  return value;
}

function countTaskStatuses(taskNodes: GraphNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of taskNodes) {
    if (node.type !== "Task") {
      continue;
    }
    const status = stringProperty(node.properties.status) ?? "open";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function compareLedgerItems(left: PlannerTaskLedgerItem, right: PlannerTaskLedgerItem): number {
  const leftRank = taskStatusRank(left.status);
  const rightRank = taskStatusRank(right.status);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  const leftPriority = left.priority ?? 1;
  const rightPriority = right.priority ?? 1;
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  return left.taskId.localeCompare(right.taskId);
}

function taskStatusRank(status: string): number {
  switch (status) {
    case "running": return 0;
    case "partial": return 1;
    case "blocked": return 2;
    case "open": return 3;
    case "failed": return 4;
    case "completed": return 5;
    default: return 6;
  }
}

function stringProperty(value: unknown, fallback?: string): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function compactPlannerText(value: string | undefined, limit: number): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 14))}...[truncated]`;
}

function numberProperty(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanProperty(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function dedupeNodes(nodes: GraphNode[]): GraphNode[] {
  const nodeMap = new Map<string, GraphNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }
  return [...nodeMap.values()];
}

function dedupeStringValues(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function dedupeConflictItems(conflicts: PlannerDecisionConflictItem[]): PlannerDecisionConflictItem[] {
  return [...new Map(conflicts.map((conflict) => [conflict.nodeId, conflict])).values()];
}

function appendDeltaLog(deltaLogPath: string, delta: GraphDelta): void {
  mkdirSync(dirname(deltaLogPath), { recursive: true });
  appendFileSync(deltaLogPath, toJsonLine({ timestamp: new Date().toISOString(), delta }));
}

function taskNodeToEnvelope(node: GraphNode, dependencyTaskIds: string[] = []): TaskEnvelope {
  return {
    taskId: node.id,
    goal: node.label,
    targetRefs: stringArray(node.properties.targetRefs, ["goal:root"]),
    scopeRef: typeof node.properties.scopeRef === "string" ? node.properties.scopeRef : "scope:root",
    constraints: stringArray(node.properties.constraints),
    successCriteria: stringArray(node.properties.successCriteria),
    availableSessionRefs: stringArray(node.properties.availableSessionRefs),
    dependsOnTaskRefs: dependencyTaskIds,
    parentTaskId: typeof node.properties.parentTaskId === "string" ? node.properties.parentTaskId : undefined,
    parallelGroup: typeof node.properties.parallelGroup === "string" ? node.properties.parallelGroup : undefined,
    budget: isRecord(node.properties.budget) ? node.properties.budget as TaskBudget : undefined
  };
}

function withDerivedTaskDependencies(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const dependenciesByTask = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== "depends_on") {
      continue;
    }
    const dependencies = dependenciesByTask.get(edge.from) ?? [];
    dependencies.push(edge.to);
    dependenciesByTask.set(edge.from, dependencies);
  }
  return nodes.map((node) => node.graphKind === "task" && node.type === "Task"
    ? {
        ...node,
        properties: {
          ...withoutTaskDependencyProperty(node.properties),
          dependsOnTaskRefs: [...new Set(dependenciesByTask.get(node.id) ?? [])]
        }
      }
    : node);
}

function withoutTaskDependencyProperty(properties: Record<string, unknown>): Record<string, unknown> {
  const { dependsOnTaskRefs: _ignored, ...rest } = properties;
  return rest;
}

function applyPlannerTaskPatch(task: GraphNode, patch: PlannerTaskPatch, reason: string | undefined): GraphNode {
  return {
    ...task,
    label: patch.goal ?? task.label,
    properties: {
      ...withoutTaskDependencyProperty(task.properties),
      ...(patch.constraints ? { constraints: patch.constraints } : {}),
      ...(patch.successCriteria ? { successCriteria: patch.successCriteria } : {}),
      ...(patch.budget ? { budget: patch.budget } : {}),
      ...(typeof patch.priority === "number" ? { priority: patch.priority } : {}),
      ...(typeof patch.parallelGroup === "string" ? { parallelGroup: patch.parallelGroup } : {}),
      ...(reason ? { plannerReason: reason } : {})
    }
  };
}

function nodeVersion(node: GraphNode): number {
  const version = node.properties.version;
  return typeof version === "number" && Number.isFinite(version) && version >= 1
    ? Math.floor(version)
    : 1;
}

function taskVersion(task: GraphNode): number {
  return nodeVersion(task);
}

function taskRuntimeVersion(task: GraphNode): number {
  const version = task.properties.runtimeVersion;
  return typeof version === "number" && Number.isFinite(version) && version >= 0
    ? Math.floor(version)
    : 0;
}

function assertExpectedVersion(node: GraphNode, expectedVersion: number | undefined): void {
  if (expectedVersion === undefined) {
    return;
  }
  const currentVersion = nodeVersion(node);
  if (currentVersion !== expectedVersion) {
    throw new GraphValidationError(
      `Version conflict for ${node.id}: expected ${expectedVersion}, current ${currentVersion}`
    );
  }
}

function stringArray(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : fallback;
}

function isRunnableTaskStatus(status: unknown): boolean {
  return status === undefined || status === "open";
}

function isDependencyOutcomeAvailable(properties: Record<string, unknown> | undefined): boolean {
  const status = properties?.status;
  if (status === "partial" || status === "completed") {
    return true;
  }
  return status === "archived"
    && typeof properties?.resultSummary === "string"
    && properties.resultSummary.trim().length > 0;
}

function compareTaskPriorityThenId(left: GraphNode, right: GraphNode): number {
  const leftPriority = typeof left.properties.priority === "number" ? left.properties.priority : 1;
  const rightPriority = typeof right.properties.priority === "number" ? right.properties.priority : 1;
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  return left.id.localeCompare(right.id);
}

function mergeStrings(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right].filter((value) => value.trim().length > 0))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
