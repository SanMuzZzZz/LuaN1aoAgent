import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { ensureTrafficProxySocketDir, trafficProxyRuntimeIdentity } from "../src/connectivity/traffic-proxy-runtime.js";
import { WebAuthService } from "../src/web-auth.js";
import { hasCapability } from "../src/web-security.js";

type ControlRequest = {
  version: number;
  id: string;
  command: string;
  [key: string]: unknown;
};

type Fixture = {
  baseUrl: string;
  root: string;
  runtimeA: string;
  runtimeB: string;
  outside: string;
  analystCookie: string;
  requests: ControlRequest[];
  failNextHistory: (secret: string) => void;
};

const publicCertificate = "-----BEGIN CERTIFICATE-----\nPUBLIC-ONLY\n-----END CERTIFICATE-----\n";

let fixture: Fixture;

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

function analystGet(pathname: string, headers: Record<string, string> = {}): Promise<Response> {
  const fixturePath = pathname
    .replaceAll("runtimeDir=runtime-a", `runtimeDir=${encodeURIComponent(fixture.runtimeA)}`)
    .replaceAll("rootDir=.", `rootDir=${encodeURIComponent(fixture.root)}`);
  return fetch(`${fixture.baseUrl}${fixturePath}`, {
    headers: { cookie: fixture.analystCookie, ...headers }
  });
}

test.before(async () => {
  fixture = await createFixture();
});

test.after(async () => {
  if (fixture) await destroyFixture(fixture);
});

test("actual GET routes reject unauthenticated requests and exempt authenticated GET from CSRF", async () => {
  for (const pathname of [
    "/api/state?runtimeDir=runtime-a",
    "/api/traffic/history?runtimeDir=runtime-a",
    "/api/traffic/history/7?runtimeDir=runtime-a",
    "/api/traffic/history/7/body?runtimeDir=runtime-a&side=response",
    "/api/traffic/ca?runtimeDir=runtime-a",
    "/api/artifact?runtimeDir=runtime-a&artifactRef=artifact:public"
  ]) {
    const response = await fetch(`${fixture.baseUrl}${pathname}`);
    assert.equal(response.status, 401, pathname);
    assert.equal((await json(response)).error.code, "unauthorized");
  }

  const response = await analystGet("/api/state?runtimeDir=runtime-a", {
    origin: "https://attacker.invalid"
  });
  assert.equal(response.status, 200);
  assert.equal((await json(response)).runtimeDir, await realpath(fixture.runtimeA));
});

test("analyst reaches metadata and sensitive-read GET routes but lacks export and credential capabilities", async () => {
  const auth = new WebAuthService(join(fixture.root, "auth.sqlite"));
  const analyst = (await auth.login({ username: "analyst", password: "analyst-password-456" })).user;
  assert.equal(hasCapability(analyst, "viewer:metadata"), true);
  assert.equal(hasCapability(analyst, "traffic:read-sensitive"), true);
  assert.equal(hasCapability(analyst, "admin:export"), false);
  assert.equal(hasCapability(analyst, "admin:credential"), false);

  const sessions = await analystGet("/api/sessions?rootDir=.");
  assert.equal(sessions.status, 200);
  const runs = await analystGet("/api/runs");
  assert.equal(runs.status, 200);

  const artifact = await analystGet("/api/artifact?runtimeDir=runtime-a&artifactRef=artifact:public");
  assert.equal(artifact.status, 200);
  assert.equal((await json(artifact)).content, "analyst-readable");

  const list = await analystGet("/api/traffic/history?runtimeDir=runtime-a");
  assert.equal(list.status, 200);
  const detail = await analystGet("/api/traffic/history/7?runtimeDir=runtime-a");
  assert.equal(detail.status, 200);
  const body = await analystGet("/api/traffic/history/7/body?runtimeDir=runtime-a&side=response");
  assert.equal(body.status, 200);
  const ca = await analystGet("/api/traffic/ca?runtimeDir=runtime-a");
  assert.equal(ca.status, 200);
});

test("runtime query parameters enforce canonical containment including traversal and symlinks", async () => {
  const attempts = [
    "../outside",
    fixture.outside,
    join(fixture.root, "runtime-a-link")
  ];
  for (const runtimeDir of attempts) {
    const response = await analystGet(`/api/state?runtimeDir=${encodeURIComponent(runtimeDir)}`);
    assert.equal(response.status, 403, runtimeDir);
    const text = await response.text();
    assert.match(text, /runtime_path_outside_root/);
    assert.doesNotMatch(text, new RegExp(escapeRegExp(fixture.outside)));
    assert.doesNotMatch(text, /BREAKOUT_SECRET/);
  }

  const response = await analystGet("/api/artifact?runtimeDir=runtime-a&artifactRef=artifact:cross-runtime");
  assert.equal(response.status, 403);
  const text = await response.text();
  assert.match(text, /artifact_path_forbidden/);
  assert.doesNotMatch(text, /RUNTIME_B_SECRET/);
  assert.doesNotMatch(text, new RegExp(escapeRegExp(fixture.runtimeB)));
});

test("history pagination and detail/body routes emit exact control protocol fields", async () => {
  const before = fixture.requests.length;
  const listResponse = await analystGet(
    "/api/traffic/history?runtimeDir=runtime-a&cursor=next-1&limit=25&runtime_ref=rr&task_ref=tt&run_ref=run&route_ref=route&session_ref=session&started_after=2026-01-01T00%3A00%3A00Z&started_before=2026-01-02T00%3A00%3A00Z&mode=mitm&method=POST&host=example.test&connect_ref=conn&error=tls&status=201"
  );
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await json(listResponse), { items: [], has_more: true, next_cursor: "next-2" });
  const listRequest = fixture.requests.slice(before).find((request) => request.command === "history_list");
  assert.deepEqual(withoutRequestEnvelope(listRequest!), {
    command: "history_list",
    cursor: "next-1",
    limit: 25,
    filter: {
      runtime_ref: "rr",
      task_ref: "tt",
      run_ref: "run",
      route_ref: "route",
      session_ref: "session",
      started_after: "2026-01-01T00:00:00Z",
      started_before: "2026-01-02T00:00:00Z",
      mode: "mitm",
      method: "POST",
      host: "example.test",
      connect_ref: "conn",
      error: "tls",
      status: 201
    }
  });

  const detail = await analystGet("/api/traffic/history/42?runtimeDir=runtime-a");
  assert.equal(detail.status, 200);
  assert.equal((await json(detail)).id, 42);
  assert.deepEqual(withoutRequestEnvelope(fixture.requests.at(-1)!), { command: "history_get", exchange_id: 42 });

  const body = await analystGet("/api/traffic/history/42/body?runtimeDir=runtime-a&side=request&byteLimit=4096");
  assert.equal(body.status, 200);
  assert.equal((await json(body)).side, "request");
  assert.deepEqual(withoutRequestEnvelope(fixture.requests.at(-1)!), {
    command: "history_body",
    exchange_id: 42,
    side: "request",
    byte_limit: 4096
  });

  for (const pathname of [
    "/api/traffic/history?runtimeDir=runtime-a&limit=101",
    "/api/traffic/history/42/body?runtimeDir=runtime-a&side=invalid",
    "/api/traffic/history/42/body?runtimeDir=runtime-a&side=response&byteLimit=262145",
    "/api/traffic/history/0?runtimeDir=runtime-a"
  ]) {
    const response = await analystGet(pathname);
    assert.equal(response.status, 400, pathname);
    assert.equal((await json(response)).error.code, "invalid_request");
  }
});

test("CA response contains only the public certificate and hardened headers", async () => {
  const response = await analystGet("/api/traffic/ca?runtimeDir=runtime-a");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), publicCertificate);
  assert.equal(response.headers.get("content-type"), "application/x-pem-file");
  assert.equal(response.headers.get("content-disposition"), "attachment; filename=traffic-proxy-ca.crt");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.doesNotMatch(publicCertificate, /PRIVATE KEY/);

  await writeFile(join(fixture.runtimeA, "traffic-proxy", "data", "ca", trafficProxyRuntimeIdentity(fixture.runtimeA).runtimeRef, "ca.crt"), `${publicCertificate}-----BEGIN PRIVATE KEY-----\nCA_SECRET\n`);
  const invalid = await analystGet("/api/traffic/ca?runtimeDir=runtime-a");
  assert.equal(invalid.status, 500);
  const invalidText = await invalid.text();
  assert.match(invalidText, /ca_certificate_invalid/);
  assert.doesNotMatch(invalidText, /CA_SECRET|PRIVATE KEY|traffic-proxy\/data/);
  await writeFile(join(fixture.runtimeA, "traffic-proxy", "data", "ca", trafficProxyRuntimeIdentity(fixture.runtimeA).runtimeRef, "ca.crt"), publicCertificate);
});

test("traffic failures return stable errors without internal paths or secrets", async () => {
  const secret = `CONTROL_SECRET ${fixture.outside}/private.key`;
  fixture.failNextHistory(secret);
  const response = await analystGet("/api/traffic/history?runtimeDir=runtime-a");
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /traffic_history_error/);
  assert.doesNotMatch(text, /CONTROL_SECRET|private\.key/);
  assert.doesNotMatch(text, new RegExp(escapeRegExp(fixture.outside)));
});

async function createFixture(): Promise<Fixture & { process: ChildProcess; controlServer: Server }> {
  const root = await mkdtemp("/tmp/lnw-");
  const runtimeA = join(root, "runtime-a");
  const runtimeB = join(root, "runtime-b");
  const outside = await mkdtemp("/tmp/lnw-out-");
  const runtimeIdentity = trafficProxyRuntimeIdentity(runtimeA);
  await Promise.all([
    mkdir(join(runtimeA, "artifacts"), { recursive: true }),
    mkdir(join(runtimeA, "traffic-proxy", "data", "ca", runtimeIdentity.runtimeRef), { recursive: true }),
    mkdir(join(runtimeB, "artifacts"), { recursive: true }),
    writeFile(join(outside, "secret.txt"), "BREAKOUT_SECRET")
  ]);
  await writeFile(join(runtimeA, "execution.jsonl"), "");
  await writeFile(join(runtimeA, "graph-deltas.jsonl"), "");
  await writeFile(join(runtimeA, "artifacts", "public.txt"), "analyst-readable");
  await writeFile(join(runtimeB, "artifacts", "secret.txt"), "RUNTIME_B_SECRET");
  await writeFile(join(runtimeA, "artifacts", "index.jsonl"), [
    JSON.stringify({ artifactRef: "artifact:public", path: join(runtimeA, "artifacts", "public.txt"), mediaType: "text/plain", byteLength: 16 }),
    JSON.stringify({ artifactRef: "artifact:cross-runtime", path: join(runtimeB, "artifacts", "secret.txt"), mediaType: "text/plain", byteLength: 16 })
  ].join("\n") + "\n");
  await writeFile(join(runtimeA, "traffic-proxy", "data", "ca", runtimeIdentity.runtimeRef, "ca.crt"), publicCertificate);
  await symlink(outside, join(root, "runtime-a-link"));

  const auth = new WebAuthService(join(root, "auth.sqlite"));
  await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  const analyst = await auth.register({ username: "analyst", displayName: "Analyst", password: "analyst-password-456" });

  const requests: ControlRequest[] = [];
  let failure: string | undefined;
  const controlServer = createServer((socket) => handleControlSocket(socket, requests, runtimeIdentity.runtimeRef, () => {
    const value = failure;
    failure = undefined;
    return value;
  }));
  await ensureTrafficProxySocketDir(runtimeIdentity.socketDir);
  const socketPath = runtimeIdentity.controlSocket;
  await new Promise<void>((resolveListen, rejectListen) => {
    controlServer.once("error", rejectListen);
    controlServer.listen(socketPath, resolveListen);
  });

  const port = await reservePort();
  const child = spawn(process.execPath, [
    resolve("dist/src/web-server.js"),
    "--host", "127.0.0.1",
    "--port", String(port),
    "--runtime-dir", root,
    "--auth-db", join(root, "auth.sqlite")
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(child, baseUrl);

  return {
    baseUrl,
    root,
    runtimeA,
    runtimeB,
    outside,
    analystCookie: `luanniao_session=${encodeURIComponent(analyst.token)}`,
    requests,
    failNextHistory: (secret: string) => { failure = secret; },
    process: child,
    controlServer
  };
}

async function destroyFixture(value: Fixture & Partial<{ process: ChildProcess; controlServer: Server }>): Promise<void> {
  if (value.process && value.process.exitCode === null && value.process.signalCode === null) {
    value.process.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      value.process!.once("exit", () => resolveExit());
      setTimeout(resolveExit, 3_000).unref();
    });
  }
  if (value.controlServer) await new Promise<void>((resolveClose) => value.controlServer!.close(() => resolveClose()));
  await rm(value.root, { recursive: true, force: true });
  await rm(value.outside, { recursive: true, force: true });
}

function handleControlSocket(socket: Socket, requests: ControlRequest[], runtimeRef: string, takeFailure: () => string | undefined): void {
  let input = "";
  socket.on("data", (chunk: Buffer) => {
    input += chunk.toString("utf8");
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(input.slice(0, newline)) as ControlRequest;
    requests.push(request);
    const failure = request.command.startsWith("history_") ? takeFailure() : undefined;
    if (failure) {
      socket.end(`${JSON.stringify({ version: 1, id: request.id, ok: false, error: failure })}\n`);
      return;
    }
    const result = request.command === "hello"
      ? { protocol: "luanniao-traffic-proxy", version: 1, runtime_ref: runtimeRef, proxy: "127.0.0.1:8080" }
      : request.command === "history_list"
        ? { items: [], has_more: Boolean(request.cursor), ...(request.cursor ? { next_cursor: "next-2" } : {}) }
        : request.command === "history_get"
          ? { id: request.exchange_id }
          : request.command === "history_body"
            ? { exchange_id: request.exchange_id, side: request.side, body_ref: "body:test", encoding: "base64", data: "dGVzdA==", bytes: 4, truncated: false }
            : {};
    socket.end(`${JSON.stringify({ version: 1, id: request.id, ok: true, result })}\n`);
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function waitForServer(child: ChildProcess, baseUrl: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`web server exited early (${child.exitCode}): ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/csrf`);
      if (response.status === 200) return;
    } catch {
      // Server has not started listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`timed out waiting for web server: ${stderr}`);
}

function withoutRequestEnvelope(request: ControlRequest): Record<string, unknown> {
  const { version: _version, id: _id, ...fields } = request;
  return fields;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
