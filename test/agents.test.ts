import assert from "node:assert/strict";
import test from "node:test";
import { createExecutorResearchTools, observerToolsForMode } from "../src/agents.js";
import { createGraphDeltaSubmitTool, createPlannerSubmitTool } from "../src/tools/pi-tools.js";
import type { ArtifactStore } from "../src/stores/artifact-store.js";
import type { ExecutionLog } from "../src/stores/execution-log.js";
import type { SQLiteGraphStore } from "../src/stores/graph-store.js";

test("supervisor observer mode exposes only the terminating control tool", () => {
  const tools = observerToolsForMode({
    mode: "supervise",
    graphStore: {} as SQLiteGraphStore,
    executionLog: {} as ExecutionLog,
    artifactStore: {} as ArtifactStore
  });

  assert.deepEqual(tools.map((tool) => tool.name), ["control_submit"]);
});

test("projector observer mode exposes only the terminating graph tool", () => {
  const tools = observerToolsForMode({
    mode: "project",
    graphStore: {} as SQLiteGraphStore,
    executionLog: {} as ExecutionLog,
    artifactStore: {} as ArtifactStore
  });

  assert.deepEqual(tools.map((tool) => tool.name), ["graph_delta_submit"]);
});

test("executor exposes bounded public research tools", () => {
  assert.deepEqual(
    createExecutorResearchTools().map((tool) => tool.name),
    ["web_fetch", "web_search", "vulnerability_search"]
  );
});

test("projector terminal tool uses a bounded strict draft schema", () => {
  const tool = createGraphDeltaSubmitTool();
  const schema = tool.parameters as unknown as {
    properties: {
      nodes: {
        maxItems?: number;
        items?: {
          anyOf?: Array<{
            additionalProperties?: boolean;
            properties?: {
              id?: { pattern?: string };
              graphKind?: { const?: string };
              properties?: { additionalProperties?: { anyOf?: unknown[] } };
            };
          }>;
        };
      };
      edges: {
        maxItems?: number;
        items?: {
          additionalProperties?: boolean;
          properties?: {
            from?: { pattern?: string };
            to?: { pattern?: string };
            type?: { anyOf?: Array<{ const?: string }> };
          };
        };
      };
      sourceEventIds?: unknown;
    };
    additionalProperties?: boolean;
  };

  assert.equal(schema.properties.nodes.maxItems, 12);
  assert.equal(schema.properties.edges.maxItems, 20);
  assert.deepEqual(
    schema.properties.nodes.items?.anyOf?.map((branch) => branch.properties?.graphKind?.const),
    ["reasoning", "operation"]
  );
  assert.ok(schema.properties.nodes.items?.anyOf?.every((branch) => branch.additionalProperties === false));
  assert.ok(schema.properties.nodes.items?.anyOf?.every((branch) => branch.properties?.id?.pattern === "^(existing|new):[1-9][0-9]*$"));
  assert.ok(schema.properties.nodes.items?.anyOf?.every((branch) => (branch.properties?.properties?.additionalProperties?.anyOf?.length ?? 0) > 0));
  assert.equal(schema.properties.edges.items?.additionalProperties, false);
  assert.equal(schema.properties.edges.items?.properties?.from?.pattern, "^(existing|new):[1-9][0-9]*$");
  assert.equal(schema.properties.edges.items?.properties?.to?.pattern, "^(existing|new):[1-9][0-9]*$");
  assert.equal(
    schema.properties.edges.items?.properties?.type?.anyOf?.some((branch) => branch.const === "depends_on"),
    false
  );
  assert.equal(schema.properties.sourceEventIds, undefined);
  assert.equal(schema.additionalProperties, false);
});

test("planner terminal tool exposes discriminated command schemas", () => {
  const tool = createPlannerSubmitTool();
  const schema = tool.parameters as unknown as {
    properties: {
      commands: {
        maxItems?: number;
        items?: {
          anyOf?: Array<{
            additionalProperties?: boolean;
            required?: string[];
            properties?: {
              kind?: { const?: string };
              type?: unknown;
              expectedVersion?: unknown;
              tasks?: {
                items?: {
                  required?: string[];
                  properties?: {
                    id?: { pattern?: string };
                    scopeRef?: { pattern?: string };
                  };
                };
              };
            };
          }>;
        };
      };
    };
    additionalProperties?: boolean;
  };
  const branches = schema.properties.commands.items?.anyOf ?? [];

  assert.equal(schema.properties.commands.maxItems, 32);
  assert.deepEqual(
    branches.map((branch) => branch.properties?.kind?.const),
    ["create_tasks", "patch_task", "replace_dependencies", "set_task_status", "set_node_status"]
  );
  assert.ok(branches.every((branch) => branch.additionalProperties === false));
  assert.ok(branches.every((branch) => branch.required?.includes("kind")));
  assert.ok(branches.every((branch) => branch.properties?.type === undefined));
  assert.ok(branches.every((branch) => branch.properties?.expectedVersion === undefined));
  assert.equal(branches[0]?.properties?.tasks?.items?.properties?.id?.pattern, "^task:.+");
  assert.equal(branches[0]?.properties?.tasks?.items?.properties?.scopeRef?.pattern, "^scope:.+");
  assert.equal(schema.additionalProperties, false);
});

test("planner terminal tool validates graph semantics before terminating", async () => {
  let validated = false;
  const tool = createPlannerSubmitTool({
    validate: () => {
      validated = true;
      throw new Error("Dependency graph would contain a cycle: task:a -> task:b -> task:a");
    }
  });

  await assert.rejects(
    () => tool.execute(
      "call:planner",
      {
        decision: "apply_commands",
        commands: [],
        reason: "invalid dependency update",
        basedOnRefs: []
      },
      new AbortController().signal,
      () => undefined,
      {} as never
    ),
    /task:a -> task:b -> task:a/
  );
  assert.equal(validated, true);
});
