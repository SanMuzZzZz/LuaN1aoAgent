import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
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

test("executor sandbox copies only the managed public CA into its readable root", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-sandbox-ca-"));
  const caDir = join(runtimeDir, "traffic-proxy", "data", "ca", "runtime-ref");
  mkdirSync(caDir, { recursive: true });
  const sourceCa = join(caDir, "ca.crt");
  const privateKey = join(caDir, "ca.key");
  writeFileSync(sourceCa, "public-ca");
  writeFileSync(privateKey, "private-key");

  const sandbox = await createExecutorSandbox({
    runtimeDir,
    runId: "run",
    mode: "workspace",
    environment: {
      HTTP_PROXY: "http://127.0.0.1:1234",
      http_proxy: "http://127.0.0.1:1234",
      SSL_CERT_FILE: sourceCa,
      CURL_CA_BUNDLE: sourceCa
    }
  });
  const copiedCa = join(sandbox.root, "traffic-proxy-ca.crt");
  const policy = new SandboxPathPolicy(sandbox.root, [sandbox.root]);

  assert.equal(readFileSync(await policy.requireReadable(copiedCa), "utf8"), "public-ca");
  assert.equal(statSync(copiedCa).mode & 0o777, 0o444);
  await assert.rejects(() => policy.requireReadable(privateKey), /denied path outside allowed roots/);

  const bashTool = sandbox.createTools().find((tool) => tool.name === "bash");
  assert.ok(bashTool);
  const result = await bashTool.execute(
    "call:env",
    { command: "env; cat \"$SSL_CERT_FILE\"" },
    new AbortController().signal,
    () => undefined,
    {} as never
  );
  const output = result.content.find((item) => item.type === "text")?.text ?? "";
  assert.ok(output.includes("HTTP_PROXY=http://127.0.0.1:1234"));
  assert.ok(output.includes("http_proxy=http://127.0.0.1:1234"));
  assert.ok(output.includes(`SSL_CERT_FILE=${copiedCa}`));
  assert.match(output, /public-ca/);
  assert.doesNotMatch(output, /private-key/);
});

test("managed proxy removes bypass variables inherited by the bash tool", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-sandbox-proxy-env-"));
  const sourceCa = join(runtimeDir, "ca.crt");
  writeFileSync(sourceCa, "public-ca");
  const previous = {
    ALL_PROXY: process.env.ALL_PROXY,
    all_proxy: process.env.all_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy
  };
  process.env.ALL_PROXY = "socks5://127.0.0.1:9999";
  process.env.all_proxy = "socks5://127.0.0.1:9999";
  process.env.NO_PROXY = "localhost,127.0.0.1";
  process.env.no_proxy = "localhost,127.0.0.1";

  try {
    const sandbox = await createExecutorSandbox({
      runtimeDir,
      runId: "run",
      mode: "workspace",
      environment: {
        PATH: process.env.PATH,
        HTTP_PROXY: "http://127.0.0.1:1234",
        HTTPS_PROXY: "http://127.0.0.1:1234",
        http_proxy: "http://127.0.0.1:1234",
        https_proxy: "http://127.0.0.1:1234",
        SSL_CERT_FILE: sourceCa
      }
    });
    const bashTool = sandbox.createTools().find((tool) => tool.name === "bash");
    assert.ok(bashTool);
    const result = await bashTool.execute(
      "call:env",
      { command: "env" },
      new AbortController().signal,
      () => undefined,
      {} as never
    );
    const output = result.content.find((item) => item.type === "text")?.text ?? "";
    assert.doesNotMatch(output, /^(?:ALL_PROXY|all_proxy|NO_PROXY|no_proxy)=/m);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("executor sandbox whitelists additional read roots such as project skills", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-sandbox-skills-"));
  const projectDir = mkdtempSync(join(tmpdir(), "luanniao-project-"));
  const skillsRoot = join(projectDir, ".agents", "skills");
  const skillFile = join(skillsRoot, "recon-port-scan", "SKILL.md");
  mkdirSync(dirname(skillFile), { recursive: true });
  writeFileSync(skillFile, "skill-guide");
  writeFileSync(join(projectDir, "secret.txt"), "project-secret");

  const sandbox = await createExecutorSandbox({
    runtimeDir,
    runId: "run",
    mode: "workspace",
    additionalReadRoots: [skillsRoot]
  });
  assert.ok(sandbox.allowedReadRoots.includes(realpathSync(skillsRoot)));
  const policy = new SandboxPathPolicy(sandbox.root, sandbox.allowedReadRoots);

  assert.equal(readFileSync(await policy.requireReadable(skillFile), "utf8"), "skill-guide");
  await assert.rejects(
    () => policy.requireReadable(join(projectDir, "secret.txt")),
    /denied path outside allowed roots/
  );
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

test("executor sandbox bash enforces the default timeout when the model omits it", async () => {
  const previous = process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S;
  process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S = "1";
  try {
    const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-sandbox-timeout-"));
    const sandbox = await createExecutorSandbox({ runtimeDir, runId: "run", mode: "workspace" });
    const bashTool = sandbox.createTools().find((tool) => tool.name === "bash");
    assert.ok(bashTool);
    const startedAt = Date.now();
    await assert.rejects(
      () => bashTool.execute(
        "call:timeout",
        { command: "sleep 30" },
        new AbortController().signal,
        () => undefined,
        {} as never
      ),
      /timed out after 1 seconds/
    );
    assert.ok(Date.now() - startedAt < 15_000, "default timeout should kill the command well before it finishes");
  } finally {
    if (previous === undefined) {
      delete process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S;
    } else {
      process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S = previous;
    }
  }
});

test("executor sandbox bash honors an explicit model timeout over the default", async () => {
  const previous = process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S;
  process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S = "1";
  try {
    const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-sandbox-timeout-override-"));
    const sandbox = await createExecutorSandbox({ runtimeDir, runId: "run", mode: "workspace" });
    const bashTool = sandbox.createTools().find((tool) => tool.name === "bash");
    assert.ok(bashTool);
    const result = await bashTool.execute(
      "call:timeout-override",
      { command: "sleep 2; echo survived", timeout: 10 },
      new AbortController().signal,
      () => undefined,
      {} as never
    );
    const output = result.content.find((item) => item.type === "text")?.text ?? "";
    assert.ok(output.includes("survived"));
  } finally {
    if (previous === undefined) {
      delete process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S;
    } else {
      process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S = previous;
    }
  }
});
