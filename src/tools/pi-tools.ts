import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { compactExecutionEvents } from "../log-summary.js";
import type { ArtifactStore } from "../stores/artifact-store.js";
import type { ExecutionLog } from "../stores/execution-log.js";
import type { SQLiteGraphStore } from "../stores/graph-store.js";
import type { ArtifactRecord, GraphDelta, GraphView } from "../types.js";

const ReasoningNodeTypeSchema = Type.Union([
  Type.Literal("Evidence"),
  Type.Literal("Hypothesis"),
  Type.Literal("Vulnerability"),
  Type.Literal("Exploit")
]);

const OperationNodeTypeSchema = Type.Union([
  Type.Literal("Host"),
  Type.Literal("Port"),
  Type.Literal("Service"),
  Type.Literal("WebEndpoint"),
  Type.Literal("Parameter"),
  Type.Literal("Credential"),
  Type.Literal("AgentSession"),
  Type.Literal("ShellSession"),
  Type.Literal("Session"),
  Type.Literal("File"),
  Type.Literal("Process")
]);

const TaskNodeTypeSchema = Type.Union([
  Type.Literal("Goal"),
  Type.Literal("Task"),
  Type.Literal("Milestone"),
  Type.Literal("Blocker"),
  Type.Literal("Scope")
]);

const GraphEdgeTypeSchema = Type.Union([
  Type.Literal("supports"),
  Type.Literal("contradicts"),
  Type.Literal("confirms"),
  Type.Literal("promoted_to"),
  Type.Literal("exploited_by"),
  Type.Literal("produces_evidence"),
  Type.Literal("observed_on"),
  Type.Literal("affects"),
  Type.Literal("has_port"),
  Type.Literal("runs_service"),
  Type.Literal("exposes_endpoint"),
  Type.Literal("has_parameter"),
  Type.Literal("authenticates_to"),
  Type.Literal("creates_session"),
  Type.Literal("session_on"),
  Type.Literal("tunnels_to"),
  Type.Literal("proxy_route"),
  Type.Literal("contains_file"),
  Type.Literal("spawns_process"),
  Type.Literal("decomposes_to"),
  Type.Literal("depends_on"),
  Type.Literal("within_scope"),
  Type.Literal("produces_milestone"),
  Type.Literal("blocked_by"),
  Type.Literal("unblocked_by"),
  Type.Literal("requires_evidence")
]);

const ProjectorGraphEdgeTypeSchema = Type.Union([
  Type.Literal("supports"),
  Type.Literal("contradicts"),
  Type.Literal("confirms"),
  Type.Literal("promoted_to"),
  Type.Literal("exploited_by"),
  Type.Literal("produces_evidence"),
  Type.Literal("observed_on"),
  Type.Literal("affects"),
  Type.Literal("has_port"),
  Type.Literal("runs_service"),
  Type.Literal("exposes_endpoint"),
  Type.Literal("has_parameter"),
  Type.Literal("authenticates_to"),
  Type.Literal("creates_session"),
  Type.Literal("session_on"),
  Type.Literal("tunnels_to"),
  Type.Literal("proxy_route"),
  Type.Literal("contains_file"),
  Type.Literal("spawns_process")
]);

const GraphScalarSchema = Type.Union([
  Type.String({ maxLength: 600 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null()
]);

const GraphNestedValueSchema = Type.Union([
  GraphScalarSchema,
  Type.Array(GraphScalarSchema, { maxItems: 32 })
]);

const GraphObjectSchema = Type.Record(
  Type.String({ maxLength: 120 }),
  GraphNestedValueSchema
);

const GraphPropertyValueSchema = Type.Union([
  GraphNestedValueSchema,
  GraphObjectSchema,
  Type.Array(GraphObjectSchema, { maxItems: 32 })
]);

const GraphNodeCommonProperties = {
  id: Type.String({ minLength: 1, maxLength: 256 }),
  label: Type.String({ minLength: 1, maxLength: 500 }),
  properties: Type.Optional(Type.Object({}, { additionalProperties: GraphPropertyValueSchema })),
  evidenceRefs: Type.Optional(Type.Array(Type.String({ maxLength: 32 }), { maxItems: 8 }))
};

const ProjectorGraphNodeCommonProperties = {
  ...GraphNodeCommonProperties,
  id: Type.String({ pattern: "^(existing|new):[1-9][0-9]*$", maxLength: 32 })
};

const GraphNodeSchema = Type.Union([
  Type.Object({
    ...GraphNodeCommonProperties,
    graphKind: Type.Literal("reasoning"),
    type: ReasoningNodeTypeSchema
  }, { additionalProperties: false }),
  Type.Object({
    ...GraphNodeCommonProperties,
    graphKind: Type.Literal("operation"),
    type: OperationNodeTypeSchema
  }, { additionalProperties: false }),
  Type.Object({
    ...GraphNodeCommonProperties,
    graphKind: Type.Literal("task"),
    type: TaskNodeTypeSchema
  }, { additionalProperties: false })
]);

const ProjectorGraphNodeSchema = Type.Union([
  Type.Object({
    ...ProjectorGraphNodeCommonProperties,
    graphKind: Type.Literal("reasoning"),
    type: ReasoningNodeTypeSchema
  }, { additionalProperties: false }),
  Type.Object({
    ...ProjectorGraphNodeCommonProperties,
    graphKind: Type.Literal("operation"),
    type: OperationNodeTypeSchema
  }, { additionalProperties: false })
]);

const GraphEdgeSchema = Type.Object({
  from: Type.String({ minLength: 1, maxLength: 256 }),
  to: Type.String({ minLength: 1, maxLength: 256 }),
  type: GraphEdgeTypeSchema,
  properties: Type.Optional(Type.Object({}, { additionalProperties: GraphPropertyValueSchema })),
  evidenceRefs: Type.Optional(Type.Array(Type.String({ maxLength: 32 }), { maxItems: 8 }))
}, { additionalProperties: false });

const ProjectorGraphEdgeSchema = Type.Object({
  from: Type.String({ pattern: "^(existing|new):[1-9][0-9]*$", maxLength: 32 }),
  to: Type.String({ pattern: "^(existing|new):[1-9][0-9]*$", maxLength: 32 }),
  type: ProjectorGraphEdgeTypeSchema,
  properties: Type.Optional(Type.Object({}, { additionalProperties: GraphPropertyValueSchema })),
  evidenceRefs: Type.Optional(Type.Array(Type.String({ maxLength: 32 }), { maxItems: 8 }))
}, { additionalProperties: false });

const PlannerTaskIdSchema = Type.String({ pattern: "^task:.+", minLength: 6, maxLength: 256 });
const PlannerNodeIdSchema = Type.String({ minLength: 1, maxLength: 256 });
const PlannerRefArraySchema = Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32 });
const PlannerCommandBasisProperties = {
  basedOnRefs: Type.Optional(PlannerRefArraySchema),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 }))
};
const PlannerTaskBudgetSchema = Type.Object({
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 }))
}, { additionalProperties: false });
const PlannerTaskSpecSchema = Type.Object({
  id: PlannerTaskIdSchema,
  goal: Type.String({ minLength: 1, maxLength: 2_000 }),
  targetRefs: PlannerRefArraySchema,
  scopeRef: Type.String({ pattern: "^scope:.+", minLength: 7, maxLength: 256 }),
  constraints: Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 32 }),
  successCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 32 }),
  budget: Type.Optional(PlannerTaskBudgetSchema),
  priority: Type.Number({ minimum: 1 }),
  parentTaskId: Type.Optional(Type.String({ pattern: "^(goal|task):.+", maxLength: 256 })),
  dependsOnTaskRefs: Type.Optional(Type.Array(PlannerTaskIdSchema, { maxItems: 32 })),
  parallelGroup: Type.Optional(Type.String({ minLength: 1, maxLength: 256 }))
}, { additionalProperties: false });
const PlannerTaskPatchSchema = Type.Object({
  goal: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
  constraints: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 32 })),
  successCriteria: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { maxItems: 32 })),
  budget: Type.Optional(PlannerTaskBudgetSchema),
  priority: Type.Optional(Type.Number({ minimum: 1 })),
  parallelGroup: Type.Optional(Type.String({ maxLength: 256 }))
}, { additionalProperties: false });
const PlannerTaskStatusSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("partial"),
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("failed"),
  Type.Literal("archived")
]);
const PlannerCommandSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("create_tasks"),
    tasks: Type.Array(PlannerTaskSpecSchema, { minItems: 1, maxItems: 16 }),
    ...PlannerCommandBasisProperties
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("patch_task"),
    taskId: PlannerTaskIdSchema,
    patch: PlannerTaskPatchSchema,
    ...PlannerCommandBasisProperties
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("replace_dependencies"),
    taskId: PlannerTaskIdSchema,
    dependencyTaskIds: Type.Array(PlannerTaskIdSchema, { maxItems: 32 }),
    ...PlannerCommandBasisProperties
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("set_task_status"),
    taskId: PlannerTaskIdSchema,
    status: PlannerTaskStatusSchema,
    ...PlannerCommandBasisProperties
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("set_node_status"),
    nodeId: PlannerNodeIdSchema,
    status: Type.String({ minLength: 1, maxLength: 64 }),
    ...PlannerCommandBasisProperties
  }, { additionalProperties: false })
]);

export function createPlannerSubmitTool(input: {
  validate?: (value: unknown) => void | Promise<void>;
} = {}) {
  return defineTool({
    name: "planner_submit",
    label: "Submit Planner Decision",
    description: "Submit the final Planner decision using commands discriminated by the required kind field, then terminate this Planner invocation.",
    parameters: Type.Object({
      decision: Type.Union([Type.Literal("apply_commands"), Type.Literal("need_user_input")]),
      commands: Type.Optional(Type.Array(PlannerCommandSchema, { maxItems: 32 })),
      reason: Type.String({ minLength: 1, maxLength: 4_000 }),
      basedOnRefs: PlannerRefArraySchema
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      await input.validate?.(params);
      return {
        content: [{ type: "text", text: "Planner decision submitted" }],
        details: params,
        terminate: true
      };
    }
  });
}

export function createTaskResultSubmitTool() {
  return defineTool({
    name: "task_result_submit",
    label: "Submit Task Result",
    description: "Submit the final Executor epoch result and terminate this Executor invocation.",
    parameters: Type.Object({
      taskId: Type.String(),
      status: Type.Union([
        Type.Literal("completed"),
        Type.Literal("partial"),
        Type.Literal("failed")
      ]),
      summary: Type.String(),
      evidenceRefs: Type.Array(Type.String()),
      artifactRefs: Type.Array(Type.String()),
      blockerReason: Type.Optional(Type.String()),
      suggestedNextGoal: Type.Optional(Type.String()),
      checkpointReason: Type.Optional(Type.String()),
      retryable: Type.Optional(Type.Boolean())
    }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: "Task result submitted" }],
      details: params,
      terminate: true
    })
  });
}

export function createControlSubmitTool() {
  return defineTool({
    name: "control_submit",
    label: "Submit Control Signal",
    description: "Submit the final Supervisor control signal and terminate this Supervisor invocation.",
    parameters: Type.Object({
      decision: Type.Union([
        Type.Literal("continue"),
        Type.Literal("checkpoint"),
        Type.Literal("stop_executor"),
        Type.Literal("need_planner"),
        Type.Literal("need_user_input")
      ]),
      reason: Type.String(),
      evidenceRefs: Type.Array(Type.String()),
      confidence: Type.Optional(Type.Union([
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high")
      ])),
      budgetExtension: Type.Optional(Type.Object({
        maxTurnsDelta: Type.Optional(Type.Number()),
        reason: Type.Optional(Type.String())
      }))
    }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: "Control signal submitted" }],
      details: params,
      terminate: true
    })
  });
}

export function createGraphDeltaSubmitTool() {
  return defineTool({
    name: "graph_delta_submit",
    label: "Submit Graph Delta",
    description: "Submit the final Projector GraphDelta and terminate this Projector invocation.",
    parameters: Type.Object({
      nodes: Type.Array(ProjectorGraphNodeSchema, { maxItems: 12 }),
      edges: Type.Array(ProjectorGraphEdgeSchema, { maxItems: 20 })
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: "Graph delta submitted" }],
      details: params,
      terminate: true
    })
  });
}

export function createGraphQueryTool(graphStore: SQLiteGraphStore) {
  return defineTool({
    name: "graph_query",
    label: "Graph Query",
    description: "Read a bounded tri-graph view when the initial planner decision view is insufficient. This is read-only and does not expose raw logs or artifacts.",
    parameters: Type.Object({
      view: Type.Union([
        Type.Literal("planner"),
        Type.Literal("reasoning"),
        Type.Literal("operation"),
        Type.Literal("task"),
        Type.Literal("sessions")
      ]),
      focusNodeIds: Type.Optional(Type.Array(Type.String())),
      limit: Type.Optional(Type.Number())
    }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: JSON.stringify(graphStore.query(params.view as GraphView, params.focusNodeIds, params.limit), null, 2) }],
      details: {}
    })
  });
}

export function createGraphTraceTool(graphStore: SQLiteGraphStore) {
  return defineTool({
    name: "graph_trace",
    label: "Graph Trace",
    description: "Trace a node or evidence id back to related graph context. This is read-only and does not expose raw logs or artifacts.",
    parameters: Type.Object({
      nodeId: Type.Optional(Type.String()),
      evidenceId: Type.Optional(Type.String())
    }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: JSON.stringify(graphStore.trace(params), null, 2) }],
      details: {}
    })
  });
}

export function createGraphUpsertDeltaTool(graphStore: SQLiteGraphStore) {
  return defineTool({
    name: "graph_upsert_delta",
    label: "Graph Upsert Delta",
    description: "Write Observer-approved graph deltas into the tri-graph store.",
    parameters: Type.Object({
      sourceEventIds: Type.Array(Type.String()),
      nodes: Type.Array(GraphNodeSchema, { maxItems: 12 }),
      edges: Type.Array(GraphEdgeSchema, { maxItems: 20 })
    }),
    execute: async (_toolCallId, params) => {
      const delta = params as GraphDelta;
      graphStore.upsertDelta(delta);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, nodes: delta.nodes.length, edges: delta.edges.length }) }],
        details: {}
      };
    }
  });
}

export function createLogWindowTool(
  executionLog: ExecutionLog,
  options: { maxLimit?: number; allowFull?: boolean } = {}
) {
  return defineTool({
    name: "log_window",
    label: "Log Window",
    description: "Read a bounded execution log window for Observer projection.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String()),
      cursor: Type.Optional(Type.String()),
      limit: Type.Number(),
      eventTypes: Type.Optional(Type.Array(Type.String())),
      roles: Type.Optional(Type.Array(Type.String())),
      mode: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("full")]))
    }),
    execute: async (_toolCallId, params) => {
      const limit = Math.min(params.limit, options.maxLimit ?? params.limit);
      const window = await executionLog.window({
        ...params,
        limit,
        roles: (params.roles as Array<"planner" | "executor" | "observer" | "runtime"> | undefined) ?? ["executor", "runtime"]
      });
      const mode = options.allowFull === false ? "summary" : params.mode ?? "summary";
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...window,
            mode,
            requestedMode: params.mode ?? "summary",
            requestedLimit: params.limit,
            effectiveLimit: limit,
            events: mode === "full" ? window.events : compactExecutionEvents(window.events)
          }, null, 2)
        }],
        details: {}
      };
    }
  });
}

export function createArtifactReadTool(
  artifactStore: ArtifactStore,
  options: { maxReadBytes?: number } = {}
) {
  return defineTool({
    name: "artifact_read",
    label: "Artifact Read",
    description: "Read a bounded artifact range by artifact ref or path.",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number()),
      length: Type.Optional(Type.Number())
    }),
    execute: async (_toolCallId, params) => ({
      content: [{
        type: "text",
        text: await artifactStore.read(params.path, {
          offset: params.offset,
          length: Math.min(params.length ?? options.maxReadBytes ?? Number.MAX_SAFE_INTEGER, options.maxReadBytes ?? Number.MAX_SAFE_INTEGER)
        })
      }],
      details: {}
    })
  });
}

export function createArtifactWriteTool(artifactStore: ArtifactStore) {
  return defineTool({
    name: "artifact_write",
    label: "Artifact Write",
    description: "Persist large outputs, raw responses, screenshots, PoCs or stdout as artifacts and return an artifact record.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String()),
      kind: Type.Union([
        Type.Literal("http_body"),
        Type.Literal("screenshot"),
        Type.Literal("stdout"),
        Type.Literal("stderr"),
        Type.Literal("poc"),
        Type.Literal("json"),
        Type.Literal("text"),
        Type.Literal("other")
      ]),
      mediaType: Type.String(),
      data: Type.String(),
      extension: Type.Optional(Type.String())
    }),
    execute: async (_toolCallId, params) => {
      const record = await artifactStore.write({
        taskId: params.taskId,
        kind: params.kind as ArtifactRecord["kind"],
        mediaType: params.mediaType,
        data: params.data,
        extension: params.extension
      });
      return {
        content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
        details: record
      };
    }
  });
}
