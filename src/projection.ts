import { randomUUID } from "node:crypto";
import type { ExecutionEvent, GraphDelta, GraphEdge, GraphNode } from "./types.js";

export type ProjectionObservationKind = "action" | "task_outcome" | "runtime_error";

const TASK_OUTCOME_EVENT_TYPES = new Set([
  "task_completed",
  "task_partial",
  "task_blocked",
  "task_failed"
]);

const LEGACY_RAW_RESULT_INTERPRETATION = "No recorded Executor interpretation; use only the raw result as evidence.";
const MISSING_RESULT_INTERPRETATION = "Executor continued without recording a conclusion for the previous result; treat it as inconclusive.";

export type ProjectionObservation = {
  ref: string;
  kind: ProjectionObservationKind;
  seqStart: number;
  seqEnd: number;
  intent?: string;
  interpretation?: string;
  action?: string;
  inputDigest?: string;
  outcomeDigest: string;
  status: "ok" | "error" | "incomplete";
  artifactRefs: string[];
  anchors: string[];
  sourceEventIds: string[];
  repeatCount?: number;
};

export type ProjectionBatch = {
  observations: ProjectionObservation[];
  toSeq: number;
  sourceEventIds: string[];
};

export type ProjectionGraphContext = {
  nodes: Array<{
    ref: string;
    id: string;
    graphKind: GraphNode["graphKind"];
    type: string;
    label: string;
    properties: Record<string, unknown>;
    evidenceRefs: string[];
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: string;
  }>;
  nodeAliases: Map<string, string>;
  identityOnlyRefs: Set<string>;
  identityIndexComplete: boolean;
};

type PendingAction = {
  seqStart: number;
  intent?: string;
  action: string;
  inputDigest?: string;
  sourceEventIds: string[];
  artifactRefs: string[];
};

export function buildProjectionObservations(events: ExecutionEvent[]): ProjectionObservation[] {
  const sortedEvents = [...events].sort((left, right) => eventSeq(left) - eventSeq(right));
  const pendingActions = new Map<string, PendingAction>();
  const observations: ProjectionObservation[] = [];
  let pendingIntent: { text: string; eventId: string; seq: number } | undefined;

  const closeOpenActions = (interpretation: string, _sourceEventId: string): void => {
    for (const observation of observations) {
      if (observation.kind !== "action" || (observation.interpretation
        && observation.interpretation !== LEGACY_RAW_RESULT_INTERPRETATION
        && observation.interpretation !== MISSING_RESULT_INTERPRETATION)) {
        continue;
      }
      observation.interpretation = truncate(interpretation, 260);
      observation.anchors = dedupeStrings([
        ...observation.anchors,
        ...extractAnchors(observation.interpretation)
      ]).slice(0, 6);
    }
  };

  for (const event of sortedEvents) {
    const seq = eventSeq(event);
    if (event.eventType === "assistant_intent") {
      const text = textProperty(event.payload.text) ?? textProperty(event.summary);
      if (text && !text.startsWith("assistant_intent:")) {
        closeOpenActions(text, event.id);
      }
      pendingIntent = text && !text.startsWith("assistant_intent:")
        ? { text: truncate(text, 140), eventId: event.id, seq }
        : undefined;
      continue;
    }

    if (event.eventType === "tool_started") {
      const toolCallId = textProperty(event.payload.toolCallId) ?? event.id;
      const action = textProperty(event.payload.toolName) ?? "unknown";
      const inputDigest = compactInputValue(event.payload.args);
      if (!isRuntimeContextAction(action, inputDigest, "")) {
        closeOpenActions(MISSING_RESULT_INTERPRETATION, event.id);
      }
      pendingActions.set(toolCallId, {
        seqStart: pendingIntent?.seq ?? seq,
        intent: pendingIntent?.text,
        action,
        inputDigest,
        sourceEventIds: dedupeStrings([
          ...(pendingIntent ? [pendingIntent.eventId] : []),
          event.id
        ]),
        artifactRefs: eventArtifactRefs(event)
      });
      pendingIntent = undefined;
      continue;
    }

    if (event.eventType === "tool_finished") {
      const toolCallId = textProperty(event.payload.toolCallId) ?? event.id;
      const action = textProperty(event.payload.toolName) ?? "unknown";
      const pending = pendingActions.get(toolCallId);
      pendingActions.delete(toolCallId);
      const inputDigest = pending?.inputDigest;
      const outcomeDigest = compactToolOutcome(event);
      const artifactRefs = dedupeStrings([
        ...(pending?.artifactRefs ?? []),
        ...eventArtifactRefs(event)
      ]);
      if (isRuntimeContextAction(action, inputDigest, outcomeDigest)) {
        continue;
      }
      observations.push({
        ref: "",
        kind: "action",
        seqStart: pending?.seqStart ?? seq,
        seqEnd: seq,
        intent: pending?.intent,
        action,
        inputDigest,
        outcomeDigest,
        interpretation: pending
          ? undefined
          : LEGACY_RAW_RESULT_INTERPRETATION,
        status: event.payload.isError === true ? "error" : "ok",
        artifactRefs,
        anchors: extractAnchors(`${inputDigest ?? ""}\n${outcomeDigest}`),
        sourceEventIds: dedupeStrings([...(pending?.sourceEventIds ?? []), event.id])
      });
      continue;
    }

    if (TASK_OUTCOME_EVENT_TYPES.has(event.eventType)) {
      closeOpenActions(compactTaskOutcome(event), event.id);
      observations.push({
        ref: "",
        kind: "task_outcome",
        seqStart: seq,
        seqEnd: seq,
        outcomeDigest: compactTaskOutcome(event),
        status: event.eventType === "task_failed" || event.eventType === "task_blocked" ? "error" : "ok",
        artifactRefs: eventArtifactRefs(event),
        anchors: extractAnchors(`${event.summary ?? ""}\n${compactValue(event.payload, 700) ?? ""}`),
        sourceEventIds: [event.id]
      });
      continue;
    }

    if (event.eventType === "provider_error") {
      closeOpenActions(event.summary ?? "Provider error interrupted result interpretation.", event.id);
      observations.push({
        ref: "",
        kind: "runtime_error",
        seqStart: seq,
        seqEnd: seq,
        outcomeDigest: truncate(event.summary ?? compactValue(event.payload, 700) ?? "Provider error", 700),
        status: "error",
        artifactRefs: eventArtifactRefs(event),
        anchors: [],
        sourceEventIds: [event.id]
      });
    }
  }

  return coalesceProjectionObservations(observations)
    .map((observation, index) => ({ ...observation, ref: `o${index + 1}` }));
}

export function selectProjectionBatch(
  events: ExecutionEvent[],
  options: { fromSeq: number; maxObservations?: number }
): ProjectionBatch {
  const sortedEvents = [...events].sort((left, right) => eventSeq(left) - eventSeq(right));
  const allObservations = buildProjectionObservations(sortedEvents);
  const projectableObservations = allObservations.filter(isClosedObservation);
  const observations = projectableObservations.slice(0, options.maxObservations ?? 4)
    .map((observation, index) => ({ ...observation, ref: `o${index + 1}` }));
  const hasMoreObservations = projectableObservations.length > observations.length;
  const firstIncompleteObservationSeq = allObservations
    .filter((observation) => !isClosedObservation(observation))
    .map((observation) => observation.seqStart)
    .sort((left, right) => left - right)[0];
  const pendingIntentSeq = pendingExecutorIntentSeq(sortedEvents);
  const firstIncompleteSeq = [firstIncompleteObservationSeq, pendingIntentSeq]
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right)[0];
  const lastSelectedSeq = observations.at(-1)?.seqEnd;
  const toSeq = lastSelectedSeq !== undefined
    ? hasMoreObservations
      ? lastSelectedSeq
      : firstIncompleteSeq !== undefined
        ? lastSelectedSeq
        : Math.max(lastSelectedSeq, sortedEvents.at(-1)?.seq ?? lastSelectedSeq)
    : firstIncompleteSeq !== undefined
      ? Math.max(options.fromSeq, firstIncompleteSeq - 1)
      : sortedEvents.at(-1)?.seq ?? options.fromSeq;
  return {
    observations,
    toSeq,
    sourceEventIds: dedupeStrings(observations.flatMap((observation) => observation.sourceEventIds))
  };
}

export function aliasProjectionGraphContext(input: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  identityNodes?: GraphNode[];
  identityEdges?: GraphEdge[];
  identityIndexComplete?: boolean;
}): ProjectionGraphContext {
  const localNodeIds = new Set(input.nodes.map((node) => node.id));
  const combinedNodes = [...new Map(
    [...input.nodes, ...(input.identityNodes ?? [])].map((node) => [node.id, node])
  ).values()];
  const nodeAliases = new Map<string, string>();
  const identityOnlyRefs = new Set<string>();
  const nodes = combinedNodes.map((node, index) => {
    const ref = `existing:${index + 1}`;
    nodeAliases.set(ref, node.id);
    if (!localNodeIds.has(node.id)) {
      identityOnlyRefs.add(ref);
    }
    return {
      ref,
      id: node.id,
      graphKind: node.graphKind,
      type: node.type,
      label: truncate(node.label, 120),
      properties: compactNodeProperties(node.properties),
      evidenceRefs: (node.evidenceRefs ?? []).slice(0, 4)
    };
  });
  const aliasesByNodeId = new Map([...nodeAliases.entries()].map(([alias, nodeId]) => [nodeId, alias]));
  const edges = [...new Map(
    [...input.edges, ...(input.identityEdges ?? [])]
      .map((edge) => [`${edge.from}\u0000${edge.type}\u0000${edge.to}`, edge])
  ).values()]
    .map((edge) => ({
      from: aliasesByNodeId.get(edge.from),
      to: aliasesByNodeId.get(edge.to),
      type: edge.type
    }))
    .filter((edge): edge is { from: string; to: string; type: string } => Boolean(edge.from && edge.to));
  return {
    nodes,
    edges,
    nodeAliases,
    identityOnlyRefs,
    identityIndexComplete: input.identityIndexComplete ?? true
  };
}

export function expandProjectionDraft(input: {
  value: unknown;
  batch: ProjectionBatch;
  graphContext: ProjectionGraphContext;
}): GraphDelta {
  const record = isRecord(input.value) ? input.value : {};
  const draft = isRecord(record.graphDelta) ? record.graphDelta : record;
  const observationRefs = new Map(input.batch.observations.map((observation) => [observation.ref, observation.sourceEventIds]));
  const sourceEventIds = new Set(input.batch.sourceEventIds);
  const resolveEvidenceRefs = (value: unknown): string[] => dedupeStrings(
    stringArray(value).flatMap((ref) => observationRefs.get(ref) ?? (sourceEventIds.has(ref) ? [ref] : []))
  );
  const existingNodesById = new Map(input.graphContext.nodes.map((node) => [node.id, node]));
  const operationIdentityIndex = buildOperationIdentityIndex(input.graphContext.nodes);
  const submittedNodeRefs = new Map<string, string>();
  const resolveNodeRef = (value: unknown): string => {
    const ref = String(value ?? "").trim();
    if (!ref) {
      return "";
    }
    const existingId = input.graphContext.nodeAliases.get(ref);
    if (existingId) {
      return existingId;
    }
    return submittedNodeRefs.get(ref) ?? "";
  };
  const nodesById = new Map<string, GraphNode>();
  if (Array.isArray(draft.nodes)) {
    for (const node of draft.nodes.filter(isRecord).slice(0, 12)) {
      const submittedRef = String(node.id ?? "").trim();
      const existingId = input.graphContext.nodeAliases.get(submittedRef);
      const matchedOperationId = !existingId && submittedRef.startsWith("new:")
        ? matchExistingOperationNode(node, operationIdentityIndex)
        : undefined;
      const resolvedId = existingId ?? matchedOperationId
        ?? (submittedRef.startsWith("new:") ? `projected:${randomUUID()}` : "");
      if (!resolvedId) {
        continue;
      }
      if (!existingId || matchedOperationId) {
        submittedNodeRefs.set(submittedRef, resolvedId);
      }
      const existing = existingNodesById.get(resolvedId);
      const type = existing?.type ?? String(node.type ?? "Evidence");
      if (existing?.graphKind === "task" || normalizeGraphKind(node.graphKind) === "task") {
        continue;
      }
      const nextNode: GraphNode = {
        id: resolvedId,
        graphKind: existing?.graphKind ?? normalizeGraphKind(node.graphKind),
        type,
        label: truncate(String(node.label ?? existing?.label ?? node.id ?? "Observation"), 500),
        properties: compactSubmittedProperties(node.properties),
        evidenceRefs: resolveEvidenceRefs(node.evidenceRefs)
      };
      const previous = nodesById.get(resolvedId);
      nodesById.set(resolvedId, previous ? {
        ...nextNode,
        properties: { ...previous.properties, ...nextNode.properties },
        evidenceRefs: dedupeStrings([...(previous.evidenceRefs ?? []), ...(nextNode.evidenceRefs ?? [])])
      } : nextNode);
    }
  }
  const nodes = [...nodesById.values()];
  const nodeById = new Map<string, GraphNode>([
    ...[...existingNodesById.entries()].map(([nodeId, node]) => [nodeId, {
      id: node.id,
      graphKind: node.graphKind,
      type: node.type,
      label: node.label,
      properties: node.properties,
      evidenceRefs: node.evidenceRefs
    }] as const),
    ...nodes.map((node) => [node.id, node] as const)
  ]);
  const edges = Array.isArray(draft.edges)
    ? draft.edges.filter(isRecord).slice(0, 20).map((edge) => ({
      from: resolveNodeRef(edge.from),
      to: resolveNodeRef(edge.to),
      type: String(edge.type ?? "supports"),
      evidenceRefs: resolveEvidenceRefs(edge.evidenceRefs)
    })).filter((edge) => {
      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);
      return Boolean(fromNode && toNode)
        && fromNode?.graphKind !== "task"
        && toNode?.graphKind !== "task";
    })
    : [];
  return {
    sourceEventIds: input.batch.sourceEventIds,
    nodes,
    edges
  };
}

export function renderProjectionObservations(observations: ProjectionObservation[]): string {
  if (observations.length === 0) {
    return "无可投影 observation。";
  }
  return observations.map((observation) => [
    `${observation.ref} [${observation.kind}] seq=${observation.seqStart}-${observation.seqEnd} status=${observation.status}`,
    observation.intent ? `  intent: ${observation.intent}` : undefined,
    observation.action ? `  action: ${observation.action}` : undefined,
    (observation.repeatCount ?? 1) > 1 ? `  repeated: ${observation.repeatCount}` : undefined,
    observation.inputDigest ? `  input: ${observation.inputDigest}` : undefined,
    `  outcome: ${observation.outcomeDigest}`,
    observation.interpretation ? `  executor_interpretation: ${observation.interpretation}` : undefined,
    observation.artifactRefs.length > 0 ? `  artifacts: ${observation.artifactRefs.join(", ")}` : undefined,
    observation.anchors.length > 0 ? `  anchors: ${observation.anchors.join(", ")}` : undefined
  ].filter((line): line is string => Boolean(line)).join("\n")).join("\n");
}

export function renderProjectionGraphContext(context: ProjectionGraphContext): string {
  if (context.nodes.length === 0) {
    return "无已有相关图节点。";
  }
  const localNodeLines = context.nodes
    .filter((node) => !context.identityOnlyRefs.has(node.ref))
    .map((node) => (
    `${node.ref} ${node.graphKind}/${node.type} ${node.label}${Object.keys(node.properties).length > 0 ? ` ${JSON.stringify(node.properties)}` : ""}`
  ));
  const identityLines = context.nodes
    .filter((node) => context.identityOnlyRefs.has(node.ref))
    .map((node) => `${node.ref} ${node.type} ${operationIdentitySummary(node)}`);
  const edgeLines = context.edges.map((edge) => `${edge.from} -${edge.type}-> ${edge.to}`);
  return [
    "局部完整节点：",
    ...(localNodeLines.length > 0 ? localNodeLines : ["无"]),
    context.identityIndexComplete ? "全量作战身份索引：" : "作战身份索引（已按输入预算截断）：",
    ...(identityLines.length > 0 ? identityLines : ["无额外节点"]),
    "可见拓扑：",
    ...(edgeLines.length > 0 ? edgeLines : ["无"])
  ].join("\n");
}

type OperationIdentityIndex = Map<string, string>;

function buildOperationIdentityIndex(nodes: ProjectionGraphContext["nodes"]): OperationIdentityIndex {
  const index = new Map<string, string>();
  for (const node of nodes) {
    const key = operationIdentityKey(node.type, node.label, node.properties);
    if (key && !index.has(key)) {
      index.set(key, node.id);
    }
  }
  return index;
}

function matchExistingOperationNode(
  node: Record<string, unknown>,
  index: OperationIdentityIndex
): string | undefined {
  if (normalizeGraphKind(node.graphKind) !== "operation") {
    return undefined;
  }
  const key = operationIdentityKey(
    String(node.type ?? ""),
    String(node.label ?? ""),
    isRecord(node.properties) ? node.properties : {}
  );
  return key ? index.get(key) : undefined;
}

function operationIdentitySummary(node: ProjectionGraphContext["nodes"][number]): string {
  const key = operationIdentityKey(node.type, node.label, node.properties);
  return key ? `${node.label} key=${key}` : node.label;
}

function operationIdentityKey(
  type: string,
  label: string,
  properties: Record<string, unknown>
): string | undefined {
  if (type === "Host") {
    const host = normalizedHost(properties.host ?? properties.hostname ?? properties.ip ?? properties.url ?? label);
    return host ? `host:${host}` : undefined;
  }
  if (type === "Port") {
    const endpoint = normalizedNetworkEndpoint(properties, label);
    return endpoint?.host && endpoint.port
      ? `port:${endpoint.host}:${endpoint.port}/${endpoint.protocol ?? "tcp"}`
      : undefined;
  }
  if (type === "Service") {
    const endpoint = normalizedNetworkEndpoint(properties, label);
    const protocol = normalizedProtocol(properties.protocol ?? properties.service ?? endpoint?.protocol);
    return endpoint?.host && endpoint.port && protocol
      ? `service:${endpoint.host}:${endpoint.port}/${protocol}`
      : undefined;
  }
  if (type === "WebEndpoint") {
    const url = normalizedUrl(properties.url);
    const host = url?.hostname ?? normalizedHost(properties.host ?? properties.hostname);
    const port = url?.port || normalizedPort(properties.port) || defaultPort(url?.protocol);
    const protocol = normalizedProtocol(url?.protocol ?? properties.protocol ?? properties.scheme);
    const path = normalizedPath(url?.pathname ?? properties.path);
    const method = String(properties.method ?? methodFromLabel(label) ?? "GET").trim().toUpperCase();
    return host && port && protocol && path
      ? `endpoint:${protocol}://${host}:${port}:${method}:${path}`
      : undefined;
  }
  if (type === "Parameter") {
    const name = String(properties.name ?? "").trim().toLowerCase();
    const location = String(properties.location ?? properties.in ?? "").trim().toLowerCase();
    const endpoint = normalizedUrl(properties.endpoint ?? properties.url);
    const path = normalizedPath(endpoint?.pathname ?? properties.path);
    const host = endpoint?.hostname ?? normalizedHost(properties.host ?? properties.hostname);
    const port = endpoint?.port || normalizedPort(properties.port) || defaultPort(endpoint?.protocol);
    const protocol = normalizedProtocol(endpoint?.protocol ?? properties.protocol ?? properties.scheme);
    return name && location && host && port && protocol && path
      ? `parameter:${protocol}://${host}:${port}:${path}:${location}:${name}`
      : undefined;
  }
  return undefined;
}

function normalizedNetworkEndpoint(
  properties: Record<string, unknown>,
  _label: string
): { host?: string; port?: string; protocol?: string } | undefined {
  const url = normalizedUrl(properties.url);
  const host = url?.hostname ?? normalizedHost(properties.host ?? properties.hostname);
  const port = url?.port || normalizedPort(properties.port);
  const protocol = normalizedProtocol(url?.protocol ?? properties.protocol ?? properties.service);
  return host || port || protocol ? { host, port, protocol } : undefined;
}

function normalizedUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  try {
    return new URL(value.trim());
  } catch {
    return undefined;
  }
}

function normalizedHost(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  const parsed = normalizedUrl(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
  const host = parsed?.hostname || trimmed.replace(/^\[|\]$/g, "").split(":")[0];
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return normalized || undefined;
}

function normalizedPort(value: unknown): string | undefined {
  const port = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return /^\d{1,5}$/.test(port) ? String(Number(port)) : undefined;
}

function normalizedProtocol(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const protocol = value.trim().toLowerCase().replace(/:$/, "");
  return protocol || undefined;
}

function defaultPort(protocol: string | undefined): string | undefined {
  return protocol === "https:" || protocol === "https" ? "443"
    : protocol === "http:" || protocol === "http" ? "80"
      : undefined;
}

function normalizedPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const path = value.trim().split(/[?#]/, 1)[0].replace(/\/{2,}/g, "/");
  return path.startsWith("/") ? path : `/${path}`;
}

function methodFromLabel(label: string): string | undefined {
  const match = label.trim().match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i);
  return match?.[1];
}

export function observationDigest(observations: ProjectionObservation[], maxChars = 900, limit = 6): string {
  const selected = selectDecisionObservations(observations, limit);
  return truncate(selected.map((observation) => [
    `${observation.ref}:${observation.action ?? observation.kind}:${observation.status}`,
    observation.intent ? `intent=${observation.intent}` : undefined,
    observation.inputDigest ? `input=${observation.inputDigest}` : undefined,
    observation.interpretation ? `interpretation=${observation.interpretation}` : undefined,
    (observation.repeatCount ?? 1) > 1 ? `repeated=${observation.repeatCount}` : undefined,
    `outcome=${observation.outcomeDigest}`,
    observation.anchors.length > 0 ? `anchors=${observation.anchors.join(",")}` : undefined
  ].filter((part): part is string => Boolean(part)).join(" ")).join("\n"), maxChars);
}

export function causalObservationDigest(observations: ProjectionObservation[], maxChars = 6_000): string {
  if (observations.length === 0 || maxChars <= 0) {
    return "";
  }
  const ordered = [...observations].sort((left, right) => left.seqEnd - right.seqEnd);
  const perObservationChars = Math.max(48, Math.min(320, Math.floor(maxChars / ordered.length) - 8));
  return ordered.map((observation) => {
    const interpretationFirst = observation.interpretation && !isRuntimeInterruptionInterpretation(observation.interpretation);
    return truncate([
      `${observation.ref}:${observation.action ?? observation.kind}:${observation.status}`,
      interpretationFirst ? `interpretation=${observation.interpretation}` : `outcome=${observation.outcomeDigest}`,
      interpretationFirst ? `outcome=${observation.outcomeDigest}` : observation.interpretation ? `interpretation=${observation.interpretation}` : undefined,
      observation.anchors.length > 0 ? `anchors=${observation.anchors.join(",")}` : undefined
    ].filter((part): part is string => Boolean(part)).join(" "), perObservationChars);
  }).join("\n");
}

function isRuntimeInterruptionInterpretation(value: string): boolean {
  return value === LEGACY_RAW_RESULT_INTERPRETATION
    || value === MISSING_RESULT_INTERPRETATION
    || value.startsWith("provider_error:")
    || value.startsWith("Provider error");
}

export function capabilityDigest(observations: ProjectionObservation[], maxChars = 1200): string {
  const selected = selectDecisionObservations(
    observations.filter((observation) => observation.kind === "task_outcome" || observation.status === "ok"),
    4
  );
  if (selected.length === 0) {
    return "";
  }
  return truncate(selected.map((observation) => [
    observation.action ? `action=${observation.action}` : `kind=${observation.kind}`,
    observation.inputDigest ? `input=${observation.inputDigest}` : undefined,
    `outcome=${observation.outcomeDigest}`,
    (observation.repeatCount ?? 1) > 1 ? `repeated=${observation.repeatCount}` : undefined,
    observation.artifactRefs.length > 0 ? `artifacts=${observation.artifactRefs.join(",")}` : undefined
  ].filter((part): part is string => Boolean(part)).join(" ")).join("\n"), maxChars);
}

function selectDecisionObservations(
  observations: ProjectionObservation[],
  limit: number
): ProjectionObservation[] {
  if (limit <= 0) {
    return [];
  }
  const latestTaskOutcome = observations
    .filter((observation) => observation.kind === "task_outcome")
    .sort((left, right) => right.seqEnd - left.seqEnd)[0];
  const newestByFingerprint = new Map<string, ProjectionObservation>();
  for (const observation of observations.filter((candidate) => candidate.kind !== "task_outcome")) {
    const fingerprint = [
      observation.kind,
      observation.action ?? "",
      observation.status,
      observation.anchors.join("|")
    ].join(":");
    newestByFingerprint.set(fingerprint, observation);
  }
  const maxSeq = Math.max(1, ...observations.map((observation) => observation.seqEnd));
  const remainingLimit = Math.max(0, limit - (latestTaskOutcome ? 1 : 0));
  const selected = [...newestByFingerprint.values()]
    .map((observation) => ({
      observation,
      score: decisionObservationScore(observation, maxSeq)
    }))
    .sort((left, right) => right.score - left.score || right.observation.seqEnd - left.observation.seqEnd)
    .slice(0, remainingLimit)
    .map((entry) => entry.observation);
  return latestTaskOutcome ? [latestTaskOutcome, ...selected] : selected;
}

function decisionObservationScore(
  observation: ProjectionObservation,
  maxSeq: number
): number {
  const kindScore = observation.kind === "task_outcome"
    ? 100
    : observation.kind === "runtime_error"
      ? 70
      : 20;
  const structuralScore = Math.min(observation.anchors.length, 5) * 8
    + Math.min(observation.artifactRefs.length, 3) * 4
    + (observation.intent ? 3 : 0)
    + (observation.status === "error" ? 2 : 0);
  const recencyScore = (observation.seqEnd / maxSeq) * 10;
  return kindScore + structuralScore + recencyScore;
}

function compactToolOutcome(event: ExecutionEvent): string {
  const result = event.payload.result;
  return compactHeadTail(toolResultText(result) ?? event.summary ?? "Tool completed", 700);
}

function compactInputValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return compactHeadTail(value, 320);
  }
  try {
    return compactHeadTail(JSON.stringify(value), 320);
  } catch {
    return compactHeadTail(String(value), 320);
  }
}

function compactTaskOutcome(event: ExecutionEvent): string {
  const taskResult = isRecord(event.payload.taskResult) ? event.payload.taskResult : undefined;
  return compactHeadTail(
    textProperty(taskResult?.summary)
      ?? event.summary
      ?? compactValue(event.payload, 700)
      ?? event.eventType,
    520
  );
}

function compactValue(value: unknown, maxChars: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return truncate(value.replace(/\s+/g, " ").trim(), maxChars);
  }
  try {
    return truncate(JSON.stringify(value), maxChars);
  } catch {
    return truncate(String(value), maxChars);
  }
}

function toolResultText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeWhitespace(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map(toolResultText).filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  if (!isRecord(value)) {
    return value === undefined || value === null ? undefined : String(value);
  }
  if (typeof value.text === "string") {
    return normalizeWhitespace(value.text);
  }
  const preferredKeys = ["content", "stdout", "stderr", "output", "body", "message"];
  const preferredParts = preferredKeys
    .map((key) => toolResultText(value[key]))
    .filter((part): part is string => Boolean(part));
  if (preferredParts.length > 0) {
    return preferredParts.join(" ");
  }
  try {
    return normalizeWhitespace(JSON.stringify(value));
  } catch {
    return normalizeWhitespace(String(value));
  }
}

function coalesceProjectionObservations(observations: ProjectionObservation[]): ProjectionObservation[] {
  const coalesced: ProjectionObservation[] = [];
  for (const observation of observations) {
    const previous = coalesced.at(-1);
    if (!previous || !canCoalesceObservations(previous, observation)) {
      coalesced.push({ ...observation, repeatCount: observation.repeatCount ?? 1 });
      continue;
    }
    const repeatCount = (previous.repeatCount ?? 1) + (observation.repeatCount ?? 1);
    coalesced[coalesced.length - 1] = {
      ...previous,
      seqEnd: observation.seqEnd,
      intent: observation.intent ?? previous.intent,
      interpretation: observation.interpretation ?? previous.interpretation,
      inputDigest: mergeObservationInputs(previous.inputDigest, observation.inputDigest, repeatCount),
      artifactRefs: dedupeStrings([...previous.artifactRefs, ...observation.artifactRefs]),
      anchors: dedupeStrings([...previous.anchors, ...observation.anchors]).slice(0, 4),
      sourceEventIds: dedupeStrings([...previous.sourceEventIds, ...observation.sourceEventIds]),
      repeatCount
    };
  }
  return coalesced;
}

function canCoalesceObservations(left: ProjectionObservation, right: ProjectionObservation): boolean {
  if (left.kind !== "action" || right.kind !== "action") {
    return false;
  }
  return left.action === right.action
    && left.status === right.status
    && semanticFingerprint(left.outcomeDigest) === semanticFingerprint(right.outcomeDigest)
    && semanticFingerprint(left.anchors.join("|")) === semanticFingerprint(right.anchors.join("|"));
}

function isClosedObservation(observation: ProjectionObservation): boolean {
  return observation.kind !== "action" || Boolean(observation.interpretation);
}

function pendingExecutorIntentSeq(events: ExecutionEvent[]): number | undefined {
  let pendingSeq: number | undefined;
  for (const event of events) {
    if (event.eventType === "assistant_intent") {
      const text = textProperty(event.payload.text) ?? textProperty(event.summary);
      pendingSeq = text && !text.startsWith("assistant_intent:") ? eventSeq(event) : undefined;
      continue;
    }
    if (event.eventType === "tool_started") {
      pendingSeq = undefined;
      continue;
    }
    if (TASK_OUTCOME_EVENT_TYPES.has(event.eventType) || event.eventType === "provider_error") {
      pendingSeq = undefined;
    }
  }
  return pendingSeq;
}

function mergeObservationInputs(left: string | undefined, right: string | undefined, repeatCount: number): string | undefined {
  if (!left) {
    return right;
  }
  if (!right || left === right) {
    return left;
  }
  return compactHeadTail(`variants=${repeatCount}; first=${left}; latest=${right}`, 320);
}

function semanticFingerprint(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compactHeadTail(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const marker = ` ...[${normalized.length - maxChars} chars omitted]... `;
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available * 0.55);
  const tailLength = Math.max(0, available - headLength);
  return `${normalized.slice(0, headLength)}${marker}${normalized.slice(-tailLength)}`;
}

function compactNodeProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const allowedKeys = [
    "status", "host", "hostname", "ip", "port", "protocol", "scheme", "service", "url", "endpoint", "path", "method",
    "name", "location", "in", "username", "role", "valid", "confidence", "resultSummary", "checkpointReason",
    "blockerReason", "pendingCondition"
  ];
  return Object.fromEntries(allowedKeys
    .filter((key) => properties[key] !== undefined)
    .map((key) => [key, compactContextPropertyValue(key, properties[key])]));
}

function compactContextPropertyValue(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    const limit = key === "resultSummary" ? 140 : ["checkpointReason", "blockerReason"].includes(key) ? 100 : 120;
    return truncate(value.replace(/\s+/g, " ").trim(), limit);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 6).map((item) => typeof item === "string" ? truncate(item, 100) : item);
  }
  return compactPropertyValue(value);
}

function compactSubmittedProperties(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, propertyValue]) => [
    truncate(key, 80),
    compactPropertyValue(propertyValue)
  ]));
}

function compactPropertyValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncate(value, 600);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map(compactPropertyValue);
  }
  return truncate(compactValue(value, 600) ?? "", 600);
}

function eventArtifactRefs(event: ExecutionEvent): string[] {
  return dedupeStrings([
    ...(event.artifactRefs ?? []),
    ...artifactRefsFromValue(event.payload)
  ]);
}

function artifactRefsFromValue(value: unknown): string[] {
  if (typeof value === "string") {
    return value.startsWith("artifact:") ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(artifactRefsFromValue);
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, propertyValue]) => (
    key === "artifactRef" && typeof propertyValue === "string"
      ? [propertyValue]
      : artifactRefsFromValue(propertyValue)
  ));
}

function extractAnchors(value: string): string[] {
  const anchors: string[] = [];
  for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    const url = trimPunctuation(match[0]);
    anchors.push(url);
    try {
      const parsed = new URL(url);
      anchors.push(parsed.host, parsed.hostname, parsed.pathname);
    } catch {
      // Ignore malformed URL-like strings.
    }
  }
  for (const match of value.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g)) {
    anchors.push(match[0]);
  }
  for (const match of value.matchAll(/\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+/g)) {
    const path = trimPunctuation(match[0]);
    if (!path.startsWith("//") && path.length >= 2) {
      anchors.push(path);
    }
  }
  return dedupeStrings(anchors).slice(0, 4);
}

function isRuntimeContextAction(action: string, inputDigest?: string, outcomeDigest?: string): boolean {
  if (!["read", "grep", "find", "ls", "bash"].includes(action)) {
    return false;
  }
  const normalized = `${inputDigest ?? ""} ${outcomeDigest ?? ""}`.toLowerCase();
  return normalized.includes("/.agents/skills/")
    || normalized.includes("/.codex/skills/")
    || normalized.includes("agents.md")
    || normalized.includes(".agent-runtime")
    || normalized.includes("node_modules")
    || normalized.includes("package-lock.json")
    || normalized.includes("tsconfig.json")
    || /\brecon_a\d*\b/.test(normalized)
    || normalized.includes("system prompt")
    || normalized.includes("observer_projector_system_prompt");
}

function normalizeGraphKind(value: unknown): GraphNode["graphKind"] {
  return value === "operation" || value === "task" ? value : "reasoning";
}

function eventSeq(event: ExecutionEvent): number {
  return typeof event.seq === "number" ? event.seq : 0;
}

function textProperty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function trimPunctuation(value: string): string {
  return value.replace(/[),.;:]+$/g, "");
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 18))}...[truncated]`;
}
