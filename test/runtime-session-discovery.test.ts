import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRuntimeSessionDirs } from "../src/runtime-session-discovery.js";

test("discovers nested competition sessions without descending into session-owned folders", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "luanniao-sessions-"));
  const standalone = join(rootDir, "standalone-run");
  const competition = join(rootDir, "competition-20260712-105736");
  const nested = join(competition, "a-07-20260712-110315-d96bb044");
  const nestedArtifact = join(nested, "artifacts", "task:test");
  await mkdir(standalone, { recursive: true });
  await mkdir(nestedArtifact, { recursive: true });
  await writeFile(join(rootDir, "execution.jsonl"), "{}\n");
  await writeFile(join(standalone, "state.sqlite"), "");
  await writeFile(join(nested, "execution.jsonl"), "{}\n");
  await writeFile(join(nestedArtifact, "execution.jsonl"), "{}\n");

  assert.deepEqual(await discoverRuntimeSessionDirs(rootDir), [rootDir, standalone, nested].sort());
});
