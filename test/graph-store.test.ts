import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GraphValidationError, PlannerDecisionConflict, SQLiteGraphStore } from "../src/stores/graph-store.js";
import { RuntimeStore } from "../src/stores/runtime-store.js";

test("upserts tri-graph nodes and reads planner view", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:1"],
    nodes: [
      {
        id: "evidence:http-login",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Login page returned 200",
        properties: { statusCode: 200 },
        evidenceRefs: ["event:1"]
      },
      {
        id: "endpoint:/login",
        graphKind: "operation",
        type: "WebEndpoint",
        label: "POST /login",
        properties: { method: "POST", path: "/login" }
      },
      {
        id: "task:enumerate",
        graphKind: "task",
        type: "Task",
        label: "Enumerate login surface",
        properties: { status: "open" }
      }
    ],
    edges: [
      { from: "evidence:http-login", to: "endpoint:/login", type: "observed_on", evidenceRefs: ["event:1"] }
    ]
  });
  const snapshot = graphStore.query("planner");
  assert.equal(snapshot.summary.nodeCount, 3);
  assert.equal(snapshot.edges.length, 1);
  assert.deepEqual(graphStore.stats(), {
    nodeCount: 3,
    edgeCount: 1,
    deltaCount: 1,
    evidenceBackedNodeCount: 1,
    evidenceBackedEdgeCount: 1,
    nodesByKind: { operation: 1, reasoning: 1, task: 1 }
  });
  graphStore.close();
});

test("focused graph queries filter neighborhood nodes by graph kind", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:focus"],
    nodes: [
      { id: "goal:root", graphKind: "task", type: "Goal", label: "Goal", properties: {} },
      { id: "host:target", graphKind: "operation", type: "Host", label: "Target", properties: {} }
    ],
    edges: [{ from: "goal:root", to: "host:target", type: "observed_on", evidenceRefs: ["event:focus"] }]
  });

  const operation = graphStore.query("operation", ["goal:root"], 10);

  assert.deepEqual(operation.nodes.map((node) => node.id), ["host:target"]);
  assert.ok(operation.nodes.every((node) => node.graphKind === "operation"));
  graphStore.close();
});

test("projection closure preserves operation and reasoning paths around touched anchors", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:chain"],
    nodes: [
      { id: "task:test", graphKind: "task", type: "Task", label: "Upload validation", properties: { status: "open" } },
      { id: "scope:root", graphKind: "task", type: "Scope", label: "Scope", properties: {} },
      { id: "host:target", graphKind: "operation", type: "Host", label: "10.0.0.5", properties: { host: "10.0.0.5" } },
      { id: "port:80", graphKind: "operation", type: "Port", label: "80/tcp", properties: { port: 80 } },
      { id: "service:http", graphKind: "operation", type: "Service", label: "HTTP", properties: { service: "http" } },
      { id: "endpoint:upload", graphKind: "operation", type: "WebEndpoint", label: "POST /api/upload.php", properties: { url: "http://10.0.0.5/api/upload.php" } },
      { id: "evidence:upload", graphKind: "reasoning", type: "Evidence", label: "Upload returned 200", properties: {}, evidenceRefs: ["event:chain"] },
      { id: "hypothesis:handler", graphKind: "reasoning", type: "Hypothesis", label: "Uploaded extension may execute", properties: { status: "open" }, evidenceRefs: ["event:chain"] },
      { id: "vuln:upload", graphKind: "reasoning", type: "Vulnerability", label: "Unsafe upload confirmed", properties: { status: "confirmed" }, evidenceRefs: ["event:chain"] }
    ],
    edges: [
      { from: "task:test", to: "scope:root", type: "within_scope" },
      { from: "task:test", to: "endpoint:upload", type: "requires_evidence" },
      { from: "host:target", to: "port:80", type: "has_port" },
      { from: "port:80", to: "service:http", type: "runs_service" },
      { from: "service:http", to: "endpoint:upload", type: "exposes_endpoint" },
      { from: "evidence:upload", to: "endpoint:upload", type: "observed_on", evidenceRefs: ["event:chain"] },
      { from: "evidence:upload", to: "hypothesis:handler", type: "supports", evidenceRefs: ["event:chain"] },
      { from: "evidence:upload", to: "vuln:upload", type: "confirms", evidenceRefs: ["event:chain"] }
    ]
  });

  const closure = graphStore.projectionClosure({
    taskId: "task:test",
    scopeRef: "scope:root",
    targetRefs: ["endpoint:upload"],
    anchors: ["http://10.0.0.5/api/upload.php"]
  });
  const nodeIds = new Set(closure.nodes.map((node) => node.id));
  const edgeTypes = new Set(closure.edges.map((edge) => edge.type));

  for (const nodeId of [
    "host:target", "port:80", "service:http", "endpoint:upload",
    "evidence:upload", "hypothesis:handler", "vuln:upload"
  ]) {
    assert.ok(nodeIds.has(nodeId), `missing closure node ${nodeId}`);
  }
  for (const edgeType of ["has_port", "runs_service", "exposes_endpoint", "observed_on", "supports", "confirms"]) {
    assert.ok(edgeTypes.has(edgeType), `missing closure edge ${edgeType}`);
  }
  graphStore.close();
});

test("normalizes achieved root goal status to completed", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{ id: "goal:root", graphKind: "task", type: "Goal", label: "Get flag", properties: { status: "open" } }],
    edges: []
  });

  const goal = graphStore.setNodeStatus({ nodeId: "goal:root", status: "achieved" });

  assert.equal(goal.properties.status, "completed");
  graphStore.close();
});

test("projection graph merge and committed watermark update atomically", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const graphStore = new SQLiteGraphStore(databasePath, join(runtimeDir, "deltas.jsonl"));
  const runtimeStore = new RuntimeStore(databasePath);
  runtimeStore.raiseProjectionDesired("task:test", 9);
  const claim = runtimeStore.claimProjection("task:test");
  assert.ok(claim);

  graphStore.commitProjection({
    ...claim,
    delta: {
      sourceEventIds: ["event:9"],
      nodes: [{
        id: "evidence:9",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Projected evidence",
        properties: {},
        evidenceRefs: ["event:9"]
      }],
      edges: []
    }
  });

  assert.equal(runtimeStore.getProjectionState("task:test").committedSeq, 9);
  assert.equal(graphStore.query("reasoning", ["evidence:9"], 1).nodes[0]?.id, "evidence:9");
  runtimeStore.close();
  graphStore.close();
});

test("graph upserts merge evidence references instead of replacing them", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:1"],
    nodes: [{
      id: "evidence:merge",
      graphKind: "reasoning",
      type: "Evidence",
      label: "Merge evidence",
      properties: { first: true },
      evidenceRefs: ["event:1"]
    }],
    edges: []
  });
  graphStore.upsertDelta({
    sourceEventIds: ["event:2"],
    nodes: [{
      id: "evidence:merge",
      graphKind: "reasoning",
      type: "Evidence",
      label: "Merge evidence",
      properties: { second: true },
      evidenceRefs: ["event:2"]
    }],
    edges: []
  });

  const node = graphStore.query("reasoning", ["evidence:merge"], 1).nodes[0];
  assert.deepEqual(node?.evidenceRefs, ["event:1", "event:2"]);
  assert.deepEqual(node?.properties, { first: true, second: true });
  graphStore.close();
});

test("rejects graph node type changes for an existing identity", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{ id: "task:read-flag", graphKind: "task", type: "Task", label: "Read flag", properties: {} }],
    edges: []
  });

  assert.throws(() => graphStore.upsertDelta({
    sourceEventIds: ["event:1"],
    nodes: [{
      id: "task:read-flag",
      graphKind: "task",
      type: "Milestone",
      label: "Retyped task",
      properties: {},
      evidenceRefs: ["event:1"]
    }],
    edges: []
  }), /Reserved node id|Node identity conflict/);
  assert.equal(graphStore.query("task", ["task:read-flag"], 1).nodes[0]?.type, "Task");
  graphStore.close();
});

test("rejects graph node types stored in the wrong graph category", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));

  assert.throws(() => graphStore.upsertDelta({
    sourceEventIds: ["event:wrong-operation"],
    nodes: [{
      id: "evidence:wrong-operation",
      graphKind: "operation",
      type: "Evidence",
      label: "Evidence placed in operation graph",
      properties: {},
      evidenceRefs: ["event:wrong-operation"]
    }],
    edges: []
  }), /requires graphKind=reasoning/);

  assert.throws(() => graphStore.upsertDelta({
    sourceEventIds: ["event:wrong-reasoning"],
    nodes: [{
      id: "blocker:wrong-reasoning",
      graphKind: "reasoning",
      type: "Blocker",
      label: "Blocker placed in reasoning graph",
      properties: {},
      evidenceRefs: ["event:wrong-reasoning"]
    }],
    edges: []
  }), /requires graphKind=task/);

  graphStore.close();
});

test("projection closure prioritizes semantic memory linked to the current task", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:memory"],
    nodes: [
      { id: "task:test", graphKind: "task", type: "Task", label: "Test", properties: {} },
      { id: "scope:root", graphKind: "task", type: "Scope", label: "Scope", properties: {} },
      { id: "evidence:memory", graphKind: "reasoning", type: "Evidence", label: "passwd read", properties: {}, evidenceRefs: ["event:memory"] },
      { id: "vuln:path-traversal", graphKind: "reasoning", type: "Vulnerability", label: "Path traversal", properties: {}, evidenceRefs: ["event:memory"] },
      { id: "endpoint:download", graphKind: "operation", type: "WebEndpoint", label: "GET /download.php", properties: { path: "/download.php" } }
    ],
    edges: [
      { from: "task:test", to: "scope:root", type: "within_scope" },
      { from: "task:test", to: "evidence:memory", type: "produces_evidence", evidenceRefs: ["event:memory"] },
      { from: "evidence:memory", to: "vuln:path-traversal", type: "confirms", evidenceRefs: ["event:memory"] },
      { from: "vuln:path-traversal", to: "endpoint:download", type: "affects", evidenceRefs: ["event:memory"] }
    ]
  });

  const closure = graphStore.projectionClosure({
    taskId: "task:test",
    scopeRef: "scope:root",
    anchors: [],
    nodeLimit: 8,
    edgeLimit: 12
  });
  const nodeIds = new Set(closure.nodes.map((node) => node.id));
  assert.ok(nodeIds.has("evidence:memory"));
  assert.ok(nodeIds.has("vuln:path-traversal"));
  assert.ok(nodeIds.has("endpoint:download"));
  graphStore.close();
});

test("projection commit conflict rolls back graph writes and watermark", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const graphStore = new SQLiteGraphStore(databasePath, join(runtimeDir, "deltas.jsonl"));
  const runtimeStore = new RuntimeStore(databasePath);
  runtimeStore.raiseProjectionDesired("task:rollback", 4);
  const claim = runtimeStore.claimProjection("task:rollback");
  assert.ok(claim);

  assert.throws(() => graphStore.commitProjection({
    ...claim,
    generation: claim.generation + 1,
    delta: {
      sourceEventIds: ["event:4"],
      nodes: [{
        id: "evidence:must-not-exist",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Must roll back",
        properties: {},
        evidenceRefs: ["event:4"]
      }],
      edges: []
    }
  }), /generation conflict/);

  assert.equal(runtimeStore.getProjectionState("task:rollback").committedSeq, 0);
  assert.equal(graphStore.query("reasoning", ["evidence:must-not-exist"], 1).nodes.length, 0);
  runtimeStore.close();
  graphStore.close();
});

test("rejects confirmed vulnerability without evidence refs", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  assert.throws(() => {
    graphStore.upsertDelta({
      sourceEventIds: [],
      nodes: [
        {
          id: "vuln:sqli",
          graphKind: "reasoning",
          type: "Vulnerability",
          label: "SQL injection",
          properties: {}
        }
      ],
      edges: []
    });
  }, GraphValidationError);
  graphStore.close();
});

test("releases dependent tasks when every dependency has a partial or completed outcome", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTask({
    taskId: "task:recon-a",
    goal: "Recon A",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["A done"],
    priority: 1,
    parentTaskId: "goal:root",
    parallelGroup: "recon"
  });
  graphStore.createTask({
    taskId: "task:recon-b",
    goal: "Recon B",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["B done"],
    priority: 1,
    parentTaskId: "goal:root",
    parallelGroup: "recon"
  });
  graphStore.createTask({
    taskId: "task:exploit",
    goal: "Exploit after recon",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["flag found"],
    priority: 2,
    parentTaskId: "goal:root",
    dependsOnTaskRefs: ["task:recon-a", "task:recon-b"]
  });

  assert.deepEqual(
    graphStore.listReadyTasks(10).map((task) => task.taskId),
    ["task:recon-a", "task:recon-b"]
  );

  graphStore.markTaskStatus({ taskId: "task:recon-a", status: "partial" });
  assert.deepEqual(
    graphStore.listReadyTasks(10).map((task) => task.taskId),
    ["task:recon-b"]
  );

  graphStore.markTaskStatus({ taskId: "task:recon-b", status: "completed" });
  assert.deepEqual(
    graphStore.listReadyTasks(10).map((task) => task.taskId),
    ["task:exploit"]
  );
  graphStore.close();
});

test("planner dependency preflight reports the exact cycle without mutating the graph", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTasks([
    {
      taskId: "task:entry",
      goal: "Entry reconnaissance",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["understand entry surface"],
      priority: 1
    },
    {
      taskId: "task:auth",
      goal: "Authenticate",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["obtain session"],
      priority: 2,
      dependsOnTaskRefs: ["task:entry"]
    },
    {
      taskId: "task:discovery",
      goal: "Discover authenticated resources",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["map resources"],
      priority: 3,
      dependsOnTaskRefs: ["task:auth"]
    }
  ]);

  assert.throws(
    () => graphStore.validatePlannerDecision({
      decision: "apply_commands",
      commands: [{
        kind: "replace_dependencies",
        taskId: "task:auth",
        dependencyTaskIds: ["task:entry", "task:discovery"]
      }],
      reason: "invalidly reverse the dependency direction",
      basedOnRefs: ["task:discovery"]
    }),
    /Dependency graph would contain a cycle: task:auth -> task:discovery -> task:auth/
  );
  assert.deepEqual(graphStore.getTaskEnvelope("task:auth")?.dependsOnTaskRefs, ["task:entry"]);
  graphStore.close();
});

test("archived dependency releases children only when it preserves an outcome", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTasks([
    {
      taskId: "task:archived-with-result",
      goal: "Preserve a prior outcome",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["produce a reusable outcome"],
      priority: 1
    },
    {
      taskId: "task:child-with-result",
      goal: "Consume the prior outcome",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["reuse the outcome"],
      priority: 2,
      dependsOnTaskRefs: ["task:archived-with-result"]
    },
    {
      taskId: "task:archived-without-result",
      goal: "Never executed stale task",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["none"],
      priority: 3
    },
    {
      taskId: "task:child-without-result",
      goal: "Must not run without an outcome",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["wait"],
      priority: 4,
      dependsOnTaskRefs: ["task:archived-without-result"]
    }
  ]);
  graphStore.markTaskStatus({
    taskId: "task:archived-with-result",
    status: "archived",
    properties: { resultSummary: "Reusable authenticated session discovered" }
  });
  graphStore.markTaskStatus({ taskId: "task:archived-without-result", status: "archived" });

  assert.deepEqual(
    graphStore.listReadyTasks(10).map((task) => task.taskId),
    ["task:child-with-result"]
  );
  graphStore.close();
});

test("rejects scheduler dependency edges outside Task to Task", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTask({
    taskId: "task:recon",
    goal: "Recon target",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["recon complete"],
    priority: 1
  });
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{
      id: "host:target",
      graphKind: "operation",
      type: "Host",
      label: "target",
      properties: {}
    }],
    edges: []
  });

  assert.throws(() => graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [],
    edges: [{ from: "task:recon", to: "host:target", type: "depends_on" }]
  }), GraphValidationError);
  graphStore.close();
});

test("archived tasks remain auditable but are excluded from ready scheduling", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTask({
    taskId: "task:obsolete",
    goal: "Obsolete overlapping exploration",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["obsolete"],
    priority: 1
  });

  graphStore.setTaskStatus({
    taskId: "task:obsolete",
    status: "archived",
    reason: "Superseded by a confirmed capability"
  });

  assert.deepEqual(graphStore.listReadyTasks(10), []);
  const archived = graphStore.getTaskNode("task:obsolete");
  assert.equal(archived?.properties.status, "archived");
  assert.equal(archived?.properties.plannerReason, "Superseded by a confirmed capability");
  graphStore.close();
});

test("replaces task dependencies through edges only", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTasks([
    {
      taskId: "task:recon-a",
      goal: "Recon A",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["A done"],
      priority: 1
    },
    {
      taskId: "task:recon-b",
      goal: "Recon B",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["B done"],
      priority: 1
    },
    {
      taskId: "task:exploit",
      goal: "Exploit after recon",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["flag found"],
      priority: 2,
      dependsOnTaskRefs: ["task:recon-a"]
    }
  ]);

  graphStore.replaceTaskDependencies({
    taskId: "task:exploit",
    dependencyTaskIds: ["task:recon-b"]
  });
  graphStore.markTaskStatus({ taskId: "task:recon-a", status: "completed" });

  assert.deepEqual(
    graphStore.getTaskEnvelope("task:exploit")?.dependsOnTaskRefs,
    ["task:recon-b"]
  );
  assert.equal(
    graphStore.listReadyTasks(10).some((task) => task.taskId === "task:exploit"),
    false
  );

  graphStore.markTaskStatus({ taskId: "task:recon-b", status: "completed" });
  assert.equal(
    graphStore.listReadyTasks(10).some((task) => task.taskId === "task:exploit"),
    true
  );
  graphStore.close();
});

test("runtime task result preserves planner version for later expectedVersion patches", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTasks([
    {
      taskId: "task:recon",
      goal: "Recon target",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["recon done"],
      priority: 1
    },
    {
      taskId: "task:extract-flag",
      goal: "Extract flag",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: ["scope"],
      successCriteria: ["flag found"],
      priority: 2,
      dependsOnTaskRefs: ["task:recon"],
      budget: { maxTurns: 12 }
    }
  ]);

  const patched = graphStore.patchTask({
    taskId: "task:extract-flag",
    expectedVersion: 1,
    patch: {
      goal: "Extract flag through auth bypass",
      budget: { maxTurns: 24 }
    }
  });
  assert.equal(patched.properties.version, 2);

  const taskEnvelope = graphStore.getTaskEnvelope("task:extract-flag");
  assert.ok(taskEnvelope);
  graphStore.markTaskStatus({
    taskId: "task:extract-flag",
    status: "running",
    properties: { startedAt: "2026-07-10T00:00:00.000Z" }
  });
  assert.equal(graphStore.getTaskNode("task:extract-flag")?.properties.version, 2);

  graphStore.updateTaskResult({
    taskEnvelope,
    taskResult: {
      taskId: "task:extract-flag",
      status: "partial",
      summary: "Checkpointed after auth bypass attempts",
      evidenceRefs: ["event:auth"],
      artifactRefs: ["artifact:auth"],
      checkpointReason: "timeout",
      retryable: true,
      resumeCursor: "event:last"
    },
    sourceEventIds: ["event:partial"]
  });
  const afterRuntime = graphStore.getTaskNode("task:extract-flag");
  assert.equal(afterRuntime?.properties.version, 2);
  assert.equal(afterRuntime?.properties.runtimeVersion, 2);
  assert.equal(afterRuntime?.properties.status, "partial");
  assert.deepEqual(graphStore.getTaskEnvelope("task:extract-flag")?.dependsOnTaskRefs, ["task:recon"]);

  const nextPatch = graphStore.patchTask({
    taskId: "task:extract-flag",
    expectedVersion: 2,
    patch: { goal: "Extract flag through CONNECT tunnel" }
  });
  assert.equal(nextPatch.properties.version, 3);
  graphStore.close();
});

test("planner task command batch uses one snapshot version per task", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTasks([{
    taskId: "task:recon-web",
    goal: "Recon web",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["find ssrf"],
    priority: 1,
    budget: { maxTurns: 10 }
  }]);
  graphStore.markTaskStatus({
    taskId: "task:recon-web",
    status: "partial",
    properties: { checkpointReason: "maxTurns" }
  });

  const results = graphStore.applyTaskCommandBatch([
    {
      commandIndex: 0,
      kind: "set_task_status",
      taskId: "task:recon-web",
      status: "open",
      expectedVersion: 1,
      sourceEventIds: ["event:planner"],
      reason: "resume recon"
    },
    {
      commandIndex: 1,
      kind: "patch_task",
      taskId: "task:recon-web",
      patch: { budget: { maxTurns: 16 } },
      expectedVersion: 1,
      sourceEventIds: ["event:planner"],
      reason: "extend budget"
    }
  ]);

  const task = graphStore.getTaskNode("task:recon-web");
  assert.equal(task?.properties.status, "open");
  assert.deepEqual(task?.properties.budget, { maxTurns: 16 });
  assert.equal(task?.properties.version, 2);
  assert.equal(task?.properties.plannerReason, "resume recon；extend budget");
  assert.deepEqual(results.map((result) => result.node.properties.version), [2, 2]);
  assert.doesNotThrow(() => graphStore.patchTask({
    taskId: "task:recon-web",
    expectedVersion: 2,
    patch: { priority: 2 }
  }));
  graphStore.close();
});

test("planner decision applies all graph mutations atomically", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{
      id: "goal:root",
      graphKind: "task",
      type: "Goal",
      label: "Root goal",
      properties: { status: "open", version: 1 }
    }],
    edges: []
  });
  graphStore.createTasks([{
    taskId: "task:existing",
    goal: "Existing task",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["done"],
    priority: 1
  }]);
  graphStore.patchTask({ taskId: "task:existing", expectedVersion: 1, patch: { priority: 2 } });

  assert.throws(() => graphStore.applyPlannerDecision({
    createTasks: [{
      taskId: "task:must-rollback",
      goal: "Must not survive conflict",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["never committed"],
      priority: 1
    }],
    taskCommands: [{
      commandIndex: 1,
      kind: "patch_task",
      taskId: "task:existing",
      patch: { goal: "Stale patch" },
      expectedVersion: 1,
      sourceEventIds: ["event:planner"]
    }],
    nodeStatusCommands: [],
    sourceEventIds: ["event:planner"]
  }), (error) => {
    assert.ok(error instanceof PlannerDecisionConflict);
    assert.equal(error.conflicts[0]?.nodeId, "task:existing");
    assert.equal(error.conflicts[0]?.expectedVersion, 1);
    assert.equal(error.conflicts[0]?.currentVersion, 2);
    return true;
  });
  assert.equal(graphStore.getTaskNode("task:must-rollback"), undefined);
  assert.equal(graphStore.getTaskNode("task:existing")?.label, "Existing task");

  graphStore.applyPlannerDecision({
    createTasks: [{
      taskId: "task:created",
      goal: "Created atomically",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["created"],
      priority: 1
    }],
    taskCommands: [{
      commandIndex: 1,
      kind: "set_task_status",
      taskId: "task:existing",
      status: "completed",
      expectedVersion: 2,
      sourceEventIds: ["event:planner"],
      reason: "complete existing"
    }],
    nodeStatusCommands: [{
      commandIndex: 2,
      nodeId: "goal:root",
      status: "completed",
      expectedVersion: 1,
      sourceEventIds: ["event:planner"],
      reason: "complete root"
    }],
    sourceEventIds: ["event:planner"]
  });

  assert.equal(graphStore.getTaskNode("task:created")?.properties.version, 1);
  assert.equal(graphStore.getTaskNode("task:existing")?.properties.status, "completed");
  assert.equal(graphStore.query("task", ["goal:root"], 1).nodes[0]?.properties.status, "completed");
  graphStore.close();
});

test("builds compact planner decision view from task results and key graph facts", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:task", "event:flag"],
    nodes: [
      {
        id: "task:read-flag",
        graphKind: "task",
        type: "Task",
        label: "Read the known flag path",
        properties: {
          status: "partial",
          resultSummary: "Web shell works; /challenge/flag.txt still needs reading",
          checkpointReason: "handoff to planner",
          resumeCursor: "event:tool:3",
          targetRefs: ["endpoint:/c.php"],
          scopeRef: "scope:root",
          priority: 1,
          artifactRefs: ["artifact:large-stdout"]
        }
      },
      {
        id: "evidence:flag-path",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Flag path likely /challenge/flag.txt",
        properties: {
          status: "observed",
          rawBody: "x".repeat(5000),
          artifactRefs: ["artifact:raw-page"]
        },
        evidenceRefs: ["event:flag"]
      },
      {
        id: "vuln:webshell",
        graphKind: "reasoning",
        type: "Vulnerability",
        label: "Writable web shell confirmed",
        properties: { status: "confirmed", severity: "high" },
        evidenceRefs: ["event:webshell"]
      },
      {
        id: "endpoint:/c.php",
        graphKind: "operation",
        type: "WebEndpoint",
        label: "GET /c.php",
        properties: { status: "alive", method: "GET", path: "/c.php", rawBody: "hidden raw" }
      },
      {
        id: "session:admin",
        graphKind: "operation",
        type: "Session",
        label: "Admin session",
        properties: { status: "valid", role: "admin", token: "secret-token" }
      }
    ],
    edges: [
      { from: "task:read-flag", to: "endpoint:/c.php", type: "requires_evidence" },
      { from: "evidence:flag-path", to: "vuln:webshell", type: "supports", evidenceRefs: ["event:flag"] }
    ]
  });

  const view = graphStore.plannerDecisionView();
  assert.equal(view.view, "planner_decision");
  assert.equal(view.taskLedger[0]?.taskId, "task:read-flag");
  assert.equal(view.taskLedger[0]?.resultSummary, "Web shell works; /challenge/flag.txt still needs reading");
  assert.equal(view.taskLedger[0]?.resumeCursor, "event:tool:3");
  assert.ok(view.reasoningDigest.some((item) => item.id === "vuln:webshell" && item.reasons.includes("important_state:confirmed")));
  assert.ok(view.reasoningDigest.some((item) => item.id === "evidence:flag-path" && item.reasons.includes("decision_keyword")));
  assert.ok(view.operationDigest.some((item) => item.id === "session:admin" && item.reasons.includes("important_state:valid")));
  assert.ok(view.operationDigest.some((item) => item.id === "endpoint:/c.php"));
  assert.equal(view.reasoningDigest.find((item) => item.id === "evidence:flag-path")?.properties.rawBody, undefined);
  assert.equal(view.operationDigest.find((item) => item.id === "session:admin")?.properties.token, undefined);
  assert.deepEqual(view.retrievalHints.tools, ["graph_query", "graph_trace"]);
  graphStore.close();
});

test("planner task ledger truncates long runtime outcomes", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{
      id: "task:long-result",
      graphKind: "task",
      type: "Task",
      label: "Long result task",
      properties: { status: "partial", resultSummary: `.agent-runtime ${"x".repeat(5_000)}` }
    }],
    edges: []
  });

  const summary = graphStore.plannerDecisionView().taskLedger[0]?.resultSummary ?? "";
  assert.ok(summary.length <= 520);
  assert.match(summary, /\[truncated\]$/);
  graphStore.close();
});
