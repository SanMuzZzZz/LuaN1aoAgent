import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const SESSION_MARKERS = [
  "state.sqlite",
  "execution.jsonl",
  "graph-deltas.jsonl",
  join("artifacts", "index.jsonl")
];

const SKIPPED_DIRECTORIES = new Set(["artifacts", "sandboxes", "node_modules", ".git"]);

export async function discoverRuntimeSessionDirs(
  rootDir: string,
  options: { maxDepth?: number; maxDirectories?: number; concurrency?: number } = {}
): Promise<string[]> {
  const maxDepth = options.maxDepth ?? 4;
  const maxDirectories = options.maxDirectories ?? 5000;
  const concurrency = options.concurrency ?? 24;
  const queue: Array<{ dir: string; depth: number; isRoot: boolean }> = [{ dir: rootDir, depth: 0, isRoot: true }];
  const sessions: string[] = [];
  let visited = 0;

  while (queue.length && visited < maxDirectories) {
    const batch = queue.splice(0, Math.min(concurrency, maxDirectories - visited));
    visited += batch.length;
    const results = await Promise.all(batch.map(async (entry) => {
      const isSession = await hasRuntimeMarker(entry.dir);
      if (entry.depth >= maxDepth || (isSession && !entry.isRoot)) {
        return { entry, isSession, children: [] as string[] };
      }
      try {
        const children = (await readdir(entry.dir, { withFileTypes: true }))
          .filter((child) => child.isDirectory() && !SKIPPED_DIRECTORIES.has(child.name))
          .map((child) => join(entry.dir, child.name));
        return { entry, isSession, children };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entry, isSession, children: [] as string[] };
        throw error;
      }
    }));

    for (const result of results) {
      if (result.isSession) sessions.push(result.entry.dir);
      for (const child of result.children) queue.push({ dir: child, depth: result.entry.depth + 1, isRoot: false });
    }
  }

  return [...new Set(sessions)].sort();
}

async function hasRuntimeMarker(runtimeDir: string): Promise<boolean> {
  const markers = await Promise.all(SESSION_MARKERS.map(async (marker) => {
    try {
      return (await stat(join(runtimeDir, marker))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }));
  return markers.some(Boolean);
}
