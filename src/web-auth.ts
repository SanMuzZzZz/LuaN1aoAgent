import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const scrypt = promisify(scryptCallback);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type WebUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "analyst";
  createdAt: string;
};

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  role: WebUser["role"];
  password_hash: string;
  password_salt: string;
  created_at: string;
};

export class WebAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string
  ) {
    super(message);
  }
}

export class WebAuthService {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS web_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'analyst')),
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES web_users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS web_sessions_expires_at_idx ON web_sessions(expires_at);
    `);
  }

  async register(input: { username: string; displayName: string; password: string }): Promise<{ user: WebUser; token: string }> {
    const username = normalizeUsername(input.username);
    const displayName = validateDisplayName(input.displayName);
    validatePassword(input.password);
    const existing = this.database.prepare("SELECT id FROM web_users WHERE username = ?").get(username);
    if (existing) throw new WebAuthError("该用户名已被注册", 409, "username_taken");

    const salt = randomBytes(16).toString("base64url");
    const passwordHash = await hashPassword(input.password, salt);
    const id = `user:${randomBytes(16).toString("hex")}`;
    const createdAt = new Date().toISOString();
    const countRow = this.database.prepare("SELECT COUNT(*) AS count FROM web_users").get() as { count: number };
    const role: WebUser["role"] = countRow.count === 0 ? "admin" : "analyst";

    try {
      this.database.prepare(`
        INSERT INTO web_users (id, username, display_name, role, password_hash, password_salt, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, username, displayName, role, passwordHash, salt, createdAt);
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new WebAuthError("该用户名已被注册", 409, "username_taken");
      throw error;
    }

    const user = { id, username, displayName, role, createdAt };
    return { user, token: this.createSession(user.id) };
  }

  async login(input: { username: string; password: string }): Promise<{ user: WebUser; token: string }> {
    const username = normalizeUsername(input.username);
    const row = this.database.prepare("SELECT * FROM web_users WHERE username = ?").get(username) as UserRow | undefined;
    if (!row || !await verifyPassword(input.password, row.password_salt, row.password_hash)) {
      throw new WebAuthError("用户名或密码不正确", 401, "invalid_credentials");
    }
    const user = toWebUser(row);
    return { user, token: this.createSession(user.id) };
  }

  authenticate(token: string | undefined): WebUser | undefined {
    if (!token) return undefined;
    const now = new Date().toISOString();
    this.database.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(now);
    const row = this.database.prepare(`
      SELECT u.*
      FROM web_sessions s
      JOIN web_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(hashToken(token), now) as UserRow | undefined;
    if (!row) return undefined;
    this.database.prepare("UPDATE web_sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, hashToken(token));
    return toWebUser(row);
  }

  logout(token: string | undefined): void {
    if (!token) return;
    this.database.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(hashToken(token));
  }

  private createSession(userId: string): string {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    this.database.prepare(`
      INSERT INTO web_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      `session:${randomBytes(16).toString("hex")}`,
      userId,
      hashToken(token),
      now.toISOString(),
      new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      now.toISOString()
    );
    return token;
  }
}

function normalizeUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
    throw new WebAuthError("用户名需为 3-32 位字母、数字、点、下划线或短横线", 400, "invalid_username");
  }
  return username;
}

function validateDisplayName(value: string): string {
  const displayName = value.trim();
  if (displayName.length < 2 || displayName.length > 40) {
    throw new WebAuthError("显示名称需为 2-40 个字符", 400, "invalid_display_name");
  }
  return displayName;
}

function validatePassword(value: string): void {
  if (value.length < 8 || value.length > 128) {
    throw new WebAuthError("密码长度需为 8-128 个字符", 400, "invalid_password");
  }
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const result = await scrypt(password, salt, 64) as Buffer;
  return result.toString("base64url");
}

async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const actual = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(expectedHash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toWebUser(row: UserRow): WebUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at
  };
}
