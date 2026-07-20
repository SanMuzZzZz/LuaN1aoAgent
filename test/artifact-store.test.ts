import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/stores/artifact-store.js";

test("writes artifacts and reads them by artifact ref", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const record = await artifactStore.write({
    taskId: "task:artifact",
    kind: "text",
    mediaType: "text/plain",
    data: "hello artifact"
  });

  assert.equal(await artifactStore.read(record.artifactRef), "hello artifact");
  assert.equal((await artifactStore.get(record.artifactRef))?.path, record.path);
});

test("lists artifacts by task id", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const firstRecord = await artifactStore.write({
    taskId: "task:list",
    kind: "text",
    mediaType: "text/plain",
    data: "first"
  });
  await artifactStore.write({
    taskId: "task:other",
    kind: "text",
    mediaType: "text/plain",
    data: "second"
  });

  const records = await artifactStore.list({ taskId: "task:list" });

  assert.deepEqual(records.map((record) => record.artifactRef), [firstRecord.artifactRef]);
});

test("deduplicates identical task artifacts and searches relevant chunks", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const content = `${"prefix ".repeat(400)}FLAG{indexed_chunk_hit}`;
  const first = await artifactStore.write({
    taskId: "task:search",
    kind: "text",
    mediaType: "text/plain",
    data: content
  });
  const duplicate = await artifactStore.write({
    taskId: "task:search",
    kind: "text",
    mediaType: "text/plain",
    data: content
  });

  assert.equal(duplicate.artifactRef, first.artifactRef);
  assert.equal((await artifactStore.list({ taskId: "task:search" })).length, 1);
  const matches = await artifactStore.search({ taskId: "task:search", query: "indexed chunk hit" });
  assert.equal(matches[0]?.artifactRef, first.artifactRef);
  assert.match(matches[0]?.snippet ?? "", /indexed_chunk_hit/);
});

test("searches only the artifact refs attached to the current projection batch", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const relevant = await artifactStore.write({
    taskId: "task:search",
    kind: "http_body",
    mediaType: "text/plain",
    data: "upload response FLAG{projection_ref_only}"
  });
  const unrelated = await artifactStore.write({
    taskId: "task:search",
    kind: "text",
    mediaType: "text/plain",
    data: "skill prompt FLAG{unrelated_context}"
  });

  const matches = await artifactStore.searchWithin({
    artifactRefs: [relevant.artifactRef],
    query: "FLAG projection",
    limit: 4
  });

  assert.ok(matches.some((match) => match.artifactRef === relevant.artifactRef));
  assert.equal(matches.some((match) => match.artifactRef === unrelated.artifactRef), false);
});

test("reports artifact count, bytes and kind distribution", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  await artifactStore.write({
    taskId: "task:stats",
    kind: "text",
    mediaType: "text/plain",
    data: "hello"
  });
  await artifactStore.write({
    taskId: "task:stats",
    kind: "http_body",
    mediaType: "text/plain",
    data: "response"
  });

  assert.deepEqual(artifactStore.stats(), {
    count: 2,
    byteLength: 13,
    uniqueContentCount: 2,
    byKind: {
      http_body: { count: 1, byteLength: 8 },
      text: { count: 1, byteLength: 5 }
    }
  });
});
