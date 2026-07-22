import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { TrafficProxyManager } from "../src/connectivity/traffic-proxy-manager.js";
import { TrafficProxyManagerRegistry } from "../src/connectivity/traffic-proxy-manager-registry.js";
import { ensureTrafficProxySocketDir, trafficProxyRuntimeIdentity } from "../src/connectivity/traffic-proxy-runtime.js";

const binary = join(process.cwd(), "traffic-proxy", "bin", "traffic-proxy");

test("registry canonicalizes runtime identity and owns one long-lived manager", async () => {
  const root = await mkdtemp("/tmp/traffic-proxy-registry-");
  const runtime = join(root, "runtime");
  const events: string[] = [];
  const registry = new TrafficProxyManagerRegistry({
    binary,
    logEventForRuntime: async (_runtimeDir, event) => { events.push(event.eventType); }
  });
  try {
    const first = await registry.get(runtime);
    const canonical = await realpath(runtime);
    const second = await registry.get(join(canonical, "."));
    assert.equal(first, second);
    assert.equal(registry.size, 1);
    assert.equal(first.ownsProcess(), true);
    assert.equal((await first.client.health()).status, "ok");
    assert.equal(first.caCertPath, join(canonical, "traffic-proxy", "data", "ca", first.runtimeRef!, "ca.crt"));
    assert.match(first.proxyUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    const originalAllProxy = process.env.ALL_PROXY;
    const environment = first.managedEnvironment({
      ALL_PROXY: "socks5://forbidden",
      all_proxy: "socks5://forbidden",
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1"
    });
    assert.equal(process.env.ALL_PROXY, originalAllProxy);
    assert.equal(environment.HTTP_PROXY, first.proxyUrl);
    assert.equal(environment.HTTPS_PROXY, first.proxyUrl);
    assert.equal(environment.http_proxy, first.proxyUrl);
    assert.equal(environment.https_proxy, first.proxyUrl);
    assert.equal(environment.NO_PROXY, undefined);
    assert.equal(environment.no_proxy, undefined);
    assert.equal(environment.SSL_CERT_FILE, first.caCertPath);
    assert.equal(environment.CURL_CA_BUNDLE, first.caCertPath);
    assert.equal(environment.NODE_EXTRA_CA_CERTS, first.caCertPath);
    assert.equal(environment.ALL_PROXY, undefined);
    assert.equal(environment.all_proxy, undefined);
    assert.deepEqual(events, ["traffic_proxy_sidecar_lifecycle", "traffic_proxy_ca_created", "traffic_proxy_ready"]);
  } finally {
    await registry.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("registry shutdown does not stop a sidecar owned by another manager", async () => {
  const root = await mkdtemp("/tmp/traffic-proxy-ownership-");
  const runtime = join(root, "runtime");
  const owner = new TrafficProxyManager(runtime, { binary });
  const registry = new TrafficProxyManagerRegistry({ binary });
  try {
    await owner.start();
    const attached = await registry.get(runtime);
    assert.equal(owner.ownsProcess(), true);
    assert.equal(attached.ownsProcess(), false);
    assert.equal(attached.proxyUrl, owner.proxyUrl);
    assert.equal(attached.managedEnvironment({}).HTTP_PROXY, owner.proxyUrl);
    await registry.closeAll();
    assert.equal((await owner.client.health()).status, "ok");
  } finally {
    await owner.close();
    await registry.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("registry evicts an owned manager when its sidecar exits", async () => {
  const root = await mkdtemp("/tmp/traffic-proxy-exit-");
  const runtime = join(root, "runtime");
  const registry = new TrafficProxyManagerRegistry({ binary });
  try {
    const first = await registry.get(runtime);
    await first.client.shutdown();
    for (let attempt = 0; attempt < 100 && registry.has(runtime); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(registry.has(runtime), false);
    const replacement = await registry.get(runtime);
    assert.notEqual(replacement, first);
    assert.equal((await replacement.client.health()).status, "ok");
  } finally {
    await registry.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("manager waits for a failed startup child to exit before rejecting", async () => {
  const root = await mkdtemp("/tmp/traffic-proxy-startup-failure-");
  const runtime = join(root, "runtime");
  const marker = join(root, "child-exited");
  const wrapper = join(root, "traffic-proxy-wrapper");
  const script = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {
  setTimeout(() => {
    writeFileSync(${JSON.stringify(marker)}, "exited");
    process.exit(0);
  }, 100);
});
process.stdout.write("invalid ready line\\n");
setInterval(() => {}, 1000);
`;
  try {
    await writeFile(wrapper, script, { mode: 0o700 });
    await chmod(wrapper, 0o700);
    const manager = new TrafficProxyManager(runtime, { binary: wrapper });
    await assert.rejects(manager.start(), /invalid traffic-proxy ready line/);
    assert.equal(await readFile(marker, "utf8"), "exited");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manager rejects a spawned ready line with the wrong runtime identity", async () => {
  const root = await mkdtemp("/tmp/traffic-proxy-ready-identity-");
  const runtime = join(root, "runtime");
  const wrapper = join(root, "traffic-proxy-wrapper");
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
process.on("SIGTERM", () => process.exit(0));
process.stdout.write(\`proxy=127.0.0.1:1 control=\${value("-control-socket")} data=\${value("-data-dir")} runtime_ref=wrong-runtime\\n\`);
setInterval(() => {}, 1000);
`;
  try {
    await writeFile(wrapper, script, { mode: 0o700 });
    await chmod(wrapper, 0o700);
    const manager = new TrafficProxyManager(runtime, { binary: wrapper });
    await assert.rejects(manager.start(), /ready runtime identity mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent closeAll calls share one promise and reject later get calls", async () => {
  const registry = new TrafficProxyManagerRegistry({ binary });
  const first = registry.closeAll();
  const second = registry.closeAll();
  assert.equal(first, second);
  await assert.rejects(registry.get("/tmp/traffic-proxy-closed-registry"), /registry is closing/);
  await first;
});

test("long project runtime uses the private agent-runtime socket directory", async () => {
  const root = await mkdtemp(join(process.cwd(), ".agent-runtime", "traffic-proxy-long-"));
  const runtime = join(root, "deep-runtime-".repeat(8), "session");
  const alias = join(root, "runtime-alias");
  const owner = new TrafficProxyManager(runtime, { binary });
  let attached: TrafficProxyManager | undefined;
  try {
    assert.ok(Buffer.byteLength(join(runtime, "traffic-proxy", "control.sock"), "utf8") > 103);
    await owner.start();
    assert.equal((await owner.client.historyList()).items.length, 0);
    assert.equal(owner.controlSocket.startsWith(join(process.cwd(), ".agent-runtime", ".s")), true);
    assert.ok(Buffer.byteLength(owner.controlSocket, "utf8") <= 103);
    assert.equal((await lstat(join(process.cwd(), ".agent-runtime", ".s"))).mode & 0o777, 0o700);

    await symlink(runtime, alias);
    attached = new TrafficProxyManager(alias, { binary });
    await attached.start();
    assert.equal(attached.ownsProcess(), false);
    assert.equal(attached.runtimeDir, owner.runtimeDir);
    assert.equal(attached.requestedRuntimeRef, owner.requestedRuntimeRef);
    assert.equal(attached.controlSocket, owner.controlSocket);
  } finally {
    await attached?.close();
    await owner.close();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await lstat(owner.controlSocket);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch {
        break;
      }
    }
    await assert.rejects(lstat(owner.controlSocket), /ENOENT/);
    await rm(root, { recursive: true, force: true });
  }
});

test("manager rejects a control socket serving a different runtime identity", async () => {
  const root = await mkdtemp("/tmp/traffic-proxy-identity-");
  const runtimeA = join(root, "runtime-a");
  const runtimeB = join(root, "runtime-b");
  const identityA = trafficProxyRuntimeIdentity(runtimeA);
  const identityB = trafficProxyRuntimeIdentity(runtimeB);
  await ensureTrafficProxySocketDir(identityA.socketDir);
  const server = createServer((socket: Socket) => {
    socket.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8").trim()) as { id: string };
      socket.end(`${JSON.stringify({ version: 1, id: request.id, ok: true, result: { runtime_ref: identityB.runtimeRef, proxy: "127.0.0.1:1" } })}\n`);
    });
  });
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(identityA.controlSocket, resolveListen);
    });
    const manager = new TrafficProxyManager(runtimeA, { binary });
    await assert.rejects(manager.attachExisting(), /runtime identity mismatch/);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});

test("custom runtime fails clearly when its centralized socket path is too long", () => {
  const runtime = join("/tmp", "custom-runtime-root-".repeat(6), "runtime");
  assert.throws(
    () => trafficProxyRuntimeIdentity(runtime),
    /control socket path is \d+ UTF-8 bytes; maximum is 103/
  );
  assert.throws(
    () => new TrafficProxyManager(runtime, { binary }),
    /control socket path is \d+ UTF-8 bytes; maximum is 103/
  );
});
