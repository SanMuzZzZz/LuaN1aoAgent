import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bootstrapAgentRuntime } from "../src/agent-runtime-bootstrap.js";
import { TrafficProxyManager } from "../src/connectivity/traffic-proxy-manager.js";
import { TrafficProxyManagerRegistry } from "../src/connectivity/traffic-proxy-manager-registry.js";
import type { SecurityAgentController } from "../src/controller.js";

const binary = join(process.cwd(), "traffic-proxy", "bin", "traffic-proxy");

function fakeController(input: {
  runId: string;
  initialize?: () => Promise<void>;
  close?: () => Promise<void>;
}): SecurityAgentController {
  return {
    runId: input.runId,
    initialize: input.initialize ?? (async () => undefined),
    close: input.close ?? (async () => undefined)
  } as unknown as SecurityAgentController;
}

test("shared bootstrap starts a fresh sidecar, injects environment, and attributes managed HTTP", async () => {
  const root = await mkdtemp("/tmp/agent-runtime-bootstrap-");
  const runtimeDir = join(root, "runtime");
  const registry = new TrafficProxyManagerRegistry({ binary });
  const target = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolveListen) => target.listen(0, "127.0.0.1", resolveListen));
  const address = target.address();
  assert.ok(address && typeof address !== "string");
  let injectedEnvironment: NodeJS.ProcessEnv | undefined;
  try {
    const runtime = await bootstrapAgentRuntime({
      cwd: process.cwd(),
      runtimeDir,
      routeRef: "test-run",
      trafficProxyRegistry: registry,
      controllerFactory: (input) => {
        injectedEnvironment = input.environment;
        return fakeController({ runId: "run:fresh" });
      }
    });
    assert.equal(runtime.trafficProxyManager.ownsProcess(), true);
    assert.equal(injectedEnvironment?.HTTP_PROXY, runtime.trafficProxyManager.proxyUrl);
    assert.equal(injectedEnvironment?.http_proxy, runtime.trafficProxyManager.proxyUrl);

    await requestThroughProxy(
      runtime.trafficProxyManager.proxyUrl!,
      `http://127.0.0.1:${address.port}/scope-check`
    );
    const page = await runtime.trafficProxyManager.client.historyList({ limit: 10 });
    const exchange = page.items.find((item) => item.url.endsWith("/scope-check"));
    assert.ok(exchange);
    assert.equal(exchange.run_ref, "run:fresh");
    assert.equal(exchange.task_ref, "run:fresh");
    assert.equal(exchange.session_ref, "run:fresh");
    assert.equal(exchange.route_ref, "test-run");
    assert.equal(exchange.attribution, "security-agent");

    await runtime.close();
    assert.equal(registry.has(runtimeDir), false);
  } finally {
    target.close();
    await registry.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("shared bootstrap attaches without killing the owner on close", async () => {
  const root = await mkdtemp("/tmp/agent-runtime-attach-");
  const runtimeDir = join(root, "runtime");
  const owner = new TrafficProxyManager(runtimeDir, { binary });
  const registry = new TrafficProxyManagerRegistry({ binary });
  try {
    await owner.start();
    const runtime = await bootstrapAgentRuntime({
      cwd: process.cwd(),
      runtimeDir,
      routeRef: "test-attach",
      trafficProxyRegistry: registry,
      controllerFactory: () => fakeController({ runId: "run:attached" })
    });
    assert.equal(runtime.trafficProxyManager.ownsProcess(), false);
    await runtime.close();
    assert.equal((await owner.client.health()).status, "ok");
  } finally {
    await registry.closeAll();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("shared bootstrap cleans controller and owned sidecar after initialization failure", async () => {
  const root = await mkdtemp("/tmp/agent-runtime-failure-");
  const runtimeDir = join(root, "runtime");
  const registry = new TrafficProxyManagerRegistry({ binary });
  let controllerClosed = false;
  try {
    await assert.rejects(
      bootstrapAgentRuntime({
        cwd: process.cwd(),
        runtimeDir,
        routeRef: "test-failure",
        trafficProxyRegistry: registry,
        controllerFactory: () => fakeController({
          runId: "run:failure",
          initialize: async () => { throw new Error("initialize failed"); },
          close: async () => { controllerClosed = true; }
        })
      }),
      /initialize failed/
    );
    assert.equal(controllerClosed, true);
    assert.equal(registry.has(runtimeDir), false);
    const probe = new TrafficProxyManager(runtimeDir, { binary });
    await assert.rejects(probe.attachExisting());
  } finally {
    await registry.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("shared bootstrap cleans controller and owned sidecar after scope configuration failure", async () => {
  const root = await mkdtemp("/tmp/agent-runtime-scope-failure-");
  const runtimeDir = join(root, "runtime");
  const registry = new TrafficProxyManagerRegistry({ binary });
  let controllerClosed = false;
  try {
    const manager = await registry.get(runtimeDir);
    manager.configureManagedHttpScope = async () => { throw new Error("scope configuration failed"); };

    await assert.rejects(
      bootstrapAgentRuntime({
        cwd: process.cwd(),
        runtimeDir,
        routeRef: "test-scope-failure",
        trafficProxyRegistry: registry,
        controllerFactory: () => fakeController({
          runId: "run:scope-failure",
          close: async () => { controllerClosed = true; }
        })
      }),
      /scope configuration failed/
    );
    assert.equal(controllerClosed, true);
    assert.equal(registry.has(runtimeDir), false);
    const probe = new TrafficProxyManager(runtimeDir, { binary });
    await assert.rejects(probe.attachExisting());
  } finally {
    await registry.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI and Web run entrypoints both use the shared bootstrap", async () => {
  const [cliSource, webSource] = await Promise.all([
    readFile(join(process.cwd(), "src", "cli.ts"), "utf8"),
    readFile(join(process.cwd(), "src", "web-server.ts"), "utf8")
  ]);
  assert.match(cliSource, /bootstrapAgentRuntime\(\{/);
  assert.match(webSource, /bootstrapAgentRuntime\(\{/);
  assert.doesNotMatch(cliSource, /new SecurityAgentController/);
  assert.doesNotMatch(webSource, /new SecurityAgentController/);
});

async function requestThroughProxy(proxyUrl: string, targetUrl: string): Promise<void> {
  const proxy = new URL(proxyUrl);
  await new Promise<void>((resolveRequest, rejectRequest) => {
    const outgoing = request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: "GET",
      path: targetUrl,
      headers: { Host: new URL(targetUrl).host }
    }, (response) => {
      response.resume();
      response.once("end", resolveRequest);
    });
    outgoing.once("error", rejectRequest);
    outgoing.end();
  });
}
