import { appendFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { toJsonLine } from "../json.js";
import type { AgentRole, ExecutionEvent, JsonObject } from "../types.js";

type ExecutionEventRow = {
  seq: number;
  id: string;
  epoch_id: string | null;
  task_id: string | null;
  role: AgentRole | "runtime";
  event_type: string;
  timestamp: string;
  summary: string | null;
  payload_json: string;
  artifact_refs_json: string;
};

export class ExecutionLog {
  readonly filePath: string;
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private readonly listeners = new Set<(event: ExecutionEvent) => void>();
  private mirrorWriteChain: Promise<void> = Promise.resolve();

  constructor(filePath: string, databasePath = join(dirname(filePath), "state.sqlite")) {
    this.filePath = filePath;
    this.databasePath = databasePath;
    mkdirSync(dirname(databasePath), { recursive: true });
    mkdirSync(dirname(filePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.initialize();
    this.importLegacyJsonl();
  }

  close(): void {
    this.database.close();
  }

  async drain(): Promise<void> {
    await this.mirrorWriteChain;
  }

  subscribe(listener: (event: ExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async append(input: {
    epochId?: string;
    taskId?: string;
    role: AgentRole | "runtime";
    eventType: string;
    summary?: string;
    payload: JsonObject;
    artifactRefs?: string[];
  }): Promise<ExecutionEvent> {
    const baseEvent = {
      id: `event:${randomUUID()}`,
      epochId: input.epochId,
      taskId: input.taskId,
      role: input.role,
      eventType: input.eventType,
      timestamp: new Date().toISOString(),
      summary: input.summary,
      payload: input.payload,
      artifactRefs: input.artifactRefs
    };
    const result = this.database.prepare(`
      INSERT INTO execution_events (
        id, epoch_id, task_id, role, event_type, timestamp,
        summary, payload_json, artifact_refs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      baseEvent.id,
      baseEvent.epochId ?? null,
      baseEvent.taskId ?? null,
      baseEvent.role,
      baseEvent.eventType,
      baseEvent.timestamp,
      baseEvent.summary ?? null,
      JSON.stringify(baseEvent.payload),
      JSON.stringify(baseEvent.artifactRefs ?? [])
    );
    const event: ExecutionEvent = {
      ...baseEvent,
      seq: Number(result.lastInsertRowid)
    };
    const mirrorWrite = this.mirrorWriteChain.then(() => appendFile(this.filePath, toJsonLine(event)));
    this.mirrorWriteChain = mirrorWrite.then(() => undefined, () => undefined);
    await mirrorWrite;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
    return event;
  }

  async window(input: {
    taskId?: string;
    epochId?: string;
    cursor?: string;
    limit: number;
    eventTypes?: string[];
    roles?: Array<AgentRole | "runtime">;
  }): Promise<{ events: ExecutionEvent[]; nextCursor?: string }> {
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.taskId) {
      where.push("task_id = ?");
      parameters.push(input.taskId);
    }
    if (input.epochId) {
      where.push("epoch_id = ?");
      parameters.push(input.epochId);
    }
    if (input.eventTypes && input.eventTypes.length > 0) {
      where.push(`event_type IN (${input.eventTypes.map(() => "?").join(",")})`);
      parameters.push(...input.eventTypes);
    }
    if (input.roles && input.roles.length > 0) {
      where.push(`role IN (${input.roles.map(() => "?").join(",")})`);
      parameters.push(...input.roles);
    }
    if (input.cursor) {
      const cursor = this.database.prepare("SELECT seq FROM execution_events WHERE id = ?")
        .get(input.cursor) as { seq: number } | undefined;
      if (cursor) {
        where.push("seq > ?");
        parameters.push(Number(cursor.seq));
      }
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const order = input.cursor ? "ASC" : "DESC";
    const rows = this.database.prepare(`
      SELECT * FROM execution_events ${whereSql} ORDER BY seq ${order} LIMIT ?
    `).all(...parameters, Math.max(0, input.limit)) as ExecutionEventRow[];
    const events = (input.cursor ? rows : rows.reverse()).map(rowToEvent);
    return {
      events,
      nextCursor: events.at(-1)?.id
    };
  }

  async range(input: {
    taskId: string;
    afterSeq: number;
    toSeq: number;
    roles?: Array<AgentRole | "runtime">;
    eventTypes?: string[];
  }): Promise<ExecutionEvent[]> {
    const where = ["task_id = ?", "seq > ?", "seq <= ?"];
    const parameters: Array<string | number> = [input.taskId, input.afterSeq, input.toSeq];
    if (input.roles && input.roles.length > 0) {
      where.push(`role IN (${input.roles.map(() => "?").join(",")})`);
      parameters.push(...input.roles);
    }
    if (input.eventTypes && input.eventTypes.length > 0) {
      where.push(`event_type IN (${input.eventTypes.map(() => "?").join(",")})`);
      parameters.push(...input.eventTypes);
    }
    const rows = this.database.prepare(`
      SELECT * FROM execution_events WHERE ${where.join(" AND ")} ORDER BY seq ASC
    `).all(...parameters) as ExecutionEventRow[];
    return rows.map(rowToEvent);
  }

  latestSeq(taskId?: string): number {
    const row = taskId
      ? this.database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM execution_events WHERE task_id = ?").get(taskId)
      : this.database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM execution_events").get();
    return Number((row as { seq: number }).seq);
  }

  seqForEvent(eventId: string): number | undefined {
    const row = this.database.prepare("SELECT seq FROM execution_events WHERE id = ?")
      .get(eventId) as { seq: number } | undefined;
    return row ? Number(row.seq) : undefined;
  }

  async readAll(): Promise<ExecutionEvent[]> {
    const rows = this.database.prepare("SELECT * FROM execution_events ORDER BY seq ASC").all() as ExecutionEventRow[];
    return rows.map(rowToEvent);
  }

  metrics(afterSeq = 0): Record<string, unknown> {
    const rows = this.database.prepare(`
      SELECT * FROM execution_events WHERE seq >= ? ORDER BY seq ASC
    `).all(Math.max(0, afterSeq)) as ExecutionEventRow[];
    const events = rows.map(rowToEvent);
    const byRole: Record<string, number> = {};
    const byEventType: Record<string, number> = {};
    const taskOutcomes: Record<string, number> = {};
    const turnUsage = createUsageAccumulator();
    const invocationUsage = createUsageAccumulator();
    const turnUsageByModel: Record<string, ReturnType<typeof createUsageAccumulator>> = {};
    const invocationByKind: Record<string, ReturnType<typeof createInvocationAccumulator>> = {};
    const invocationByStatus: Record<string, number> = {};
    const invocationDurationMs = createNumberAccumulator();
    const invocationInputBytes = createNumberAccumulator();
    const toolCallsByName: Record<string, number> = {};
    const toolErrorsByName: Record<string, number> = {};
    const providerErrorsByKind: Record<string, number> = {};
    const projector = {
      inputsBuilt: 0,
      succeeded: 0,
      failed: 0,
      discarded: 0,
      observations: 0,
      inputBytes: createNumberAccumulator(),
      durationMs: createNumberAccumulator(),
      graphNodes: 0,
      graphEdges: 0
    };
    const supervisor = {
      started: 0,
      succeeded: 0,
      failed: 0,
      discarded: 0,
      decisions: {} as Record<string, number>
    };
    let toolCalls = 0;
    let toolErrors = 0;
    let providerErrors = 0;
    let metricsCollectionFailures = 0;
    let turnsWithUsage = 0;
    let invocationCount = 0;

    for (const event of events) {
      byRole[event.role] = (byRole[event.role] ?? 0) + 1;
      byEventType[event.eventType] = (byEventType[event.eventType] ?? 0) + 1;
      if (event.eventType === "tool_started") {
        toolCalls += 1;
        const toolName = stringValue(event.payload.toolName) ?? "unknown";
        toolCallsByName[toolName] = (toolCallsByName[toolName] ?? 0) + 1;
      }
      if (event.eventType === "tool_finished" && event.payload.isError === true) {
        toolErrors += 1;
        const toolName = stringValue(event.payload.toolName) ?? "unknown";
        toolErrorsByName[toolName] = (toolErrorsByName[toolName] ?? 0) + 1;
      }
      if (event.eventType === "provider_error") {
        providerErrors += 1;
        const errorKind = stringValue(event.payload.errorKind) ?? "unknown";
        providerErrorsByKind[errorKind] = (providerErrorsByKind[errorKind] ?? 0) + 1;
      }
      if (event.eventType.startsWith("task_")) {
        const outcome = event.eventType.slice("task_".length);
        if (["completed", "partial", "blocked", "failed"].includes(outcome)) {
          taskOutcomes[outcome] = (taskOutcomes[outcome] ?? 0) + 1;
        }
      }
      if (event.eventType === "turn_usage" && accumulateUsage(turnUsage, event.payload.usage)) {
        turnsWithUsage += 1;
        const modelKey = [stringValue(event.payload.provider), stringValue(event.payload.model)]
          .filter((value): value is string => Boolean(value))
          .join("/") || "unknown";
        const modelUsage = turnUsageByModel[modelKey] ?? createUsageAccumulator();
        accumulateUsage(modelUsage, event.payload.usage);
        turnUsageByModel[modelKey] = modelUsage;
      }
      if (event.eventType === "invocation_metrics") {
        invocationCount += 1;
        const invocationKind = stringValue(event.payload.invocationKind) ?? "unknown";
        const status = stringValue(event.payload.status) ?? "unknown";
        invocationByStatus[status] = (invocationByStatus[status] ?? 0) + 1;
        const stats = recordValue(event.payload.stats);
        accumulateUsage(invocationUsage, stats?.usage);
        accumulateNumber(invocationDurationMs, event.payload.durationMs);
        accumulateNumber(invocationInputBytes, event.payload.inputBytes);
        const kindMetrics = invocationByKind[invocationKind] ?? createInvocationAccumulator();
        kindMetrics.count += 1;
        accumulateUsage(kindMetrics.usage, stats?.usage);
        accumulateNumber(kindMetrics.durationMs, event.payload.durationMs);
        accumulateNumber(kindMetrics.inputBytes, event.payload.inputBytes);
        invocationByKind[invocationKind] = kindMetrics;
      }
      if (event.eventType === "projection_input_built") {
        projector.inputsBuilt += 1;
        projector.observations += numberValue(event.payload.observationCount);
        accumulateNumber(projector.inputBytes, event.payload.inputBytes);
      }
      if (event.eventType === "projection_job_succeeded") {
        projector.succeeded += 1;
        projector.graphNodes += Object.values(recordValue(event.payload.nodeCounts) ?? {})
          .reduce<number>((total, count) => total + numberValue(count), 0);
        projector.graphEdges += numberValue(event.payload.edgeCount);
        accumulateNumber(projector.durationMs, event.payload.durationMs);
      }
      if (event.eventType === "projection_job_failed") {
        projector.failed += 1;
        accumulateNumber(projector.durationMs, event.payload.durationMs);
      }
      if (event.eventType === "projection_job_discarded") {
        projector.discarded += 1;
      }
      if (event.eventType === "supervisor_check_started") supervisor.started += 1;
      if (event.eventType === "supervisor_check_succeeded") {
        supervisor.succeeded += 1;
        const decision = stringValue(recordValue(event.payload.controlSignal)?.decision) ?? "unknown";
        supervisor.decisions[decision] = (supervisor.decisions[decision] ?? 0) + 1;
      }
      if (event.eventType === "supervisor_check_failed") supervisor.failed += 1;
      if (event.eventType === "supervisor_check_discarded") supervisor.discarded += 1;
      if (event.eventType === "metrics_collection_failed") {
        metricsCollectionFailures += 1;
      }
    }

    return {
      eventCount: events.length,
      firstSeq: events[0]?.seq,
      lastSeq: events.at(-1)?.seq,
      firstTimestamp: events[0]?.timestamp,
      lastTimestamp: events.at(-1)?.timestamp,
      byRole,
      byEventType,
      toolCalls,
      toolErrors,
      toolCallsByName,
      toolErrorsByName,
      providerErrors,
      providerErrorsByKind,
      metricsCollectionFailures,
      taskOutcomes,
      turnUsage: {
        turnsWithUsage,
        ...turnUsage,
        byModel: turnUsageByModel
      },
      invocations: {
        count: invocationCount,
        byKind: Object.fromEntries(Object.entries(invocationByKind).map(([kind, value]) => [kind, {
          count: value.count,
          usage: value.usage,
          durationMs: summarizeNumberAccumulator(value.durationMs),
          inputBytes: summarizeNumberAccumulator(value.inputBytes)
        }])),
        byStatus: invocationByStatus,
        durationMs: summarizeNumberAccumulator(invocationDurationMs),
        inputBytes: summarizeNumberAccumulator(invocationInputBytes),
        ...invocationUsage
      },
      projector: {
        ...projector,
        inputBytes: summarizeNumberAccumulator(projector.inputBytes),
        durationMs: summarizeNumberAccumulator(projector.durationMs)
      },
      supervisor
    };
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS execution_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        epoch_id TEXT,
        task_id TEXT,
        role TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        summary TEXT,
        payload_json TEXT NOT NULL,
        artifact_refs_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_events_task_seq ON execution_events(task_id, seq);
      CREATE INDEX IF NOT EXISTS idx_execution_events_epoch_seq ON execution_events(epoch_id, seq);
      CREATE INDEX IF NOT EXISTS idx_execution_events_type_seq ON execution_events(event_type, seq);
    `);
  }

  private importLegacyJsonl(): void {
    const count = this.database.prepare("SELECT COUNT(*) AS count FROM execution_events").get() as { count: number };
    if (Number(count.count) > 0 || !existsSync(this.filePath)) {
      return;
    }
    const lines = readFileSync(this.filePath, "utf8").split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return;
    }
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO execution_events (
        id, epoch_id, task_id, role, event_type, timestamp,
        summary, payload_json, artifact_refs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.database.exec("BEGIN");
    try {
      for (const line of lines) {
        const event = JSON.parse(line) as ExecutionEvent;
        insert.run(
          event.id,
          event.epochId ?? null,
          event.taskId ?? null,
          event.role,
          event.eventType,
          event.timestamp,
          event.summary ?? null,
          JSON.stringify(event.payload ?? {}),
          JSON.stringify(event.artifactRefs ?? [])
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function rowToEvent(row: ExecutionEventRow): ExecutionEvent {
  const artifactRefs = JSON.parse(row.artifact_refs_json) as string[];
  return {
    seq: Number(row.seq),
    id: row.id,
    epochId: row.epoch_id ?? undefined,
    taskId: row.task_id ?? undefined,
    role: row.role,
    eventType: row.event_type,
    timestamp: row.timestamp,
    summary: row.summary ?? undefined,
    payload: JSON.parse(row.payload_json) as JsonObject,
    artifactRefs: artifactRefs.length > 0 ? artifactRefs : undefined
  };
}

function createUsageAccumulator(): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  cost: number;
} {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 };
}

function createNumberAccumulator(): { count: number; total: number; max: number } {
  return { count: 0, total: 0, max: 0 };
}

function createInvocationAccumulator(): {
  count: number;
  usage: ReturnType<typeof createUsageAccumulator>;
  durationMs: ReturnType<typeof createNumberAccumulator>;
  inputBytes: ReturnType<typeof createNumberAccumulator>;
} {
  return {
    count: 0,
    usage: createUsageAccumulator(),
    durationMs: createNumberAccumulator(),
    inputBytes: createNumberAccumulator()
  };
}

function accumulateNumber(
  accumulator: ReturnType<typeof createNumberAccumulator>,
  value: unknown
): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return false;
  }
  accumulator.count += 1;
  accumulator.total += value;
  accumulator.max = Math.max(accumulator.max, value);
  return true;
}

function summarizeNumberAccumulator(
  accumulator: ReturnType<typeof createNumberAccumulator>
): { count: number; total: number; max: number; average: number } {
  return {
    ...accumulator,
    average: accumulator.count > 0 ? accumulator.total / accumulator.count : 0
  };
}

function accumulateUsage(
  accumulator: ReturnType<typeof createUsageAccumulator>,
  value: unknown
): boolean {
  const usage = recordValue(value);
  if (!usage) {
    return false;
  }
  accumulator.input += numberValue(usage.input);
  accumulator.output += numberValue(usage.output);
  accumulator.cacheRead += numberValue(usage.cacheRead);
  accumulator.cacheWrite += numberValue(usage.cacheWrite);
  accumulator.reasoning += numberValue(usage.reasoning);
  accumulator.totalTokens += numberValue(usage.totalTokens)
    || numberValue(usage.input) + numberValue(usage.output) + numberValue(usage.cacheRead) + numberValue(usage.cacheWrite);
  accumulator.cost += numberValue(recordValue(usage.cost)?.total ?? usage.cost);
  return true;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
