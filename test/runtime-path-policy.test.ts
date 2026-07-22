import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { RuntimePathPolicy, RuntimePathPolicyError } from "../src/runtime-path-policy.js";

async function withFixture(run: (fixture: { base: string; root: string; outside: string; policy: RuntimePathPolicy }) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "luanniao-path-policy-"));
  const root = join(base, "runtime");
  const outside = join(base, "runtime-secret");
  await mkdir(root);
  await mkdir(outside);
  try {
    const policy = await RuntimePathPolicy.create("runtime", { baseDir: base });
    await run({ base, root: await policy.resolveRuntime("runtime"), outside: resolve(outside), policy });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function isOutsideError(error: unknown): boolean {
  return error instanceof RuntimePathPolicyError && error.code === "runtime_path_outside_root";
}

test("resolves existing and not-yet-created runtime paths canonically", async () => {
  await withFixture(async ({ root, policy }) => {
    await mkdir(join(root, "sessions"));
    assert.equal(await policy.resolveRuntime("runtime/sessions"), join(root, "sessions"));
    assert.equal(await policy.resolveRuntime("runtime/sessions/new-run", "create"), join(root, "sessions", "new-run"));
  });
});

test("rejects parent traversal, absolute escape, and same-prefix siblings", async () => {
  await withFixture(async ({ base, outside, policy }) => {
    await assert.rejects(policy.resolveRuntime("runtime/../runtime-secret"), isOutsideError);
    await assert.rejects(policy.resolveRuntime(outside), isOutsideError);
    await assert.rejects(policy.resolveRuntime(join(base, "runtime-secret")), isOutsideError);
  });
});

test("rejects symlink breakout while allowing symlinks that remain inside the root", async (context) => {
  await withFixture(async ({ root, outside, policy }) => {
    await mkdir(join(root, "inside"));
    try {
      await symlink(outside, join(root, "escape"), "dir");
      await symlink(join(root, "inside"), join(root, "inside-link"), "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
        context.skip(`symlinks unavailable: ${code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(policy.resolveRuntime("runtime/escape", "create"), isOutsideError);
    assert.equal(await policy.resolveRuntime("runtime/inside-link"), join(root, "inside"));
  });
});

test("runtime child resolution prevents cross-runtime artifact guessing", async () => {
  await withFixture(async ({ root, policy }) => {
    const first = join(root, "sessions", "first");
    const second = join(root, "sessions", "second");
    await mkdir(join(first, "artifacts"), { recursive: true });
    await mkdir(join(second, "artifacts"), { recursive: true });

    assert.equal(
      await policy.resolveRuntimeChild(first, "artifacts/new.txt", "create"),
      join(first, "artifacts", "new.txt")
    );
    await assert.rejects(
      policy.resolveRuntimeChild(first, join(second, "artifacts", "guessed.txt"), "create"),
      isOutsideError
    );
    await assert.rejects(
      policy.resolveRuntimeChild(first, "../second/artifacts/guessed.txt", "create"),
      isOutsideError
    );
  });
});
