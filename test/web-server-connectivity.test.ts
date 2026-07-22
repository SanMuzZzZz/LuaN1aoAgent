import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { ConnectivityStore } from "../src/stores/connectivity-store.js";
import { SQLiteGraphStore } from "../src/stores/graph-store.js";
import { WebAuthService } from "../src/web-auth.js";

type Fixture = {
  baseUrl: string;
  root: string;
  runtimeDir: string;
  adminCookie: string;
  analystCookie: string;
  process: ChildProcess;
};

let fixture: Fixture;

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

test.before(async () => {
  fixture = await createFixture();
});

test.after(async () => {
  if (fixture) await destroyFixture(fixture);
});

test("connectivity routes require authentication, admin capability, and CSRF", async () => {
  const unauthenticated = await fetch(`${fixture.baseUrl}/api/connectivity?runtimeDir=${encodeURIComponent(fixture.runtimeDir)}`);
  assert.equal(unauthenticated.status, 401);

  const analystRead = await authenticatedGet(fixture.analystCookie, "/api/connectivity");
  assert.equal(analystRead.status, 200);

  const analystMutation = await mutate(fixture.analystCookie, "/api/connectivity/tunnels", tunnelBody(), true);
  assert.equal(analystMutation.status, 403);
  assert.equal((await json(analystMutation)).error.code, "authorization_forbidden");

  const adminWithoutCsrf = await fetch(`${fixture.baseUrl}/api/connectivity/tunnels`, {
    method: "POST",
    headers: { cookie: fixture.adminCookie, "content-type": "application/json" },
    body: JSON.stringify(tunnelBody())
  });
  assert.equal(adminWithoutCsrf.status, 403);
  assert.equal((await json(adminWithoutCsrf)).error.code, "csrf_token_missing");
});

test("connectivity GET stays read-only while traffic history restores the runtime sidecar", async () => {
  const emptyRuntime = join(fixture.root, "empty-runtime");
  await mkdir(emptyRuntime);
  const response = await fetch(`${fixture.baseUrl}/api/connectivity?runtimeDir=${encodeURIComponent(emptyRuntime)}`, {
    headers: { cookie: fixture.analystCookie }
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await json(response)).connections, []);
  await assert.rejects(access(join(emptyRuntime, "state.sqlite")));
  await assert.rejects(access(join(emptyRuntime, "state.sqlite-wal")));
  await assert.rejects(access(join(emptyRuntime, "state.sqlite-shm")));

  const traffic = await fetch(`${fixture.baseUrl}/api/traffic/history?runtimeDir=${encodeURIComponent(emptyRuntime)}`, {
    headers: { cookie: fixture.analystCookie }
  });
  assert.equal(traffic.status, 200);
  assert.deepEqual((await json(traffic)).items, []);
  await access(join(emptyRuntime, "traffic-proxy", "data", "traffic.sqlite"));
});

test("admin creates managed SSH tunnels and receives safe status DTOs", async () => {
  const created = await mutate(fixture.adminCookie, "/api/connectivity/tunnels", tunnelBody(), true);
  assert.equal(created.status, 201);
  const connection = await json(created);
  assert.equal(connection.kind, "tunnel");
  assert.equal(connection.transport, "ssh");
  assert.equal(connection.managed, true);
  assert.equal(connection.credentialRef, "credential:ssh:test");
  assert.equal(connection.desiredState, "stopped");
  assert.equal(typeof connection.observedState, "string");
  assert.equal(typeof connection.available, "boolean");
  assert.match(connection.graphUrl, /view=operation/);
  assert.equal(connection.definition, undefined);

  const listed = await authenticatedGet(fixture.adminCookie, "/api/connectivity");
  assert.equal(listed.status, 200);
  const listBody = await json(listed);
  const item = listBody.connections.find((candidate: Record<string, unknown>) => candidate.id === connection.id);
  assert(item);
  for (const field of ["direction", "transport", "managed", "desiredState", "observedState", "available", "graphUrl"]) {
    assert.ok(Object.hasOwn(item, field), field);
  }
  assert.equal(item.definition, undefined);
  assert.equal(item.credentialRef, "credential:ssh:test");

  const analystListed = await authenticatedGet(fixture.analystCookie, "/api/connectivity");
  const analystItem = (await json(analystListed)).connections.find((candidate: Record<string, unknown>) => candidate.id === connection.id);
  assert(analystItem);
  assert.equal(Object.hasOwn(analystItem, "credentialRef"), false);

  const analystState = await authenticatedGet(fixture.analystCookie, "/api/state");
  assert.equal(analystState.status, 200);
  assert.equal(JSON.stringify(await json(analystState)).includes("credential:ssh:test"), false);

  const stopped = await mutate(
    fixture.adminCookie,
    `/api/connectivity/${encodeURIComponent(connection.id)}/stop`,
    { runtimeDir: fixture.runtimeDir },
    true
  );
  assert.equal(stopped.status, 200);
  assert.equal((await json(stopped)).desiredState, "stopped");
});

test("managed SSH session desired lifecycle supports start, stop, and close", async () => {
  const created = await mutate(fixture.adminCookie, "/api/connectivity/sessions", {
    runtimeDir: fixture.runtimeDir,
    externalId: "web-session-test",
    sessionType: "agent",
    hostRef: "host:target",
    host: "target.example",
    user: "operator",
    credentialRef: "credential:ssh:session",
    concurrencySafe: false
  }, true);
  assert.equal(created.status, 201);
  const connection = await json(created);
  assert.equal(connection.kind, "session");
  assert.equal(connection.managed, true);

  for (const [action, desiredState] of [["start", "running"], ["stop", "stopped"], ["close", "closed"]] as const) {
    const response = await mutate(
      fixture.adminCookie,
      `/api/connectivity/${encodeURIComponent(connection.id)}/${action}`,
      { runtimeDir: fixture.runtimeDir },
      true
    );
    assert.equal(response.status, 200, action);
    assert.equal((await json(response)).desiredState, desiredState);
  }
});

test("connectivity input rejects path breakout and inline credentials without leaks", async () => {
  const breakout = await mutate(fixture.adminCookie, "/api/connectivity/tunnels", {
    ...tunnelBody(),
    runtimeDir: "../outside"
  }, true);
  assert.equal(breakout.status, 403);
  const breakoutText = await breakout.text();
  assert.match(breakoutText, /runtime_path_outside_root/);
  assert.doesNotMatch(breakoutText, new RegExp(escapeRegExp(fixture.root)));

  for (const body of [
    { ...tunnelBody(), password: "VERY_SECRET" },
    { ...tunnelBody(), metadata: { privateKey: "PRIVATE_KEY_SECRET" } }
  ]) {
    const response = await mutate(fixture.adminCookie, "/api/connectivity/tunnels", body, true);
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.match(text, /inline_credential_forbidden/);
    assert.doesNotMatch(text, /VERY_SECRET|PRIVATE_KEY_SECRET/);
  }
});

function tunnelBody(): Record<string, unknown> {
  return {
    runtimeDir: fixture.runtimeDir,
    externalId: "web-tunnel-test",
    fromHostRef: "host:local",
    toHostRef: "host:target",
    host: "target.example",
    user: "operator",
    credentialRef: "credential:ssh:test",
    desiredState: "stopped",
    forwards: [{ mode: "local", bindHost: "127.0.0.1", bindPort: 18080, targetHost: "127.0.0.1", targetPort: 8080 }]
  };
}

async function authenticatedGet(cookie: string, pathname: string): Promise<Response> {
  return fetch(`${fixture.baseUrl}${pathname}?runtimeDir=${encodeURIComponent(fixture.runtimeDir)}`, {
    headers: { cookie }
  });
}

async function mutate(cookie: string, pathname: string, body: Record<string, unknown>, csrf: boolean): Promise<Response> {
  let requestCookie = cookie;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrf) {
    const csrfResponse = await fetch(`${fixture.baseUrl}/api/auth/csrf`, { headers: { cookie } });
    assert.equal(csrfResponse.status, 200);
    const token = (await json(csrfResponse)).csrfToken as string;
    const csrfCookie = csrfResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert(csrfCookie);
    requestCookie = `${cookie}; ${csrfCookie}`;
    headers["x-csrf-token"] = token;
  }
  headers.cookie = requestCookie;
  return fetch(`${fixture.baseUrl}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp("/tmp/ln-connectivity-");
  const runtimeDir = join(root, "runtime-a");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "execution.jsonl"), "");
  await writeFile(join(runtimeDir, "graph-deltas.jsonl"), "");
  const store = new ConnectivityStore(join(runtimeDir, "state.sqlite"));
  store.close();
  const graph = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "graph-deltas.jsonl"));
  graph.upsertDelta({
    sourceEventIds: [],
    nodes: [
      { id: "host:local", graphKind: "operation", type: "Host", label: "Local", properties: {} },
      { id: "host:target", graphKind: "operation", type: "Host", label: "Target", properties: {} }
    ],
    edges: []
  });
  graph.close();

  const auth = new WebAuthService(join(root, "auth.sqlite"));
  const admin = await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  const analyst = await auth.register({ username: "analyst", displayName: "Analyst", password: "analyst-password-456" });
  auth.close();

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
    runtimeDir,
    adminCookie: `luanniao_session=${encodeURIComponent(admin.token)}`,
    analystCookie: `luanniao_session=${encodeURIComponent(analyst.token)}`,
    process: child
  };
}

async function destroyFixture(value: Fixture): Promise<void> {
  if (value.process.exitCode === null && value.process.signalCode === null) {
    value.process.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      value.process.once("exit", () => resolveExit());
      setTimeout(resolveExit, 3_000).unref();
    });
  }
  await rm(value.root, { recursive: true, force: true });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
