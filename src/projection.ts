import { randomUUID } from "node:crypto";
import { stableSessionNodeId } from "./operation-identity.js";
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
  actions?: Array<{
    action: string;
    inputDigest?: string;
    outcomeDigest: string;
    status: "ok" | "error" | "incomplete";
  }>;
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
    id?: string;
    from: string;
    to: string;
    type: string;
    properties: Record<string, unknown>;
  }>;
  nodeAliases: Map<string, string>;
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
    const openIndexes = observations.flatMap((observation, index) => (
      observation.kind === "action"
        && (!observation.interpretation || observation.interpretation === LEGACY_RAW_RESULT_INTERPRETATION)
        ? [index]
        : []
    ));
    if (openIndexes.length === 0) {
      return;
    }
    const normalizedInterpretation = truncate(interpretation, 260);
    if (openIndexes.length === 1) {
      const observation = observations[openIndexes[0]!]!;
      observation.interpretation = normalizedInterpretation;
      observation.anchors = dedupeStrings([
        ...observation.anchors,
        ...extractAnchors(normalizedInterpretation)
      ]).slice(0, 6);
      return;
    }
    const grouped = openIndexes.map((index) => observations[index]!);
    const firstIndex = openIndexes[0]!;
    observations[firstIndex] = {
      ref: "",
      kind: "action",
      seqStart: Math.min(...grouped.map((observation) => observation.seqStart)),
      seqEnd: Math.max(...grouped.map((observation) => observation.seqEnd)),
      intent: grouped.find((observation) => observation.intent)?.intent,
      interpretation: normalizedInterpretation,
      action: "tool_group",
      outcomeDigest: `${grouped.length} tool results interpreted together`,
      status: grouped.some((observation) => observation.status === "error") ? "error" : "ok",
      artifactRefs: dedupeStrings(grouped.flatMap((observation) => observation.artifactRefs)),
      anchors: dedupeStrings([
        ...grouped.flatMap((observation) => observation.anchors),
        ...extractAnchors(normalizedInterpretation)
      ]).slice(0, 8),
      sourceEventIds: dedupeStrings(grouped.flatMap((observation) => observation.sourceEventIds)),
      actions: grouped.map((observation) => ({
        action: observation.action ?? "unknown",
        inputDigest: observation.inputDigest,
        outcomeDigest: observation.outcomeDigest,
        status: observation.status
      }))
    };
    const removedIndexes = new Set(openIndexes.slice(1));
    for (let index = observations.length - 1; index >= 0; index -= 1) {
      if (removedIndexes.has(index)) {
        observations.splice(index, 1);
      }
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
}): ProjectionGraphContext {
  const nodeAliases = new Map<string, string>();
  const nodes = input.nodes.map((node, index) => {
    const ref = `existing:${index + 1}`;
    nodeAliases.set(ref, node.id);
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
  const edges = input.edges
    .map((edge) => ({
      id: edge.id,
      from: aliasesByNodeId.get(edge.from) ?? "",
      to: aliasesByNodeId.get(edge.to) ?? "",
      type: edge.type,
      properties: compactNodeProperties(edge.properties ?? {})
    }))
    .filter((edge) => Boolean(edge.from && edge.to));
  return {
    nodes,
    edges,
    nodeAliases
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
      const resolvedId = existingId ?? (submittedRef.startsWith("new:")
          ? stableOperationNodeId(node) ?? `projected:${randomUUID()}`
          : "");
      if (!resolvedId) {
        continue;
      }
      if (!existingId) {
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
    ? draft.edges.filter(isRecord).slice(0, 20).map((edge) => {
      const type = String(edge.type ?? "supports");
      const properties = compactSubmittedProperties(edge.properties);
      return {
        id: stableOperationalEdgeId(type, properties),
        from: resolveNodeRef(edge.from),
        to: resolveNodeRef(edge.to),
        type,
        properties,
        evidenceRefs: resolveEvidenceRefs(edge.evidenceRefs)
      };
    }).filter((edge) => {
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
    ...(observation.actions ?? []).flatMap((action, index) => [
      `  tool[${index + 1}]: ${action.action} status=${action.status}`,
      action.inputDigest ? `    input: ${action.inputDigest}` : undefined,
      `    outcome: ${action.outcomeDigest}`
    ]),
    (observation.repeatCount ?? 1) > 1 ? `  repeated: ${observation.repeatCount}` : undefined,
    !observation.actions && observation.inputDigest ? `  input: ${observation.inputDigest}` : undefined,
    !observation.actions ? `  outcome: ${observation.outcomeDigest}` : undefined,
    observation.interpretation ? `  executor_interpretation: ${observation.interpretation}` : undefined,
    observation.artifactRefs.length > 0 ? `  artifacts: ${observation.artifactRefs.join(", ")}` : undefined,
    observation.anchors.length > 0 ? `  anchors: ${observation.anchors.join(", ")}` : undefined
  ].filter((line): line is string => Boolean(line)).join("\n")).join("\n");
}

export function compactProjectionBatchForInput(
  batch: ProjectionBatch,
  options: { maxObservations: number; maxChars: number }
): ProjectionBatch {
  const maxObservations = Math.max(1, options.maxObservations);
  const maxChars = Math.max(800, options.maxChars);
  const taskOutcome = [...batch.observations]
    .filter((observation) => observation.kind === "task_outcome")
    .sort((left, right) => right.seqEnd - left.seqEnd)[0];
  const remaining = batch.observations.filter((observation) => observation !== taskOutcome);
  const bucketLimit = Math.max(1, maxObservations - (taskOutcome ? 1 : 0));
  const grouped = remaining.length <= bucketLimit
    ? remaining
    : groupProjectionObservations(remaining, bucketLimit);
  const selected = taskOutcome ? [...grouped, taskOutcome] : grouped;
  const perObservationChars = Math.max(180, Math.floor(maxChars / Math.max(1, selected.length)) - 100);
  const observations = selected
    .sort((left, right) => left.seqEnd - right.seqEnd)
    .map((observation, index) => compactProjectionObservation(observation, perObservationChars, `o${index + 1}`));
  return {
    observations,
    toSeq: batch.toSeq,
    sourceEventIds: batch.sourceEventIds
  };
}

function groupProjectionObservations(
  observations: ProjectionObservation[],
  bucketLimit: number
): ProjectionObservation[] {
  const bucketSize = Math.ceil(observations.length / bucketLimit);
  const grouped: ProjectionObservation[] = [];
  for (let index = 0; index < observations.length; index += bucketSize) {
    const bucket = observations.slice(index, index + bucketSize);
    grouped.push({
      ref: "",
      kind: bucket.some((observation) => observation.kind === "runtime_error") ? "runtime_error" : "action",
      seqStart: Math.min(...bucket.map((observation) => observation.seqStart)),
      seqEnd: Math.max(...bucket.map((observation) => observation.seqEnd)),
      interpretation: "多个连续 observation 为适配 Projector 输入预算合并，按其中的因果摘要投影。",
      action: "observation_group",
      outcomeDigest: causalObservationDigest(bucket, 900),
      status: bucket.some((observation) => observation.status === "error") ? "error" : "ok",
      artifactRefs: dedupeStrings(bucket.flatMap((observation) => observation.artifactRefs)).slice(0, 8),
      anchors: dedupeStrings(bucket.flatMap((observation) => observation.anchors)).slice(0, 12),
      sourceEventIds: dedupeStrings(bucket.flatMap((observation) => observation.sourceEventIds)),
      repeatCount: bucket.length
    });
  }
  return grouped;
}

function compactProjectionObservation(
  observation: ProjectionObservation,
  maxChars: number,
  ref: string
): ProjectionObservation {
  const fieldLimit = Math.max(60, Math.floor(maxChars / 3));
  const actions = observation.actions?.slice(0, 8).map((action) => ({
    ...action,
    inputDigest: action.inputDigest ? compactHeadTail(action.inputDigest, Math.max(50, Math.floor(fieldLimit / 2))) : undefined,
    outcomeDigest: compactHeadTail(action.outcomeDigest, fieldLimit)
  }));
  return {
    ...observation,
    ref,
    intent: observation.intent ? compactHeadTail(observation.intent, fieldLimit) : undefined,
    interpretation: observation.interpretation ? compactHeadTail(observation.interpretation, fieldLimit) : undefined,
    inputDigest: observation.inputDigest ? compactHeadTail(observation.inputDigest, fieldLimit) : undefined,
    outcomeDigest: compactHeadTail(observation.outcomeDigest, actions ? Math.max(80, fieldLimit) : Math.max(120, fieldLimit * 2)),
    actions,
    artifactRefs: observation.artifactRefs.slice(0, 4),
    anchors: observation.anchors.slice(0, 8)
  };
}

export function renderProjectionGraphContext(context: ProjectionGraphContext): string {
  if (context.nodes.length === 0) {
    return "无已有相关图节点。";
  }
  const nodeLines = context.nodes.map((node) => (
    `${node.ref} ${node.graphKind}/${node.type} ${node.label}${Object.keys(node.properties).length > 0 ? ` ${JSON.stringify(node.properties)}` : ""}`
  ));
  const edgeLines = context.edges.map((edge) => (
    `${edge.from} -${edge.type}-> ${edge.to}${Object.keys(edge.properties).length > 0 ? ` ${JSON.stringify(edge.properties)}` : ""}`
  ));
  return [
    "相关图节点：",
    ...(nodeLines.length > 0 ? nodeLines : ["无"]),
    "可见拓扑：",
    ...(edgeLines.length > 0 ? edgeLines : ["无"])
  ].join("\n");
}

function stableOperationNodeId(node: Record<string, unknown>): string | undefined {
  if (normalizeGraphKind(node.graphKind) !== "operation") {
    return undefined;
  }
  return stableSessionNodeId({
    type: String(node.type ?? ""),
    properties: isRecord(node.properties) ? node.properties : {}
  });
}

function stableOperationalEdgeId(type: string, properties: Record<string, unknown>): string | undefined {
  if (type === "tunnels_to") {
    return stableIdentity("tunnel", properties.tunnelId);
  }
  if (type === "proxy_route") {
    return stableIdentity("proxy-route", properties.routeId);
  }
  return undefined;
}

function stableIdentity(prefix: string, value: unknown): string | undefined {
  const identity = typeof value === "string" ? value.trim() : "";
  return identity ? `${prefix}:${encodeURIComponent(identity)}` : undefined;
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
  if (left.kind !== "action" || right.kind !== "action" || left.actions || right.actions) {
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
    "blockerReason", "pendingCondition", "sessionId", "agentSessionId", "shellSessionId", "tunnelId", "routeId",
    "createdAt", "updatedAt", "lastSeenAt", "expiresAt", "closedAt", "transport", "localHost", "localPort",
    "remoteHost", "remotePort", "via"
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
