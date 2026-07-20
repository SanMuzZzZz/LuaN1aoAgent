import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { toJsonLine } from "../json.js";
import type { ArtifactRecord } from "../types.js";

type ArtifactRow = {
  artifact_ref: string;
  task_id: string | null;
  kind: ArtifactRecord["kind"];
  media_type: string;
  path: string;
  byte_length: number;
  created_at: string;
  preview: string;
  content_hash: string;
};

export class ArtifactStore {
  readonly rootDir: string;
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(rootDir: string, databasePath = join(dirname(rootDir), "state.sqlite")) {
    this.rootDir = rootDir;
    this.databasePath = databasePath;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.initialize();
    this.importLegacyIndex();
  }

  close(): void {
    this.database.close();
  }

  async write(input: {
    taskId?: string;
    kind: ArtifactRecord["kind"];
    mediaType: string;
    data: string | Buffer;
    extension?: string;
  }): Promise<ArtifactRecord> {
    const dataBuffer = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
    const contentHash = createHash("sha256").update(dataBuffer).digest("hex");
    const existing = this.database.prepare(`
      SELECT * FROM artifacts
      WHERE task_id IS ? AND content_hash = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(input.taskId ?? null, contentHash) as ArtifactRow | undefined;
    if (existing) {
      return rowToRecord(existing);
    }

    const createdAt = new Date().toISOString();
    const artifactRef = `artifact:${randomUUID()}`;
    const extension = input.extension ?? extensionForKind(input.kind);
    const relativePath = join(input.taskId ?? "global", `${contentHash}.${extension}`);
    const absolutePath = join(this.rootDir, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    if (!existsSync(absolutePath)) {
      await writeFile(absolutePath, dataBuffer);
    }
    const record: ArtifactRecord = {
      artifactRef,
      taskId: input.taskId,
      kind: input.kind,
      mediaType: input.mediaType,
      path: absolutePath,
      byteLength: dataBuffer.byteLength,
      createdAt,
      preview: dataBuffer.toString("utf8", 0, Math.min(dataBuffer.byteLength, 800)),
      contentHash
    };
    const inserted = this.insertRecord(record, dataBuffer.toString("utf8"));
    if (!inserted) {
      const concurrent = this.database.prepare(`
        SELECT * FROM artifacts WHERE task_id IS ? AND content_hash = ? ORDER BY created_at DESC LIMIT 1
      `).get(input.taskId ?? null, contentHash) as ArtifactRow | undefined;
      if (concurrent) {
        return rowToRecord(concurrent);
      }
    }
    await this.appendRecord(record);
    return record;
  }

  async read(refOrPath: string, range?: { offset?: number; length?: number }): Promise<string> {
    const fileBuffer = await readFile(await this.resolvePath(refOrPath));
    const offset = range?.offset ?? 0;
    const length = range?.length ?? fileBuffer.byteLength - offset;
    return fileBuffer.subarray(offset, offset + length).toString("utf8");
  }

  async preview(refOrPath: string, maxBytes = 1000): Promise<{ byteLength: number; preview: string }> {
    const artifactPath = await this.resolvePath(refOrPath);
    const fileStat = await stat(artifactPath);
    const fileBuffer = await readFile(artifactPath);
    return {
      byteLength: fileStat.size,
      preview: fileBuffer.toString("utf8", 0, Math.min(fileBuffer.byteLength, maxBytes))
    };
  }

  async get(artifactRef: string): Promise<ArtifactRecord | undefined> {
    const row = this.database.prepare("SELECT * FROM artifacts WHERE artifact_ref = ?")
      .get(artifactRef) as ArtifactRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  async list(input: { taskId?: string } = {}): Promise<ArtifactRecord[]> {
    const rows = input.taskId
      ? this.database.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC").all(input.taskId)
      : this.database.prepare("SELECT * FROM artifacts ORDER BY created_at ASC").all();
    return (rows as ArtifactRow[]).map(rowToRecord);
  }

  stats(): Record<string, unknown> {
    const totals = this.database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS byte_length,
             COUNT(DISTINCT content_hash) AS unique_content_count
      FROM artifacts
    `).get() as { count: number; byte_length: number; unique_content_count: number };
    const byKind = Object.fromEntries((this.database.prepare(`
      SELECT kind, COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS byte_length
      FROM artifacts GROUP BY kind ORDER BY kind
    `).all() as Array<{ kind: string; count: number; byte_length: number }>).map((row) => [
      row.kind,
      { count: Number(row.count), byteLength: Number(row.byte_length) }
    ]));
    return {
      count: Number(totals.count),
      byteLength: Number(totals.byte_length),
      uniqueContentCount: Number(totals.unique_content_count),
      byKind
    };
  }

  async search(input: {
    taskId?: string;
    query: string;
    limit?: number;
  }): Promise<Array<{ artifactRef: string; chunkIndex: number; snippet: string }>> {
    const query = ftsQuery(input.query);
    if (!query) {
      return [];
    }
    const taskClause = input.taskId ? "AND task_id = ?" : "";
    const parameters = input.taskId
      ? [query, input.taskId, input.limit ?? 6]
      : [query, input.limit ?? 6];
    const rows = this.database.prepare(`
      SELECT artifact_ref, chunk_index,
             snippet(artifact_chunks_fts, 3, '', '', ' ... ', 32) AS snippet
      FROM artifact_chunks_fts
      WHERE artifact_chunks_fts MATCH ? ${taskClause}
      ORDER BY bm25(artifact_chunks_fts)
      LIMIT ?
    `).all(...parameters) as Array<{ artifact_ref: string; chunk_index: number; snippet: string }>;
    return rows.map((row) => ({
      artifactRef: row.artifact_ref,
      chunkIndex: Number(row.chunk_index),
      snippet: row.snippet
    }));
  }

  async searchWithin(input: {
    artifactRefs: string[];
    query: string;
    limit?: number;
  }): Promise<Array<{ artifactRef: string; chunkIndex: number; snippet: string }>> {
    const artifactRefs = [...new Set(input.artifactRefs)].filter((ref) => ref.startsWith("artifact:"));
    const query = ftsQuery(input.query);
    if (!query || artifactRefs.length === 0) {
      return [];
    }
    const placeholders = artifactRefs.map(() => "?").join(",");
    const rows = this.database.prepare(`
      SELECT artifact_ref, chunk_index,
             snippet(artifact_chunks_fts, 3, '', '', ' ... ', 32) AS snippet
      FROM artifact_chunks_fts
      WHERE artifact_chunks_fts MATCH ? AND artifact_ref IN (${placeholders})
      ORDER BY bm25(artifact_chunks_fts)
      LIMIT ?
    `).all(query, ...artifactRefs, input.limit ?? 6) as Array<{
      artifact_ref: string;
      chunk_index: number;
      snippet: string;
    }>;
    return rows.map((row) => ({
      artifactRef: row.artifact_ref,
      chunkIndex: Number(row.chunk_index),
      snippet: row.snippet
    }));
  }

  private insertRecord(record: ArtifactRecord, text: string): boolean {
    this.database.exec("BEGIN");
    try {
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO artifacts (
          artifact_ref, task_id, kind, media_type, path, byte_length,
          created_at, preview, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.artifactRef,
        record.taskId ?? null,
        record.kind,
        record.mediaType,
        record.path,
        record.byteLength,
        record.createdAt,
        record.preview,
        record.contentHash ?? ""
      );
      if (Number(inserted.changes) !== 1) {
        this.database.exec("COMMIT");
        return false;
      }
      this.database.prepare("DELETE FROM artifact_chunks_fts WHERE artifact_ref = ?")
        .run(record.artifactRef);
      for (const [chunkIndex, content] of chunkText(text).entries()) {
        this.database.prepare(`
          INSERT INTO artifact_chunks_fts (artifact_ref, task_id, chunk_index, content)
          VALUES (?, ?, ?, ?)
        `).run(record.artifactRef, record.taskId ?? "", chunkIndex, content);
      }
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private async appendRecord(record: ArtifactRecord): Promise<void> {
    const indexPath = this.indexPath();
    await mkdir(dirname(indexPath), { recursive: true });
    await appendFile(indexPath, toJsonLine(record));
  }

  private async resolvePath(refOrPath: string): Promise<string> {
    if (!refOrPath.startsWith("artifact:")) {
      return refOrPath;
    }
    const record = await this.get(refOrPath);
    if (!record) {
      throw new Error(`Artifact not found: ${refOrPath}`);
    }
    return record.path;
  }

  private indexPath(): string {
    return join(this.rootDir, "index.jsonl");
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_ref TEXT PRIMARY KEY,
        task_id TEXT,
        kind TEXT NOT NULL,
        media_type TEXT NOT NULL,
        path TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        preview TEXT NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_task_hash ON artifacts(task_id, content_hash);
      CREATE VIRTUAL TABLE IF NOT EXISTS artifact_chunks_fts USING fts5(
        artifact_ref UNINDEXED,
        task_id UNINDEXED,
        chunk_index UNINDEXED,
        content
      );
    `);
  }

  private importLegacyIndex(): void {
    const count = this.database.prepare("SELECT COUNT(*) AS count FROM artifacts").get() as { count: number };
    if (Number(count.count) > 0 || !existsSync(this.indexPath())) {
      return;
    }
    const lines = readFileSync(this.indexPath(), "utf8").split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const legacy = JSON.parse(line) as ArtifactRecord;
      if (!existsSync(legacy.path)) {
        continue;
      }
      const data = readFileSync(legacy.path);
      const record = {
        ...legacy,
        contentHash: legacy.contentHash ?? createHash("sha256").update(data).digest("hex")
      };
      this.insertRecord(record, data.toString("utf8"));
    }
  }
}

function rowToRecord(row: ArtifactRow): ArtifactRecord {
  return {
    artifactRef: row.artifact_ref,
    taskId: row.task_id ?? undefined,
    kind: row.kind,
    mediaType: row.media_type,
    path: row.path,
    byteLength: Number(row.byte_length),
    createdAt: row.created_at,
    preview: row.preview,
    contentHash: row.content_hash
  };
}

function chunkText(text: string, size = 2000, overlap = 200): string[] {
  if (!text) {
    return [];
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size - overlap) {
    chunks.push(text.slice(offset, offset + size));
  }
  return chunks;
}

function ftsQuery(value: string): string {
  return value
    .split(/\s+/)
    .map((token) => token.replace(/["'():*^{}\[\]]/g, "").trim())
    .filter((token) => token.length >= 2)
    .slice(0, 12)
    .map((token) => `"${token}"`)
    .join(" OR ");
}

function extensionForKind(kind: ArtifactRecord["kind"]): string {
  switch (kind) {
    case "json":
      return "json";
    case "screenshot":
      return "png";
    case "poc":
      return "txt";
    default:
      return "txt";
  }
}
