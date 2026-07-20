import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ExecutionEpochRecord,
  ExecutionEpochState,
  ExecutionEpochTerminationReason,
  ProjectionClaim,
  ProjectionState
} from "../types.js";

export type ExecutorSessionRecord = {
  taskId: string;
  sessionFile: string;
  resumeCount: number;
  updatedAt: string;
};

type EpochRow = {
  epoch_id: string;
  task_id: string;
  attempt: number;
  state: ExecutionEpochState;
  termination_reason: ExecutionEpochTerminationReason | null;
  started_at: string;
  closed_at: string | null;
  start_seq: number | null;
  end_seq: number | null;
};

type ProjectionRow = {
  task_id: string;
  committed_seq: number;
  desired_seq: number;
  generation: number;
  active_generation: number | null;
  priority: number;
  updated_at: string;
};

type ExecutorSessionRow = {
  task_id: string;
  session_file: string;
  resume_count: number;
  updated_at: string;
};

export class RuntimeStore {
  readonly databasePath: string;
  readonly recoveredProjectionClaims: number;
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.initialize();
    this.recoverInterruptedEpochs();
    this.recoveredProjectionClaims = this.recoverInterruptedProjectionClaims();
  }

  close(): void {
    this.database.close();
  }

  createEpoch(input: {
    epochId: string;
    taskId: string;
    attempt: number;
    startSeq?: number;
  }): ExecutionEpochRecord {
    const startedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO execution_epochs (
        epoch_id, task_id, attempt, state, termination_reason,
        started_at, closed_at, start_seq, end_seq
      ) VALUES (?, ?, ?, 'created', NULL, ?, NULL, ?, NULL)
    `).run(input.epochId, input.taskId, input.attempt, startedAt, input.startSeq ?? null);
    return {
      epochId: input.epochId,
      taskId: input.taskId,
      attempt: input.attempt,
      state: "created",
      startedAt,
      startSeq: input.startSeq
    };
  }

  transitionEpoch(input: {
    epochId: string;
    state: ExecutionEpochState;
    terminationReason?: ExecutionEpochTerminationReason;
    endSeq?: number;
  }): ExecutionEpochRecord {
    const closedAt = input.state === "closed" ? new Date().toISOString() : null;
    const result = this.database.prepare(`
      UPDATE execution_epochs
      SET state = ?, termination_reason = COALESCE(?, termination_reason),
          closed_at = COALESCE(?, closed_at), end_seq = COALESCE(?, end_seq)
      WHERE epoch_id = ?
    `).run(
      input.state,
      input.terminationReason ?? null,
      closedAt,
      input.endSeq ?? null,
      input.epochId
    );
    if (Number(result.changes) !== 1) {
      throw new Error(`Execution epoch not found: ${input.epochId}`);
    }
    const record = this.getEpoch(input.epochId);
    if (!record) {
      throw new Error(`Execution epoch disappeared after transition: ${input.epochId}`);
    }
    return record;
  }

  getEpoch(epochId: string): ExecutionEpochRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM execution_epochs WHERE epoch_id = ?
    `).get(epochId) as EpochRow | undefined;
    return row ? epochRowToRecord(row) : undefined;
  }

  countTaskEpochs(taskId: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM execution_epochs WHERE task_id = ?
    `).get(taskId) as { count: number };
    return Number(row.count);
  }

  stats(): Record<string, unknown> {
    const byState = Object.fromEntries((this.database.prepare(`
      SELECT state, COUNT(*) AS count FROM execution_epochs GROUP BY state ORDER BY state
    `).all() as Array<{ state: string; count: number }>).map((row) => [row.state, Number(row.count)]));
    const byTerminationReason = Object.fromEntries((this.database.prepare(`
      SELECT COALESCE(termination_reason, 'none') AS reason, COUNT(*) AS count
      FROM execution_epochs GROUP BY COALESCE(termination_reason, 'none') ORDER BY reason
    `).all() as Array<{ reason: string; count: number }>).map((row) => [row.reason, Number(row.count)]));
    const totals = this.database.prepare(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(CASE WHEN state IN ('created','running','closing') THEN 1 ELSE 0 END), 0) AS active_count
      FROM execution_epochs
    `).get() as { count: number; active_count: number };
    return {
      epochCount: Number(totals.count),
      activeEpochCount: Number(totals.active_count),
      byState,
      byTerminationReason
    };
  }

  raiseProjectionDesired(taskId: string, seq: number, priority = 0): ProjectionState {
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO projection_states (
        task_id, committed_seq, desired_seq, generation, active_generation, priority, updated_at
      ) VALUES (?, 0, ?, 0, NULL, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        desired_seq = MAX(projection_states.desired_seq, excluded.desired_seq),
        priority = MAX(projection_states.priority, excluded.priority),
        updated_at = excluded.updated_at
    `).run(taskId, Math.max(0, seq), Math.max(0, priority), updatedAt);
    return this.getProjectionState(taskId);
  }

  claimProjection(taskId: string): ProjectionClaim | undefined {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.getProjectionState(taskId);
      if (state.activeGeneration !== undefined || state.desiredSeq <= state.committedSeq) {
        this.database.exec("COMMIT");
        return undefined;
      }
      const generation = state.generation + 1;
      const result = this.database.prepare(`
        UPDATE projection_states
        SET generation = ?, active_generation = ?, priority = 0, updated_at = ?
        WHERE task_id = ? AND committed_seq = ? AND desired_seq = ? AND active_generation IS NULL
      `).run(
        generation,
        generation,
        new Date().toISOString(),
        taskId,
        state.committedSeq,
        state.desiredSeq
      );
      if (Number(result.changes) !== 1) {
        this.database.exec("ROLLBACK");
        return undefined;
      }
      this.database.exec("COMMIT");
      return {
        taskId,
        fromSeq: state.committedSeq,
        toSeq: state.desiredSeq,
        generation
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseProjection(taskId: string, generation: number): void {
    this.database.prepare(`
      UPDATE projection_states
      SET active_generation = NULL, updated_at = ?
      WHERE task_id = ? AND active_generation = ?
    `).run(new Date().toISOString(), taskId, generation);
  }

  invalidateProjection(taskId: string): ProjectionState {
    this.database.prepare(`
      UPDATE projection_states
      SET generation = generation + 1, active_generation = NULL, updated_at = ?
      WHERE task_id = ?
    `).run(new Date().toISOString(), taskId);
    return this.getProjectionState(taskId);
  }

  getProjectionState(taskId: string): ProjectionState {
    const row = this.database.prepare(`
      SELECT * FROM projection_states WHERE task_id = ?
    `).get(taskId) as ProjectionRow | undefined;
    if (!row) {
      const updatedAt = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO projection_states (
          task_id, committed_seq, desired_seq, generation, active_generation, priority, updated_at
        ) VALUES (?, 0, 0, 0, NULL, 0, ?)
      `).run(taskId, updatedAt);
      return {
        taskId,
        committedSeq: 0,
        desiredSeq: 0,
        generation: 0,
        priority: 0,
        updatedAt
      };
    }
    return projectionRowToState(row);
  }

  listPendingProjectionTasks(): ProjectionState[] {
    const rows = this.database.prepare(`
      SELECT * FROM projection_states
      WHERE desired_seq > committed_seq AND active_generation IS NULL
      ORDER BY priority DESC, updated_at ASC
    `).all() as ProjectionRow[];
    return rows.map(projectionRowToState);
  }

  upsertExecutorSession(input: { taskId: string; sessionFile: string; resumeCount?: number }): ExecutorSessionRecord {
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO executor_sessions (task_id, session_file, resume_count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        session_file = excluded.session_file,
        resume_count = excluded.resume_count,
        updated_at = excluded.updated_at
    `).run(input.taskId, input.sessionFile, input.resumeCount ?? 0, updatedAt);
    return {
      taskId: input.taskId,
      sessionFile: input.sessionFile,
      resumeCount: input.resumeCount ?? 0,
      updatedAt
    };
  }

  getExecutorSession(taskId: string): ExecutorSessionRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM executor_sessions WHERE task_id = ?
    `).get(taskId) as ExecutorSessionRow | undefined;
    return row ? executorSessionRowToRecord(row) : undefined;
  }

  deleteExecutorSession(taskId: string): void {
    this.database.prepare(`
      DELETE FROM executor_sessions WHERE task_id = ?
    `).run(taskId);
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS execution_epochs (
        epoch_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        state TEXT NOT NULL,
        termination_reason TEXT,
        started_at TEXT NOT NULL,
        closed_at TEXT,
        start_seq INTEGER,
        end_seq INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_execution_epochs_task ON execution_epochs(task_id, attempt);
      CREATE INDEX IF NOT EXISTS idx_execution_epochs_state ON execution_epochs(state);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_epochs_active_task
        ON execution_epochs(task_id) WHERE state IN ('created', 'running', 'closing');
      CREATE TABLE IF NOT EXISTS projection_states (
        task_id TEXT PRIMARY KEY,
        committed_seq INTEGER NOT NULL DEFAULT 0,
        desired_seq INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 0,
        active_generation INTEGER,
        priority INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executor_sessions (
        task_id TEXT PRIMARY KEY,
        session_file TEXT NOT NULL,
        resume_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private recoverInterruptedEpochs(): void {
    const closedAt = new Date().toISOString();
    this.database.prepare(`
      UPDATE execution_epochs
      SET state = 'closed', termination_reason = 'shutdown', closed_at = ?,
          end_seq = COALESCE(end_seq, start_seq)
      WHERE state IN ('created', 'running', 'closing')
    `).run(closedAt);
  }

  private recoverInterruptedProjectionClaims(): number {
    const result = this.database.prepare(`
      UPDATE projection_states
      SET generation = generation + 1, active_generation = NULL, updated_at = ?
      WHERE active_generation IS NOT NULL
    `).run(new Date().toISOString());
    return Number(result.changes);
  }
}

function epochRowToRecord(row: EpochRow): ExecutionEpochRecord {
  return {
    epochId: row.epoch_id,
    taskId: row.task_id,
    attempt: Number(row.attempt),
    state: row.state,
    terminationReason: row.termination_reason ?? undefined,
    startedAt: row.started_at,
    closedAt: row.closed_at ?? undefined,
    startSeq: row.start_seq ?? undefined,
    endSeq: row.end_seq ?? undefined
  };
}

function projectionRowToState(row: ProjectionRow): ProjectionState {
  return {
    taskId: row.task_id,
    committedSeq: Number(row.committed_seq),
    desiredSeq: Number(row.desired_seq),
    generation: Number(row.generation),
    activeGeneration: row.active_generation ?? undefined,
    priority: Number(row.priority),
    updatedAt: row.updated_at
  };
}

function executorSessionRowToRecord(row: ExecutorSessionRow): ExecutorSessionRecord {
  return {
    taskId: row.task_id,
    sessionFile: row.session_file,
    resumeCount: Number(row.resume_count),
    updatedAt: row.updated_at
  };
}
