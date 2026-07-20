import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createBubblewrapCommand,
  createExecutorSandbox,
  SandboxPathPolicy
} from "../src/executor-sandbox.js";

const execFileAsync = promisify(execFile);

test("executor sandbox path policy denies host files outside allowed roots", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-sandbox-"));
  const sandbox = await createExecutorSandbox({ runtimeDir, runId: "run", mode: "workspace" });
  const insidePath = join(sandbox.root, "inside.txt");
  const outsidePath = join(runtimeDir, "outside.txt");
  writeFileSync(insidePath, "inside");
  writeFileSync(outsidePath, "outside");
  const policy = new SandboxPathPolicy(sandbox.root, [sandbox.root]);

  assert.equal(await policy.requireReadable(insidePath), insidePath);
  await assert.rejects(() => policy.requireReadable(outsidePath), /denied path outside allowed roots/);
});

test("executor sandbox resolves relative runtime directories before changing cwd", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-sandbox-relative-"));
  const sandbox = await createExecutorSandbox({
    runtimeDir: relative(process.cwd(), runtimeDir),
    runId: "run",
    mode: "workspace"
  });

  assert.ok(isAbsolute(sandbox.root));
  assert.equal(dirname(dirname(sandbox.root)), realpathSync(runtimeDir));
});

test("macOS seatbelt sandbox can read its workspace but not sibling runtime files", {
  skip: process.platform !== "darwin"
}, async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-seatbelt-"));
  const sandbox = await createExecutorSandbox({ runtimeDir, runId: "run", mode: "seatbelt" });
  const insidePath = join(sandbox.root, "inside.txt");
  const outsidePath = join(runtimeDir, "outside.txt");
  writeFileSync(insidePath, "inside-visible");
  writeFileSync(outsidePath, "outside-secret");
  assert.ok(sandbox.profilePath);
  assert.ok(isAbsolute(sandbox.profilePath));

  const inside = await execFileAsync("/usr/bin/sandbox-exec", ["-f", sandbox.profilePath, "/bin/cat", insidePath]);
  assert.equal(inside.stdout, "inside-visible");
  await assert.rejects(
    () => execFileAsync("/usr/bin/sandbox-exec", ["-f", sandbox.profilePath!, "/bin/cat", outsidePath]),
    (error: unknown) => !String((error as { stdout?: string }).stdout ?? "").includes("outside-secret")
  );

  const heredocPath = join(sandbox.root, "heredoc.txt");
  await execFileAsync("/usr/bin/sandbox-exec", [
    "-f",
    sandbox.profilePath,
    "/usr/bin/env",
    `TMPDIR=${join(sandbox.root, "tmp")}`,
    `TMPPREFIX=${join(sandbox.root, "tmp", "zsh")}`,
    "/bin/zsh",
    "--emulate",
    "sh",
    "-f",
    "-c",
    `cat <<'EOF' > ${JSON.stringify(heredocPath)}\nheredoc-visible\nEOF`
  ]);
  assert.equal(readFileSync(heredocPath, "utf8"), "heredoc-visible\n");
});

test("Linux bubblewrap command mounts only runtime roots and keeps network available", () => {
  const command = createBubblewrapCommand({
    bubblewrapPath: "/usr/bin/bwrap",
    sandboxRoot: "/tmp/runtime/sandboxes/run",
    readOnlyRoots: ["/home/test/.agents/skills"],
    shellPath: "/bin/bash",
    command: "curl http://127.0.0.1:8080"
  });

  assert.deepEqual(command.slice(0, 7), [
    "/usr/bin/bwrap",
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--proc"
  ]);
  assert.ok(command.includes("--bind"));
  assert.ok(command.includes("/tmp/runtime/sandboxes/run"));
  assert.ok(command.includes("/home/test/.agents/skills"));
  assert.ok(!command.includes("--unshare-net"));
  assert.ok(!command.some((value, index) => value === "--ro-bind" && command[index + 1] === "/"));
  assert.deepEqual(command.slice(-3), ["/bin/bash", "-c", "curl http://127.0.0.1:8080"]);
});

test("forced bubblewrap mode fails closed when bwrap is unavailable", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-bwrap-missing-"));
  const previousPath = process.env.BWRAP_PATH;
  process.env.BWRAP_PATH = join(runtimeDir, "missing-bwrap");
  try {
    await assert.rejects(
      () => createExecutorSandbox({ runtimeDir, runId: "run", mode: "bubblewrap" }),
      /requires the bwrap executable/
    );
  } finally {
    if (previousPath === undefined) {
      delete process.env.BWRAP_PATH;
    } else {
      process.env.BWRAP_PATH = previousPath;
    }
  }
});
