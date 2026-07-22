import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const TRAFFIC_PROXY_SOCKET_PATH_MAX_BYTES = 103;

export type TrafficProxyRuntimeIdentity = {
  runtimeDir: string;
  runtimeRef: string;
  socketDir: string;
  controlSocket: string;
};

export function canonicalTrafficProxyRuntimeDir(runtimeDir: string): string {
  let current = resolve(runtimeDir);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(runtimeDir);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

export function trafficProxyRuntimeIdentity(runtimeDir: string): TrafficProxyRuntimeIdentity {
  const canonical = canonicalTrafficProxyRuntimeDir(runtimeDir);
  const runtimeRef = createHash("sha256").update(canonical).digest("hex");
  const socketRoot = nearestAgentRuntimeAncestor(canonical) ?? dirname(canonical);
  const socketDir = join(socketRoot, ".s");
  const controlSocket = join(socketDir, `${runtimeRef.slice(0, 24)}.sock`);
  const pathBytes = Buffer.byteLength(controlSocket, "utf8");
  if (pathBytes > TRAFFIC_PROXY_SOCKET_PATH_MAX_BYTES) {
    throw new Error(`traffic-proxy control socket path is ${pathBytes} UTF-8 bytes; maximum is ${TRAFFIC_PROXY_SOCKET_PATH_MAX_BYTES}: ${controlSocket}`);
  }
  return { runtimeDir: canonical, runtimeRef, socketDir, controlSocket };
}

export async function ensureTrafficProxySocketDir(socketDir: string): Promise<void> {
  try {
    await mkdir(socketDir, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const info = await lstat(socketDir);
  if (info.isSymbolicLink()) throw new Error(`traffic-proxy socket directory must not be a symlink: ${socketDir}`);
  if (!info.isDirectory()) throw new Error(`traffic-proxy socket directory is not a directory: ${socketDir}`);
  if ((info.mode & 0o777) !== 0o700) {
    throw new Error(`traffic-proxy socket directory must have mode 0700: ${socketDir}`);
  }
}

function nearestAgentRuntimeAncestor(runtimeDir: string): string | undefined {
  let current = runtimeDir;
  for (;;) {
    if (basename(current) === ".agent-runtime") return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
