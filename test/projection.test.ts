import assert from "node:assert/strict";
import test from "node:test";
import {
  aliasProjectionGraphContext,
  buildProjectionObservations,
  causalObservationDigest,
  capabilityDigest,
  expandProjectionDraft,
  observationDigest,
  renderProjectionGraphContext,
  renderProjectionObservations,
  selectProjectionBatch,
  type ProjectionObservation
} from "../src/projection.js";
import type { ExecutionEvent, GraphEdge, GraphNode } from "../src/types.js";

test("merges Pi tool events into action observations and excludes runtime context reads", () => {
  const events: ExecutionEvent[] = [
    event(1, "event:intent", "assistant_intent", { text: "验证上传接口认证差异" }),
    event(2, "event:start", "tool_started", {
      toolCallId: "call:upload",
      toolName: "bash",
      args: { command: "curl http://10.0.0.5/api/upload.php" }
    }),
    event(3, "event:end", "tool_finished", {
      toolCallId: "call:upload",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "HTTP/1.1 403 Forbidden /api/upload.php" }] }
    }),
    event(4, "event:skill-start", "tool_started", {
      toolCallId: "call:skill",
      toolName: "read",
      args: { path: "/Users/test/.agents/skills/ctf-web/SKILL.md" }
    }),
    event(5, "event:skill-end", "tool_finished", {
      toolCallId: "call:skill",
      toolName: "read",
      result: { content: [{ type: "text", text: "skill instructions" }] }
    }),
    event(6, "event:partial", "task_partial", {
      taskResult: { summary: "上传接口存在，认证仍待验证" }
    })
  ];

  const observations = buildProjectionObservations(events);

  assert.equal(observations.length, 2);
  assert.equal(observations[0]?.action, "bash");
  assert.equal(observations[0]?.intent, "验证上传接口认证差异");
  assert.match(observations[0]?.interpretation ?? "", /上传接口存在/);
  assert.deepEqual(observations[0]?.sourceEventIds, ["event:intent", "event:start", "event:end"]);
  assert.ok(observations[0]?.anchors.includes("10.0.0.5"));
  assert.ok(observations[0]?.anchors.includes("/api/upload.php"));
  assert.equal(observations.some((observation) => observation.outcomeDigest.includes("skill instructions")), false);

  const batch = selectProjectionBatch(events, { fromSeq: 0, maxObservations: 1 });
  assert.equal(batch.observations.length, 1);
  assert.equal(batch.toSeq, 3);
});

test("closes a long tool result with the next Executor interpretation without consuming that pending intent", () => {
  const longResult = `${"HTTP 403\n".repeat(80)}/keys/../public/static/README.md 200\n${"HTTP 403\n".repeat(80)}`;
  const events: ExecutionEvent[] = [
    event(1, "event:intent", "assistant_intent", { text: "比较 /keys 路径规范化差异" }),
    event(2, "event:start", "tool_started", {
      toolCallId: "call:keys",
      toolName: "bash",
      args: { command: "probe keys traversal variants" }
    }),
    event(3, "event:end", "tool_finished", {
      toolCallId: "call:keys",
      toolName: "bash",
      result: { content: [{ type: "text", text: longResult }] }
    }),
    event(4, "event:interpretation", "assistant_intent", {
      text: "利用 /keys 可穿越事实，读取已知静态文件作为 JWT kid 密钥候选。"
    })
  ];

  const observations = buildProjectionObservations(events);
  const batch = selectProjectionBatch(events, { fromSeq: 0, maxObservations: 4 });

  assert.equal(observations.length, 1);
  assert.match(observations[0]?.interpretation ?? "", /\/keys 可穿越事实/);
  assert.doesNotMatch(observations[0]?.sourceEventIds.join(" ") ?? "", /event:interpretation/);
  assert.match(renderProjectionObservations(observations), /executor_interpretation: 利用 \/keys 可穿越事实/);
  assert.match(causalObservationDigest(observations), /\/keys 可穿越事实/);
  assert.equal(batch.observations.length, 1);
  assert.equal(batch.toSeq, 3);
});

test("groups parallel tool results under one Executor interpretation", () => {
  const observations = buildProjectionObservations([
    event(1, "event:intent", "assistant_intent", { text: "并行确认两个服务" }),
    event(2, "event:start-http", "tool_started", {
      toolCallId: "call:http",
      toolName: "bash",
      args: { command: "curl http://10.0.0.5/" }
    }),
    event(3, "event:start-ssh", "tool_started", {
      toolCallId: "call:ssh",
      toolName: "bash",
      args: { command: "nc -vz 10.0.0.5 22" }
    }),
    event(4, "event:end-http", "tool_finished", {
      toolCallId: "call:http",
      toolName: "bash",
      result: { content: [{ type: "text", text: "HTTP/1.1 200 OK" }] }
    }),
    event(5, "event:end-ssh", "tool_finished", {
      toolCallId: "call:ssh",
      toolName: "bash",
      result: { content: [{ type: "text", text: "Connection succeeded" }] }
    }),
    event(6, "event:interpretation", "assistant_intent", {
      text: "目标同时开放 HTTP 和 SSH，下一步检查认证面。"
    })
  ]);

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.action, "tool_group");
  assert.equal(observations[0]?.actions?.length, 2);
  assert.match(observations[0]?.interpretation ?? "", /同时开放 HTTP 和 SSH/);
  const rendered = renderProjectionObservations(observations);
  assert.match(rendered, /tool\[1\]: bash/);
  assert.equal(rendered.match(/executor_interpretation:/g)?.length, 1);
});

test("does not advance projection watermark past an unclosed action", () => {
  const events: ExecutionEvent[] = [
    event(1, "event:intent", "assistant_intent", { text: "验证内部读取能力" }),
    event(2, "event:start", "tool_started", {
      toolCallId: "call:read",
      toolName: "bash",
      args: { command: "read candidate" }
    }),
    event(3, "event:end", "tool_finished", {
      toolCallId: "call:read",
      toolName: "bash",
      result: { content: [{ type: "text", text: "large result awaiting interpretation" }] }
    })
  ];

  const batch = selectProjectionBatch(events, { fromSeq: 0, maxObservations: 4 });

  assert.equal(batch.observations.length, 0);
  assert.equal(batch.toSeq, 0);
});

test("only terminal task result events become task outcome observations", () => {
  const observations = buildProjectionObservations([
    event(1, "event:created", "task_created", { goal: "Initial task definition" }),
    event(2, "event:wave", "task_wave_started", { taskIds: ["task:test"] }),
    event(3, "event:epoch", "epoch_transition", { state: "running" }),
    event(4, "event:partial", "task_partial", {
      taskResult: { summary: "Confirmed internal admin token and paused for replanning" }
    })
  ]);

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.kind, "task_outcome");
  assert.match(observations[0]?.outcomeDigest ?? "", /internal admin token/);
});

test("preserves the final conclusion of long tool results", () => {
  const observations = buildProjectionObservations([
    event(1, "event:start", "tool_started", {
      toolCallId: "call:scan",
      toolName: "bash",
      args: { command: `${"scan-candidate ".repeat(40)}exact-final-expression` }
    }),
    event(2, "event:end", "tool_finished", {
      toolCallId: "call:scan",
      toolName: "bash",
      result: { content: [{ type: "text", text: `${"candidate-output ".repeat(80)}No match found` }] }
    })
  ]);

  assert.match(observations[0]?.outcomeDigest ?? "", /^candidate-output/);
  assert.match(observations[0]?.outcomeDigest ?? "", /No match found$/);
  assert.match(observations[0]?.inputDigest ?? "", /exact-final-expression/);
});

test("coalesces consecutive repeated observations without losing event provenance", () => {
  const observations = buildProjectionObservations([
    event(1, "event:start-1", "tool_started", {
      toolCallId: "call:1",
      toolName: "bash",
      args: { command: "probe candidate-a" }
    }),
    event(2, "event:end-1", "tool_finished", {
      toolCallId: "call:1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "HTTP 403 access denied" }] }
    }),
    event(3, "event:start-2", "tool_started", {
      toolCallId: "call:2",
      toolName: "bash",
      args: { command: "probe candidate-b" }
    }),
    event(4, "event:end-2", "tool_finished", {
      toolCallId: "call:2",
      toolName: "bash",
      result: { content: [{ type: "text", text: "HTTP 403 access denied" }] }
    })
  ]);

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.repeatCount, 2);
  assert.deepEqual(observations[0]?.sourceEventIds, [
    "event:start-1", "event:end-1", "event:start-2", "event:end-2"
  ]);
  assert.match(observations[0]?.inputDigest ?? "", /candidate-a/);
  assert.match(observations[0]?.inputDigest ?? "", /candidate-b/);
});

test("expands graph aliases and observation evidence refs into stable GraphDelta ids", () => {
  const nodes: GraphNode[] = [{
    id: "endpoint:upload",
    graphKind: "operation",
    type: "WebEndpoint",
    label: "POST /api/upload.php",
    properties: { method: "POST", path: "/api/upload.php" }
  }];
  const edges: GraphEdge[] = [];
  const graphContext = aliasProjectionGraphContext({ nodes, edges });
  const batch = {
    observations: [{
      ref: "o1",
      kind: "action" as const,
      seqStart: 1,
      seqEnd: 3,
      action: "bash",
      outcomeDigest: "API key accepted and upload succeeded",
      status: "ok" as const,
      artifactRefs: [],
      anchors: ["/api/upload.php"],
      sourceEventIds: ["event:1", "event:2", "event:3"]
    }],
    toSeq: 3,
    sourceEventIds: ["event:1", "event:2", "event:3"]
  };

  const delta = expandProjectionDraft({
    batch,
    graphContext,
    value: {
      nodes: [{
        id: "new:1",
        graphKind: "reasoning",
        type: "Vulnerability",
        label: "Hardcoded API key grants upload access",
        properties: { status: "confirmed" },
        evidenceRefs: ["o1"]
      }],
      edges: [{
        from: "new:1",
        to: "existing:1",
        type: "affects",
        evidenceRefs: ["o1"]
      }]
    }
  });

  assert.deepEqual(delta.sourceEventIds, ["event:1", "event:2", "event:3"]);
  assert.deepEqual(delta.nodes[0]?.evidenceRefs, ["event:1", "event:2", "event:3"]);
  assert.equal(delta.edges[0]?.to, "endpoint:upload");
  assert.deepEqual(delta.edges[0]?.evidenceRefs, ["event:1", "event:2", "event:3"]);
  assert.match(renderProjectionGraphContext(graphContext), /existing:1 operation\/WebEndpoint/);
});

test("projector cannot write task graph nodes or task edges", () => {
  const graphContext = aliasProjectionGraphContext({
    nodes: [{
      id: "task:read-flag",
      graphKind: "task",
      type: "Task",
      label: "Read flag",
      properties: { status: "partial" }
    }],
    edges: []
  });
  const delta = expandProjectionDraft({
    batch: {
      observations: [{
        ref: "o1",
        kind: "task_outcome",
        seqStart: 1,
        seqEnd: 1,
        outcomeDigest: "Flag is not yet available",
        status: "ok",
        artifactRefs: [],
        anchors: [],
        sourceEventIds: ["event:1"]
      }],
      toSeq: 1,
      sourceEventIds: ["event:1"]
    },
    graphContext,
    value: {
      nodes: [{
        id: "existing:1",
        graphKind: "task",
        type: "Milestone",
        label: "Incorrectly retyped task",
        properties: {},
        evidenceRefs: ["o1"]
      }, {
        id: "blocker:flag-missing",
        graphKind: "task",
        type: "Blocker",
        label: "Flag missing",
        properties: {},
        evidenceRefs: ["o1"]
      }],
      edges: [{ from: "existing:1", to: "blocker:flag-missing", type: "blocked_by", evidenceRefs: ["o1"] }]
    }
  });

  assert.deepEqual(delta.nodes, []);
  assert.deepEqual(delta.edges, []);
});

test("updates existing semantic nodes while preserving their identity", () => {
  const graphContext = aliasProjectionGraphContext({
    nodes: [{
      id: "evidence:access-denied",
      graphKind: "reasoning",
      type: "Evidence",
      label: "Access denied",
      properties: { count: 1 },
      evidenceRefs: ["event:old"]
    }],
    edges: []
  });
  const delta = expandProjectionDraft({
    batch: {
      observations: [{
        ref: "o1",
        kind: "action",
        seqStart: 1,
        seqEnd: 2,
        action: "bash",
        outcomeDigest: "A second request was denied",
        status: "ok",
        artifactRefs: [],
        anchors: [],
        sourceEventIds: ["event:new"]
      }],
      toSeq: 2,
      sourceEventIds: ["event:new"]
    },
    graphContext,
    value: {
      nodes: [{
        id: "existing:1",
        graphKind: "operation",
        type: "Host",
        label: "Repeated access denial",
        properties: { count: 2 },
        evidenceRefs: ["o1"]
      }],
      edges: []
    }
  });

  assert.deepEqual(delta.nodes, [{
    id: "evidence:access-denied",
    graphKind: "reasoning",
    type: "Evidence",
    label: "Repeated access denial",
    properties: { count: 2 },
    evidenceRefs: ["event:new"]
  }]);
});

test("new projector aliases receive runtime identities instead of colliding with graph ids", () => {
  const graphContext = aliasProjectionGraphContext({
    nodes: [{
      id: "new:13",
      graphKind: "reasoning",
      type: "Evidence",
      label: "Pre-existing semantic id",
      properties: {},
      evidenceRefs: ["event:old"]
    }],
    edges: []
  });
  const delta = expandProjectionDraft({
    batch: {
      observations: [{
        ref: "o1",
        kind: "action",
        seqStart: 1,
        seqEnd: 1,
        action: "bash",
        outcomeDigest: "Observed a new endpoint",
        status: "ok",
        artifactRefs: [],
        anchors: [],
        sourceEventIds: ["event:new"]
      }],
      toSeq: 1,
      sourceEventIds: ["event:new"]
    },
    graphContext,
    value: {
      nodes: [{
        id: "new:13",
        graphKind: "operation",
        type: "WebEndpoint",
        label: "/admin",
        properties: { method: "GET" },
        evidenceRefs: ["o1"]
      }],
      edges: []
    }
  });

  assert.equal(delta.nodes.length, 1);
  assert.match(delta.nodes[0]?.id ?? "", /^projected:/);
  assert.notEqual(delta.nodes[0]?.id, "new:13");
});

test("projector drops explicit global ids outside the alias boundary", () => {
  const delta = expandProjectionDraft({
    batch: {
      observations: [],
      toSeq: 0,
      sourceEventIds: []
    },
    graphContext: aliasProjectionGraphContext({ nodes: [], edges: [] }),
    value: {
      nodes: [{
        id: "evidence:model-chosen-global-id",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Invalid identity",
        properties: {}
      }],
      edges: []
    }
  });

  assert.deepEqual(delta.nodes, []);
});

test("planner observation digest preserves task outcomes and diverse earlier findings", () => {
  const observations: ProjectionObservation[] = Array.from({ length: 10 }, (_, index) => ({
    ref: `o${index + 1}`,
    kind: "action" as const,
    seqStart: index * 3 + 1,
    seqEnd: index * 3 + 3,
    intent: `intent ${index + 1}`,
    action: "bash",
    outcomeDigest: index === 2 ? "confirmed arbitrary file read" : `routine probe ${index + 1}`,
    status: "ok" as const,
    artifactRefs: [],
    anchors: index === 2 ? ["/sensitive/file"] : [],
    sourceEventIds: [`event:${index + 1}`]
  }));
  observations.push({
    ref: "o11",
    kind: "task_outcome",
    seqStart: 31,
    seqEnd: 31,
    outcomeDigest: "phase result confirms reusable file-read capability",
    status: "ok",
    artifactRefs: [],
    anchors: ["/sensitive/file"],
    sourceEventIds: ["event:11"]
  });

  const digest = observationDigest(observations, 1200);

  assert.match(digest, /confirmed arbitrary file read/);
  assert.match(digest, /phase result confirms reusable file-read capability/);
  assert.ok(digest.split("\n").length <= 6);
});

test("planner observation digest renders the latest task outcome before older actions", () => {
  const digest = observationDigest([
    {
      ref: "o1",
      kind: "action",
      seqStart: 1,
      seqEnd: 2,
      action: "bash",
      inputDigest: "enumerate many routine paths",
      outcomeDigest: "routine path enumeration returned no match",
      status: "ok",
      artifactRefs: [],
      anchors: ["/routine"],
      sourceEventIds: ["event:1", "event:2"]
    },
    {
      ref: "o2",
      kind: "task_outcome",
      seqStart: 3,
      seqEnd: 3,
      outcomeDigest: "Confirmed admin_token=internal_admin_token_2024 from the internal configuration endpoint",
      status: "ok",
      artifactRefs: [],
      anchors: ["/debug/config"],
      sourceEventIds: ["event:3"]
    }
  ], 180);

  assert.match(digest, /^o2:task_outcome:ok/);
  assert.match(digest, /admin_token=internal_admin_token_2024/);
});

test("capability digest preserves reusable action input and outcome", () => {
  const digest = capabilityDigest([{
    ref: "o1",
    kind: "action",
    seqStart: 1,
    seqEnd: 2,
    action: "bash",
    inputDigest: "curl -H 'X-Api-Key: key' /upload",
    outcomeDigest: "Upload accepted and stored at /files/poc.php",
    status: "ok",
    artifactRefs: ["artifact:poc"],
    anchors: ["/upload"],
    sourceEventIds: ["event:1", "event:2"]
  }]);

  assert.match(digest, /X-Api-Key/);
  assert.match(digest, /stored at \/files\/poc.php/);
  assert.match(digest, /artifact:poc/);
});

test("projection context preserves parallel edge identities and properties", () => {
  const nodes: GraphNode[] = [
    { id: "host:a", graphKind: "operation", type: "Host", label: "A", properties: { host: "a.test" } },
    { id: "host:b", graphKind: "operation", type: "Host", label: "B", properties: { host: "b.test" } }
  ];
  const context = aliasProjectionGraphContext({
    nodes,
    edges: [
      { id: "tunnel:first", from: "host:a", to: "host:b", type: "tunnels_to", properties: { tunnelId: "first", status: "live" } },
      { id: "tunnel:second", from: "host:a", to: "host:b", type: "tunnels_to", properties: { tunnelId: "second", status: "degraded" } }
    ]
  });

  assert.equal(context.edges.length, 2);
  assert.deepEqual(context.edges.map((edge) => edge.id), ["tunnel:first", "tunnel:second"]);
  assert.deepEqual(context.edges.map((edge) => edge.properties.tunnelId), ["first", "second"]);
  assert.match(renderProjectionGraphContext(context), /"tunnelId":"first"/);
  assert.match(renderProjectionGraphContext(context), /"status":"degraded"/);
});

test("projector derives stable tunnel and proxy route edge identities", () => {
  const graphContext = aliasProjectionGraphContext({
    nodes: [
      { id: "host:a", graphKind: "operation", type: "Host", label: "A", properties: { host: "a.test" } },
      { id: "host:b", graphKind: "operation", type: "Host", label: "B", properties: { host: "b.test" } }
    ],
    edges: []
  });
  const delta = expandProjectionDraft({
    batch: { observations: [], toSeq: 0, sourceEventIds: [] },
    graphContext,
    value: {
      nodes: [],
      edges: [
        { from: "existing:1", to: "existing:2", type: "tunnels_to", properties: { tunnelId: "ssh / primary", transport: "ssh" } },
        { from: "existing:1", to: "existing:2", type: "proxy_route", properties: { routeId: "route #1", via: "127.0.0.1:8080" } }
      ]
    }
  });

  assert.deepEqual(delta.edges.map((edge) => edge.id), ["tunnel:ssh%20%2F%20primary", "proxy-route:route%20%231"]);
  assert.equal(delta.edges[0]?.properties?.transport, "ssh");
  assert.equal(delta.edges[1]?.properties?.via, "127.0.0.1:8080");
});

test("canonical operation identities cover agent and shell sessions", () => {
  const graphContext = aliasProjectionGraphContext({ nodes: [], edges: [] });
  const delta = expandProjectionDraft({
    batch: { observations: [], toSeq: 0, sourceEventIds: [] },
    graphContext,
    value: {
      nodes: [
        { id: "new:1", graphKind: "operation", type: "AgentSession", label: "Renamed agent", properties: { agentSessionId: "agent-1" } },
        { id: "new:2", graphKind: "operation", type: "ShellSession", label: "Renamed shell", properties: { sessionId: "shell-1" } }
      ],
      edges: []
    }
  });

  assert.deepEqual(delta.nodes.map((node) => node.id), ["agent-session:agent-1", "shell-session:shell-1"]);
});

test("session labels without business ids do not determine identity", () => {
  const graphContext = aliasProjectionGraphContext({
    nodes: [{ id: "agent-session:existing", graphKind: "operation", type: "AgentSession", label: "Shared label", properties: {} }],
    edges: []
  });
  const delta = expandProjectionDraft({
    batch: { observations: [], toSeq: 0, sourceEventIds: [] },
    graphContext,
    value: {
      nodes: [
        { id: "new:1", graphKind: "operation", type: "AgentSession", label: "Shared label", properties: {} },
        { id: "new:2", graphKind: "operation", type: "AgentSession", label: "Shared label", properties: {} }
      ],
      edges: []
    }
  });

  assert.equal(delta.nodes.length, 2);
  assert.ok(delta.nodes.every((node) => node.id.startsWith("projected:")));
  assert.notEqual(delta.nodes[0]?.id, delta.nodes[1]?.id);
  assert.ok(delta.nodes.every((node) => node.id !== "agent-session:existing"));
});

function event(seq: number, id: string, eventType: string, payload: Record<string, unknown>): ExecutionEvent {
  return {
    id,
    seq,
    taskId: "task:test",
    role: "executor",
    eventType,
    timestamp: new Date(0).toISOString(),
    payload
  };
}
