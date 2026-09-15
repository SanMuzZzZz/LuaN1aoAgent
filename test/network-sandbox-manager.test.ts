import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  NetworkSandboxManager,
  networkCaptureDockerEnv
} from "../src/connectivity/network-sandbox-manager.js";

type FakeDockerNetwork = {
  internal: boolean;
  labels: Map<string, string>;
  subnet: string;
};

function fakeDockerNetworkCommand(
  args: string[],
  networks: Map<string, FakeDockerNetwork>,
  connections?: Set<string>
): { code: number; stdout: string; stderr: string } | undefined {
  if (args[0] !== "network") return undefined;
  const name = args.at(-1) ?? "";
  if (args[1] === "create") {
    const labels = new Map<string, string>();
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] !== "--label") continue;
      const value = args[index + 1] ?? "";
      const separator = value.indexOf("=");
      labels.set(value.slice(0, separator), value.slice(separator + 1));
    }
    networks.set(name, {
      internal: args.includes("--internal"),
      labels,
      subnet: args.includes("--internal") ? "172.31.0.0/24" : "172.30.0.0/24"
    });
    return { code: 0, stdout: `${name}\n`, stderr: "" };
  }
  if (args[1] === "inspect") {
    const network = networks.get(name);
    if (!network) return { code: 1, stdout: "", stderr: "missing" };
    const format = args[3] ?? "";
    if (format === "{{(index .IPAM.Config 0).Subnet}}") {
      return { code: 0, stdout: `${network.subnet}\n`, stderr: "" };
    }
    const labels = network.labels;
    return {
      code: 0,
      stdout: format.includes("luanniao.task_ref")
        ? [labels.get("luanniao.managed") ?? "", labels.get("luanniao.role") ?? "",
            labels.get("luanniao.run_ref") ?? "", labels.get("luanniao.task_ref") ?? "",
            network.subnet, String(network.internal)].join("|")
        : [labels.get("luanniao.managed") ?? "", labels.get("luanniao.role") ?? "",
            labels.get("luanniao.run_ref") ?? ""].join("|"),
      stderr: ""
    };
  }
  if (args[1] === "rm") {
    networks.delete(name);
    return { code: 0, stdout: `${name}\n`, stderr: "" };
  }
  if (args[1] === "connect") {
    connections?.add(`${args[3]}:${args[2]}`);
    return { code: 0, stdout: "", stderr: "" };
  }
  return undefined;
}

function ownedNetworkInspect(
  args: string[],
  runRef: string,
  taskId: string
): { code: number; stdout: string; stderr: string } | undefined {
  if (args[0] !== "network" || args[1] !== "inspect") return undefined;
  const taskNetwork = args.at(-1)?.startsWith("luanniao-task-") === true;
  if (args[3] === "{{(index .IPAM.Config 0).Subnet}}") {
    return { code: 0, stdout: taskNetwork ? "172.31.0.0/24" : "172.30.0.0/24", stderr: "" };
  }
  return {
    code: 0,
    stdout: taskNetwork
      ? `true|task-network|${runRef}|${taskId}|172.31.0.0/24|true`
      : `true|run-network|${runRef}`,
    stderr: ""
  };
}

test("network capture environment is explicitly allowlisted and validated", () => {
  assert.deepEqual(networkCaptureDockerEnv({
    LUANNIAO_CAPTURE_BYTES: "2097152",
    LUANNIAO_TCP_CAPTURE_BYTES: "131072",
    LUANNIAO_MITM_SEGMENT_BYTES: "134217728",
    LUANNIAO_NET_SEGMENT_BYTES: "33554432",
    LUANNIAO_CAPTURE_MAX_FILES: "16",
    LLM_API_KEY: "must-not-cross"
  }), [
    "--env", "LUANNIAO_CAPTURE_BYTES=2097152",
    "--env", "LUANNIAO_TCP_CAPTURE_BYTES=131072",
    "--env", "LUANNIAO_MITM_SEGMENT_BYTES=134217728",
    "--env", "LUANNIAO_NET_SEGMENT_BYTES=33554432",
    "--env", "LUANNIAO_CAPTURE_MAX_FILES=16"
  ]);
  assert.throws(
    () => networkCaptureDockerEnv({ LUANNIAO_CAPTURE_BYTES: "0" }),
    /LUANNIAO_CAPTURE_BYTES must be between/
  );
  assert.throws(
    () => networkCaptureDockerEnv({ LUANNIAO_CAPTURE_MAX_FILES: "many" }),
    /LUANNIAO_CAPTURE_MAX_FILES must be a positive integer/
  );
});

test("gateway capture storage and container capabilities stay host-readable and writable", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-capture-permissions-");
  const taskId = "task:capture";
  const runRef = "run:capture";
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef,
    runner: async (args) => ownedNetworkInspect(args, runRef, taskId)
      ?? { code: 0, stdout: "", stderr: "" }
  });
  const internal = manager as unknown as {
    chownGatewayStorage(dir: string): Promise<void>;
    gatewaySpec(taskId: string): Promise<{ runArgs: string[] }>;
  };

  try {
    await manager.configureAuthorizedScope("198.51.100.0/24");
    const storageDir = join(runtimeDir, "traffic", "flows", taskId);
    await mkdir(storageDir, { recursive: true });
    await internal.chownGatewayStorage(storageDir);
    assert.equal((await stat(storageDir)).mode & 0o777, 0o755);

    const spec = await internal.gatewaySpec(taskId);
    for (const capability of ["CHOWN", "DAC_OVERRIDE"]) {
      const index = spec.runArgs.indexOf(capability);
      assert.ok(index > 0);
      assert.deepEqual(spec.runArgs.slice(index - 1, index + 1), ["--cap-add", capability]);
    }
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("network sandbox gives only the gateway network capability and reconciles labeled containers", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-");
  const imageId = "sha256:network-current";
  const commands: string[][] = [];
  const running = new Set<string>();
  const roles = new Map<string, string>();
  const labelsByName = new Map<string, Map<string, string>>();
  const networks = new Map<string, FakeDockerNetwork>();
  const connections = new Set<string>();
  const runner = async (args: string[]) => {
    commands.push(args);
    const networkResult = fakeDockerNetworkCommand(args, networks, connections);
    if (networkResult) return networkResult;
    if (args[0] === "image" && args[1] === "inspect") return { code: 0, stdout: `${imageId}\n`, stderr: "" };
    if (args[0] === "inspect" && args[2]?.includes("with index .NetworkSettings.Networks")) {
      const networkName = /Networks "([^"]+)"/.exec(args[2] ?? "")?.[1] ?? "";
      return { code: 0, stdout: connections.has(`${args.at(-1)}:${networkName}`) ? "172.31.0.2" : "", stderr: "" };
    }
    if (args[0] === "inspect" && args.includes("{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}")) {
      return { code: 0, stdout: "172.30.0.9 ", stderr: "" };
    }
    if (args[0] === "inspect") {
      const name = args.at(-1) ?? "";
      if (!running.has(name)) return { code: 1, stdout: "", stderr: "missing" };
      const role = roles.get(name) ?? "";
      const labels = labelsByName.get(name) ?? new Map<string, string>();
      return args[2]?.includes(".State.Running")
        ? {
            code: 0,
            stdout: `true|true|${role}|${labels.get("luanniao.config") ?? ""}|${labels.get("luanniao.run_ref") ?? ""}|${labels.get("luanniao.task_ref") ?? ""}|${imageId}`,
            stderr: ""
          }
        : { code: 0, stdout: `true|${role}`, stderr: "" };
    }
    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      const labels = new Map(args
        .filter((value) => value.startsWith("luanniao."))
        .map((value) => {
          const separator = value.indexOf("=");
          return [value.slice(0, separator), value.slice(separator + 1)] as const;
        }));
      running.add(name);
      roles.set(name, labels.get("luanniao.role") ?? "");
      labelsByName.set(name, labels);
      return { code: 0, stdout: "container", stderr: "" };
    }
    if (args[0] === "rm") {
      const name = args.at(-1) ?? "";
      running.delete(name);
      roles.delete(name);
      labelsByName.delete(name);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:49152\n", stderr: "" };
    if (args[0] === "exec" && args.includes("gatewayctl")) {
      return {
        code: 0,
        stdout: args.includes("epoch.end")
          ? gatewayDrainResponse(epochRefFromCommand(args))
          : "{\"ok\":true}\n",
        stderr: ""
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef: "run:test",
    runner,
    fetcher: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })
  });
  try {
    await manager.configureAuthorizedScope("198.51.100.0/24");
    await manager.start();
    const gateway = await manager.createGateway({ taskId: "task:test", epochId: "epoch:test" });
    const nextEpoch = await manager.createGateway({ taskId: "task:test", epochId: "epoch:next" });
    await manager.replaceRoutes([{
      routeRef: "route:test",
      cidr: "172.31.0.0/24",
      prefixLength: 24,
      socksHost: "172.30.0.9",
      socksPort: 22000
    }, {
      routeRef: "route:test",
      cidr: "172.31.1.0/24",
      prefixLength: 24,
      socksHost: "172.30.0.9",
      socksPort: 22000
    }]);
    assert.deepEqual(manager.routeSnapshot().map((route) => route.cidr), [
      "172.31.0.0/24",
      "172.31.1.0/24"
    ]);

    const runs = commands.filter((args) => args[0] === "run");
    const persistentRuns = runs.filter((args) => !args.includes("--rm"));
    const connector = runs.find((args) => args.includes(manager.connectorName));
    const index = runs.find((args) => args.includes(manager.indexName));
    const gatewayRun = runs.find((args) => args.includes(gateway.containerName));
    assert.ok(connector && index && gatewayRun);
    assert.deepEqual(JSON.parse(await readFile(`${runtimeDir}/traffic/index.json`, "utf8")), {
      url: "http://127.0.0.1:49152",
      token: manager.indexToken
    });
    assert.equal(commands.some((args) => args.some((value) => value.startsWith("luanniao-history-index-"))), false);
    assert.ok(connector.includes("--cap-drop") && connector.includes("ALL"));
    assert.equal(connector.includes("NET_ADMIN"), false);
    assert.equal(index.includes("NET_ADMIN"), false);
    assert.equal(index.includes(manager.networkName), false);
    assert.ok(gatewayRun.includes("NET_ADMIN"));
    assert.ok(gatewayRun.includes("SETUID"));
    assert.ok(gatewayRun.includes("SETGID"));
    assert.ok(gatewayRun.includes("/dev/net/tun:/dev/net/tun"));
    assert.ok(gatewayRun.includes("net.netfilter.nf_conntrack_acct=1"));
    assert.ok(gatewayRun.includes("net.ipv4.conf.all.rp_filter=0"));
    assert.ok(gatewayRun.includes("net.ipv4.conf.default.rp_filter=0"));
    assert.equal(connector.includes("/dev/net/tun:/dev/net/tun"), false);
    assert.equal(index.includes("/dev/net/tun:/dev/net/tun"), false);
    assert.ok(gatewayRun.includes("net.ipv6.conf.all.disable_ipv6=1"));
    assert.ok(runs.every((args) => args.includes("no-new-privileges")));
    assert.ok(persistentRuns.every((args) => args.includes("--pids-limit")));
    assert.ok(persistentRuns.every((args) => args.includes("--memory")));
    assert.ok(persistentRuns.every((args) => args.includes("--cpus")));
    assert.equal(runs.some((args) => args.some((value) => value.includes("docker.sock"))), false);
    assert.ok(persistentRuns.every((args) => args.includes("luanniao.managed=true")));
    assert.ok(persistentRuns.every((args) => args.some((value) => value.startsWith("luanniao.role="))));
    assert.ok(persistentRuns.every((args) => args.some((value) => value.startsWith("luanniao.config="))));
    assert.ok(persistentRuns.every((args) => args.includes("luanniao.run_ref=run:test")));
    assert.ok(gatewayRun.includes("luanniao.task_ref=task:test"));
    assert.ok(gatewayRun.includes("LUANNIAO_AUTHORIZED_CIDRS=198.51.100.0/24"));
    assert.ok(gatewayRun.includes("LUANNIAO_AUTHORIZED_DOMAINS="));
    await assert.rejects(
      () => manager.configureAuthorizedScope("203.0.113.0/24"),
      /cannot change/
    );
    assert.equal(connector.some((value) => value.startsWith("luanniao.task_ref=")), false);
    assert.equal(index.some((value) => value.startsWith("luanniao.task_ref=")), false);
    const networkCreate = commands.find((args) => args[0] === "network" && args[1] === "create");
    assert.ok(networkCreate?.includes("luanniao.run_ref=run:test"));
    const taskNetworkCreate = commands.find((args) => args[0] === "network" && args[1] === "create" && args.includes("--internal"));
    assert.ok(taskNetworkCreate?.includes("luanniao.role=task-network"));
    assert.ok(taskNetworkCreate?.includes("luanniao.task_ref=task:test"));
    assert.ok(gatewayRun.includes("--network") && gatewayRun.includes(manager.networkName));
    assert.ok(commands.some((args) => args[0] === "network" && args[1] === "connect"
      && args[2] === gateway.networkName && args[3] === gateway.containerName));
    assert.ok(index.some((value) => value === `type=bind,src=${runtimeDir}/traffic,dst=/traffic,readonly`));
    assert.ok(gatewayRun.some((value) => value === `type=bind,src=${runtimeDir}/traffic/flows/task-test,dst=/traffic/flows/task-test`));
    assert.ok(gatewayRun.some((value) => value === `type=bind,src=${runtimeDir}/traffic/ca,dst=/traffic/ca`));
    assert.equal(gatewayRun.some((value) => value === `type=bind,src=${runtimeDir}/traffic,dst=/traffic`), false);
    assert.ok(commands.some((args) => args[0] === "exec" && args.includes("routes.replace")));
    const lastRoutePayload = commands.filter((args) => args.includes("routes.replace")).at(-1)?.at(-1) ?? "";
    assert.match(lastRoutePayload, /172\.31\.0\.0\/24/);
    assert.match(lastRoutePayload, /172\.31\.1\.0\/24/);
    assert.equal(nextEpoch.containerName, gateway.containerName);
    assert.notEqual(nextEpoch.flowFile, gateway.flowFile);
    assert.equal(runs.filter((args) => args.includes(gateway.containerName)).length, 1);
    const drain = await manager.endEpoch("task:test", "epoch:next");
    assert.equal(drain.epochRef, "epoch:next");
    assert.equal(drain.persistedFlowSequence, 2);
    assert.equal(drain.persistedNetworkSequence, 3);
    assert.equal(drain.flushed, true);
    const epochCommands = commands.filter((args) => args[0] === "exec" && args.includes("gatewayctl"));
    assert.ok(epochCommands.some((args) => args.includes("epoch.begin") && args.some((value) => value.includes("epoch:test"))));
    assert.ok(epochCommands.some((args) => args.includes("epoch.end") && args.some((value) => value.includes("epoch:test"))));
    assert.ok(epochCommands.some((args) => args.includes("epoch.begin") && args.some((value) => value.includes("epoch:next"))));
  } finally {
    await manager.close();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("network sandbox separates domain rules from CIDRs in the Gateway boundary", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-domain-scope-");
  const commands: string[][] = [];
  const networks = new Map<string, FakeDockerNetwork>();
  const runner = async (args: string[]) => {
    commands.push(args);
    const networkResult = fakeDockerNetworkCommand(args, networks);
    if (networkResult) return networkResult;
    if (args[0] === "image") return { code: 0, stdout: "sha256:network-current\n", stderr: "" };
    if (args[0] === "inspect" && args[2]?.includes("with index .NetworkSettings.Networks")) {
      return { code: 0, stdout: "172.31.0.2", stderr: "" };
    }
    if (args[0] === "inspect" && args.includes("{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}")) {
      return { code: 0, stdout: "172.30.0.9 ", stderr: "" };
    }
    if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:49152\n", stderr: "" };
    if (args[0] === "exec") return { code: 0, stdout: "{\"ok\":true}\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef: "run:domain",
    runner,
    fetcher: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })
  });
  try {
    await manager.configureAuthorizedScope("*.Baidu.com,baidu.com");
    await manager.start();
    await manager.createGateway({ taskId: "task:domain", epochId: "epoch:domain" });
    const gatewayRun = commands.find((args) => args[0] === "run" && args.includes("luanniao.role=gateway"));
    assert.ok(gatewayRun?.includes("LUANNIAO_AUTHORIZED_CIDRS="));
    assert.ok(gatewayRun?.includes("LUANNIAO_AUTHORIZED_DOMAINS=*.baidu.com,baidu.com"));
  } finally {
    await manager.close().catch(() => undefined);
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("network sandbox can start the historical replay base before its connector", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-history-");
  const commands: string[][] = [];
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef: "run:history",
    manageFlowIndex: false,
    runner: async (args) => {
      commands.push(args);
      if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
      if (args[0] === "inspect" && args.includes("{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}")) {
        return { code: 0, stdout: "172.30.0.9 ", stderr: "" };
      }
      if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  try {
    await manager.start({ connector: false });
    assert.equal(commands.filter((args) => args[0] === "run").length, 0);
    assert.equal(commands.some((args) => args.includes(manager.indexName)), false);
    assert.equal(commands.some((args) => args.some((value) => value.startsWith("luanniao-history-index-"))), false);
    await assert.rejects(readFile(`${runtimeDir}/traffic/index.token`, "utf8"), /ENOENT/);
    await assert.rejects(readFile(`${runtimeDir}/traffic/index.json`, "utf8"), /ENOENT/);

    await manager.start();
    await manager.start();
    const runs = commands.filter((args) => args[0] === "run");
    assert.equal(runs.length, 1);
    assert.ok(runs[0]?.includes(manager.connectorName));
  } finally {
    await manager.close();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("a resumed network manager adopts legacy index and connector containers and removes them on close", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-adopt-run-");
  const runRef = "run:adopt-run";
  const imageId = "sha256:network-current";
  const commands: string[][] = [];
  const containers = new Map<string, { running: boolean; labels: Map<string, string>; imageId: string }>();
  let networkExists = false;
  let networkRunRef: string | undefined;
  const runner = async (args: string[]) => {
    commands.push(args);
    if (args[0] === "image" && args[1] === "inspect") return { code: 0, stdout: `${imageId}\n`, stderr: "" };
    if (args[0] === "network" && args[1] === "inspect") {
      return networkExists
        ? { code: 0, stdout: `true|run-network|${networkRunRef ?? "<no value>"}`, stderr: "" }
        : { code: 1, stdout: "", stderr: "missing" };
    }
    if (args[0] === "network" && args[1] === "create") {
      networkExists = true;
      networkRunRef = args.find((value) => value.startsWith("luanniao.run_ref="))?.slice("luanniao.run_ref=".length);
      return { code: 0, stdout: args.at(-1) ?? "", stderr: "" };
    }
    if (args[0] === "network" && args[1] === "rm") {
      if (containers.size > 0) return { code: 1, stdout: "", stderr: "network has active endpoints" };
      networkExists = false;
      return { code: 0, stdout: args.at(-1) ?? "", stderr: "" };
    }
    if (args[0] === "inspect" && args.includes("{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}")) {
      return { code: 0, stdout: "172.30.0.9 ", stderr: "" };
    }
    if (args[0] === "inspect") {
      const state = containers.get(args.at(-1) ?? "");
      if (!state) return { code: 1, stdout: "", stderr: "missing" };
      const label = (key: string): string => state.labels.get(key) ?? "<no value>";
      if (args[2]?.includes(".State.Running")) {
        return {
          code: 0,
          stdout: `${state.running}|${label("luanniao.managed")}|${label("luanniao.role")}|${label("luanniao.config")}|${label("luanniao.run_ref")}|${label("luanniao.task_ref")}|${state.imageId}`,
          stderr: ""
        };
      }
      return {
        code: 0,
        stdout: `${label("luanniao.managed")}|${label("luanniao.role")}|${label("luanniao.run_ref")}|${label("luanniao.task_ref")}`,
        stderr: ""
      };
    }
    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      const labels = new Map(args
        .filter((value) => value.startsWith("luanniao."))
        .map((value) => {
          const separator = value.indexOf("=");
          return [value.slice(0, separator), value.slice(separator + 1)] as const;
        }));
      containers.set(name, { running: true, labels, imageId });
      return { code: 0, stdout: name, stderr: "" };
    }
    if (args[0] === "start") {
      const state = containers.get(args.at(-1) ?? "");
      if (!state) return { code: 1, stdout: "", stderr: "missing" };
      state.running = true;
      return { code: 0, stdout: args.at(-1) ?? "", stderr: "" };
    }
    if (args[0] === "rm") {
      containers.delete(args.at(-1) ?? "");
      return { code: 0, stdout: args.at(-1) ?? "", stderr: "" };
    }
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:49152\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const fetcher = async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  const first = new NetworkSandboxManager({ runtimeDir, runRef, runner, fetcher });

  try {
    await first.start();
    assert.equal(containers.size, 2);
    for (const state of containers.values()) {
      state.labels.delete("luanniao.run_ref");
      state.labels.delete("luanniao.task_ref");
    }
    networkRunRef = undefined;
    const commandBoundary = commands.length;

    const resumed = new NetworkSandboxManager({ runtimeDir, runRef, runner, fetcher });
    await resumed.start();
    const resumeStartupCommands = commands.slice(commandBoundary);
    assert.equal(resumeStartupCommands.some((args) => args[0] === "run" || args[0] === "start"), false);
    assert.equal(containers.has(resumed.indexName), true);
    assert.equal(containers.has(resumed.connectorName), true);

    await resumed.close();
    const resumeCommands = commands.slice(commandBoundary);
    assert.equal(containers.size, 0);
    assert.equal(networkExists, false);
    assert.equal(resumeCommands.some((args) => args[0] === "rm" && args.at(-1) === resumed.indexName), true);
    assert.equal(resumeCommands.some((args) => args[0] === "rm" && args.at(-1) === resumed.connectorName), true);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("network sandbox recreates owned index and connector containers from the current image ID", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-image-reconcile-");
  const runRef = "run:image-reconcile";
  const currentImageId = "sha256:network-current";
  const staleImageId = "sha256:network-stale";
  const commands: string[][] = [];
  const specs = new Map<string, { role: string; configDigest: string }>();
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef,
    runner: async (args) => {
      commands.push(args);
      if (args[0] === "image" && args[1] === "inspect") {
        return { code: 0, stdout: `${currentImageId}\n`, stderr: "" };
      }
      if (args[0] === "inspect") {
        const spec = specs.get(args.at(-1) ?? "");
        if (!spec) return { code: 1, stdout: "", stderr: "missing" };
        return args[2]?.includes(".State.Running")
          ? {
              code: 0,
              stdout: `true|true|${spec.role}|${spec.configDigest}|${runRef}|<no value>|${staleImageId}`,
              stderr: ""
            }
          : { code: 0, stdout: `true|${spec.role}|${runRef}|<no value>`, stderr: "" };
      }
      if (args[0] === "rm" || args[0] === "run") return { code: 0, stdout: args.at(-1) ?? "", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
    }
  });
  const reconcile = (manager as unknown as {
    reconcileContainer(
      name: string,
      role: string,
      args: string[],
      identity: { runRef: string; taskRef?: string }
    ): Promise<void>;
  }).reconcileContainer.bind(manager);

  try {
    for (const role of ["index", "connector"]) {
      const name = `luanniao-${role}-image-test`;
      const runArgs = ["--read-only", manager.image, role];
      specs.set(name, {
        role,
        configDigest: createHash("sha256").update(JSON.stringify(runArgs)).digest("hex")
      });
      await reconcile(name, role, runArgs, { runRef });
    }

    for (const role of ["index", "connector"]) {
      const name = `luanniao-${role}-image-test`;
      assert.equal(commands.some((args) => args[0] === "rm" && args.at(-1) === name), true);
      assert.equal(commands.some((args) => args[0] === "run" && args.includes(name)), true);
    }
    assert.equal(commands.some((args) => args[0] === "start"), false);
    assert.equal(commands.filter((args) => args[0] === "image" && args[1] === "inspect").length, 1);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("network startup failure removes its partial index and verifies network cleanup", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-start-failure-");
  const commands: string[][] = [];
  let networkRemoveAttempts = 0;
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef: "run:start-failure",
    runner: async (args) => {
      commands.push(args);
      if (args[0] === "network" && args[1] === "inspect") {
        return networkRemoveAttempts > 0
          ? { code: 0, stdout: "true|run-network", stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "network" && args[1] === "rm") {
        networkRemoveAttempts += 1;
        return networkRemoveAttempts === 1
          ? { code: 1, stdout: "", stderr: "network has active endpoints" }
          : { code: 0, stdout: manager.networkName, stderr: "" };
      }
      if (args[0] === "inspect") {
        return args[2]?.includes(".State.Running")
          ? { code: 1, stdout: "", stderr: "missing" }
          : { code: 0, stdout: "true|index", stderr: "" };
      }
      if (args[0] === "port") return { code: 1, stdout: "", stderr: "port unavailable" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetcher: async () => new Response(null, { status: 503 })
  });
  try {
    await assert.rejects(() => manager.start(), /Failed to resolve flow index port/);
    assert.equal(commands.some((args) => args[0] === "rm" && args.at(-1) === manager.indexName), true);
    assert.equal(networkRemoveAttempts, 2);
    assert.equal(commands.some((args) => args[0] === "network" && args[1] === "inspect"), true);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("network startup reports cleanup failures without skipping later cleanup", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-start-cleanup-failure-");
  const commands: string[][] = [];
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef: "run:start-cleanup-failure",
    runner: async (args) => {
      commands.push(args);
      if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
      if (args[0] === "network" && args[1] === "rm") return { code: 0, stdout: manager.networkName, stderr: "" };
      if (args[0] === "inspect") {
        return args[2]?.includes(".State.Running")
          ? { code: 1, stdout: "", stderr: "missing" }
          : { code: 0, stdout: "true|index", stderr: "" };
      }
      if (args[0] === "rm") return { code: 1, stdout: "", stderr: "index remove failed" };
      if (args[0] === "port") return { code: 1, stdout: "", stderr: "port unavailable" };
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  try {
    await assert.rejects(
      () => manager.start(),
      (error: unknown) => error instanceof AggregateError
        && error.message === "Network sandbox startup cleanup failed"
        && error.errors.length === 2
    );
    assert.equal(commands.some((args) => args[0] === "rm" && args.at(-1) === manager.indexName), true);
    assert.equal(commands.some((args) => args[0] === "network" && args[1] === "rm"), true);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("connector startup cleanup failure remains owned for close retry", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-connector-start-cleanup-");
  let failRemove = true;
  let removeAttempts = 0;
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef: "run:connector-start-cleanup",
    runner: async (args) => {
      if (args[0] === "inspect" && args.includes("{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "inspect" && args[2]?.includes(".State.Running")) {
        return { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "inspect") return { code: 0, stdout: "true|connector", stderr: "" };
      if (args[0] === "rm") {
        removeAttempts += 1;
        return failRemove
          ? { code: 1, stdout: "", stderr: "connector remove failed" }
          : { code: 0, stdout: manager.connectorName, stderr: "" };
      }
      if (args[0] === "network" && args[1] === "rm") return { code: 0, stdout: manager.networkName, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  (manager as unknown as { started: boolean }).started = true;
  try {
    await manager.configureAuthorizedScope("198.51.100.0/24");
    await assert.rejects(
      () => manager.start(),
      (error: unknown) => error instanceof AggregateError
        && error.message === "Connector startup cleanup failed"
    );
    assert.equal(removeAttempts, 1);
    failRemove = false;
    await manager.close();
    assert.equal(removeAttempts, 2);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("gateway startup cleanup failure remains owned for close retry", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-gateway-start-cleanup-");
  let failRemove = true;
  let removeAttempts = 0;
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef: "run:gateway-start-cleanup",
    runner: async (args) => {
      if (args[0] === "network" && args[1] === "inspect") {
        if (args[3] === "{{(index .IPAM.Config 0).Subnet}}") {
          return { code: 0, stdout: args.at(-1)?.startsWith("luanniao-task-") ? "172.31.0.0/24" : "172.30.0.0/24", stderr: "" };
        }
        return args.at(-1)?.startsWith("luanniao-task-")
          ? { code: 0, stdout: "true|task-network|run:gateway-start-cleanup|task:partial|172.31.0.0/24|true", stderr: "" }
          : { code: 0, stdout: "true|run-network|run:gateway-start-cleanup", stderr: "" };
      }
      if (args[0] === "inspect" && args[2]?.includes("with index .NetworkSettings.Networks")) {
        return { code: 0, stdout: args[2]?.includes("luanniao-task-") ? "172.31.0.2" : "172.30.0.8", stderr: "" };
      }
      if (args[0] === "inspect" && args.includes("{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}")) {
        return { code: 0, stdout: "172.30.0.8 ", stderr: "" };
      }
      if (args[0] === "inspect" && args[2]?.includes(".State.Running")) {
        return { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "inspect") return { code: 0, stdout: "true|gateway", stderr: "" };
      if (args[0] === "exec" && args.includes("health")) return { code: 0, stdout: "{\"ok\":true}\n", stderr: "" };
      if (args[0] === "exec" && args.includes("routes.replace")) return { code: 1, stdout: "", stderr: "route apply failed" };
      if (args[0] === "rm") {
        removeAttempts += 1;
        return failRemove
          ? { code: 1, stdout: "", stderr: "gateway remove failed" }
          : { code: 0, stdout: args.at(-1) ?? "", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "rm") return { code: 0, stdout: manager.networkName, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  (manager as unknown as { started: boolean }).started = true;
  try {
    await manager.configureAuthorizedScope("198.51.100.0/24");
    await assert.rejects(
      () => manager.createGateway({ taskId: "task:partial", epochId: "epoch:partial" }),
      (error: unknown) => error instanceof AggregateError
        && error.message === "Gateway startup cleanup failed"
    );
    assert.equal(removeAttempts, 1);
    failRemove = false;
    await manager.close();
    assert.equal(removeAttempts, 2);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("gateway disposal preserves the container and ownership when epoch flush fails", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-flush-");
  const gateway = {
    taskId: "task:flush",
    epochId: "epoch:flush",
    containerName: "gateway:flush",
    flowFile: `${runtimeDir}/traffic/flows/task-flush/epoch-flush.mitm`,
    netFile: `${runtimeDir}/traffic/flows/task-flush/epoch-flush.net.jsonl`
  };
  let failFlush = true;
  let incompleteAck = false;
  let failRemove = false;
  let epochEndAttempts = 0;
  let removed = false;
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef: "run:flush",
    runner: async (args) => {
      if (args[0] === "exec" && args.includes("epoch.end")) {
        epochEndAttempts += 1;
        return failFlush
          ? { code: 1, stdout: "", stderr: "flush failed" }
          : {
              code: 0,
              stdout: incompleteAck
                ? '{"ok":true,"result":{"epochRef":"epoch:flush","flushed":true}}\n'
                : gatewayDrainResponse("epoch:flush"),
              stderr: ""
            };
      }
      if (args[0] === "inspect" && args.at(-1) === gateway.containerName) {
        return { code: 0, stdout: "true|gateway", stderr: "" };
      }
      if (args[0] === "rm" && args.at(-1) === gateway.containerName) {
        if (failRemove) return { code: 1, stdout: "", stderr: "remove failed" };
        removed = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    }
  });
  const internal = manager as unknown as { gateways: Map<string, typeof gateway> };
  internal.gateways.set(gateway.taskId, gateway);
  try {
    await assert.rejects(() => manager.disposeGateway(gateway.taskId), /Failed to end gateway epoch/);
    assert.equal(removed, false);
    assert.equal(internal.gateways.get(gateway.taskId), gateway);

    failFlush = false;
    incompleteAck = true;
    await assert.rejects(() => manager.disposeGateway(gateway.taskId), /invalid activeFlowCount/);
    assert.equal(removed, false);
    assert.equal(internal.gateways.get(gateway.taskId), gateway);

    incompleteAck = false;
    failRemove = true;
    await assert.rejects(() => manager.disposeGateway(gateway.taskId), /Failed to remove/);
    assert.equal(epochEndAttempts, 3);
    assert.equal(internal.gateways.get(gateway.taskId)?.epochId, "");

    failRemove = false;
    await manager.disposeGateway(gateway.taskId);
    assert.equal(removed, true);
    assert.equal(epochEndAttempts, 3);
    assert.equal(internal.gateways.has(gateway.taskId), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("Chisel connector restart stops the old server and reuses its key", async () => {
  const commands: Array<{ args: string[]; stdin?: string }> = [];
  const manager = new NetworkSandboxManager({
    runtimeDir: "/tmp/luanniao-network-chisel",
    runRef: "run:chisel",
    runner: async (args, stdin) => {
      commands.push({ args, stdin });
      if (args[0] === "exec" && args.includes("cat /run/luanniao/chisel.log 2>/dev/null || true")) {
        return { code: 0, stdout: "Fingerprint AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n", stderr: "" };
      }
      if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:49190\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }
  });

  await (manager as unknown as { startChiselServer(host: string): Promise<void> })
    .startChiselServer("connect.example.test");

  const start = commands.find((entry) => entry.args[0] === "exec" && entry.args.includes("-i"));
  const shell = start?.args.at(-1) ?? "";
  assert.match(shell, /kill -TERM/);
  assert.match(shell, /\[ -s \/run\/luanniao\/chisel\.key \] \|\| chisel server --keygen/);
  assert.match(shell, /: > \/run\/luanniao\/chisel\.log/);
  assert.match(shell, /kill -0 \"\$pid\"/);
  assert.match(manager.chiselEndpoint ?? "", /^http:\/\/connect\.example\.test:/);
});

test("network control mutations serialize gateway creation and route replacement", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-queue-");
  const running = new Set<string>();
  const roles = new Map<string, string>();
  const networks = new Map<string, FakeDockerNetwork>();
  const connections = new Set<string>();
  const routePayloads: string[] = [];
  let releaseInitialRoutes!: () => void;
  let markInitialRoutes!: () => void;
  const initialRoutesStarted = new Promise<void>((resolve) => { markInitialRoutes = resolve; });
  const initialRoutesBlocked = new Promise<void>((resolve) => { releaseInitialRoutes = resolve; });
  const runner = async (args: string[]) => {
    const networkResult = fakeDockerNetworkCommand(args, networks, connections);
    if (networkResult) return networkResult;
    if (args[0] === "image" && args[1] === "inspect") {
      return { code: 0, stdout: "sha256:network-current\n", stderr: "" };
    }
    if (args[0] === "inspect" && args[2]?.includes("with index .NetworkSettings.Networks")) {
      const networkName = /Networks "([^"]+)"/.exec(args[2] ?? "")?.[1] ?? "";
      return { code: 0, stdout: connections.has(`${args.at(-1)}:${networkName}`) ? "172.31.0.2" : "", stderr: "" };
    }
    if (args[0] === "inspect" && args.includes("{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}")) {
      return { code: 0, stdout: "172.30.0.9 ", stderr: "" };
    }
    if (args[0] === "inspect") {
      const name = args.at(-1) ?? "";
      if (!running.has(name)) return { code: 1, stdout: "", stderr: "missing" };
      const role = roles.get(name) ?? "";
      return args[2]?.includes(".State.Running")
        ? { code: 0, stdout: `true|true|${role}|matching`, stderr: "" }
        : { code: 0, stdout: `true|${role}`, stderr: "" };
    }
    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      running.add(name);
      roles.set(name, (args.find((value) => value.startsWith("luanniao.role=")) ?? "=").split("=")[1] ?? "");
      return { code: 0, stdout: "container", stderr: "" };
    }
    if (args[0] === "rm") {
      const name = args.at(-1) ?? "";
      running.delete(name);
      roles.delete(name);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:49152\n", stderr: "" };
    if (args[0] === "exec" && args.includes("gatewayctl")) {
      if (args.includes("routes.replace")) {
        routePayloads.push(args.at(-1) ?? "");
        if (routePayloads.length === 1) {
          markInitialRoutes();
          await initialRoutesBlocked;
        }
      }
      return {
        code: 0,
        stdout: args.includes("epoch.end")
          ? gatewayDrainResponse(epochRefFromCommand(args))
          : "{\"ok\":true}\n",
        stderr: ""
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef: "run:queue",
    runner,
    fetcher: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })
  });
  try {
    await manager.configureAuthorizedScope("198.51.100.0/24");
    await manager.start();
    const gateway = manager.createGateway({ taskId: "task:queue", epochId: "epoch:one" });
    await initialRoutesStarted;
    const replacement = manager.replaceRoutes([{
      routeRef: "route:new",
      cidr: "172.31.0.0/24",
      prefixLength: 24,
      socksHost: "172.30.0.9",
      socksPort: 22000
    }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(routePayloads.length, 1);

    releaseInitialRoutes();
    await Promise.all([gateway, replacement]);
    assert.equal(routePayloads.length, 2);
    assert.doesNotMatch(routePayloads[0] ?? "", /172\.31\.0\.0\/24/);
    assert.match(routePayloads[1] ?? "", /172\.31\.0\.0\/24/);
  } finally {
    releaseInitialRoutes?.();
    await manager.close();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("route replacement rolls every gateway back before keeping the previous snapshot", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-route-rollback-");
  const payloads: Array<{ container: string; payload: string }> = [];
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef: "run:route-rollback",
    runner: async (args) => {
      if (args[0] === "exec" && args.includes("routes.replace")) {
        const container = args[1] ?? "";
        const payload = args.at(-1) ?? "";
        payloads.push({ container, payload });
        if (container === "gateway:two" && payload.includes("route:new")) {
          return { code: 1, stdout: "", stderr: "gateway rejected snapshot" };
        }
        return { code: 0, stdout: '{"ok":true}\n', stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    }
  });
  const oldRoute = {
    routeRef: "route:old",
    cidr: "172.31.0.0/24",
    prefixLength: 24,
    socksHost: "172.30.0.9",
    socksPort: 22000
  };
  const newRoute = { ...oldRoute, routeRef: "route:new", cidr: "10.20.0.0/16", prefixLength: 16 };
  try {
    await mkdir(`${runtimeDir}/traffic`, { recursive: true });
    await manager.replaceRoutes([oldRoute]);
    const internal = manager as unknown as {
      gateways: Map<string, { taskId: string; epochId: string; containerName: string; flowFile: string; netFile: string }>;
    };
    internal.gateways.set("task:one", { taskId: "task:one", epochId: "", containerName: "gateway:one", flowFile: "", netFile: "" });
    internal.gateways.set("task:two", { taskId: "task:two", epochId: "", containerName: "gateway:two", flowFile: "", netFile: "" });

    await assert.rejects(() => manager.replaceRoutes([newRoute]), /Failed to update gateway route snapshots/);

    assert.deepEqual(JSON.parse(await readFile(`${runtimeDir}/traffic/routes.json`, "utf8")), { routes: [oldRoute] });
    assert.equal(payloads.filter((entry) => entry.payload.includes("route:new")).length, 2);
    assert.equal(payloads.filter((entry) => entry.payload.includes("route:old")).length, 2);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("network sandbox adopts an inactive epoch without a drain ack and retries its flush", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-adopt-legacy-");
  const runRef = "run:adopt-legacy";
  const taskId = "task:checkpoint";
  const imageId = "sha256:network-current";
  const commands: string[][] = [];
  let gatewayName = "";
  let gatewayDigest = "";
  let closed = false;
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef,
    knownTaskIds: [taskId],
    manageFlowIndex: false,
    runner: async (args) => {
      commands.push(args);
      if (args[0] === "image" && args[1] === "inspect") return { code: 0, stdout: `${imageId}\n`, stderr: "" };
      if (args[0] === "run" && args.includes("storage-init")) return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "network" && args[1] === "inspect") {
        return ownedNetworkInspect(args, runRef, taskId)!;
      }
      if (args[0] === "network" && args[1] === "rm") {
        return { code: 0, stdout: args.at(-1) ?? "", stderr: "" };
      }
      if (args[0] === "inspect" && args.includes("{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}")) {
        return { code: 0, stdout: "172.30.0.8 ", stderr: "" };
      }
      if (args[0] === "inspect" && args.at(-1) === gatewayName) {
        if (args[2]?.includes(".State.Running")) {
          return {
            code: 0,
            stdout: `true|true|gateway|${gatewayDigest}|<no value>|<no value>|${imageId}`,
            stderr: ""
          };
        }
        return { code: 0, stdout: "true|gateway|<no value>|<no value>", stderr: "" };
      }
      if (args[0] === "exec" && args[1] === gatewayName && args[2] === "cat") {
        return { code: 0, stdout: JSON.stringify({ active: false, epochRef: "epoch:old" }), stderr: "" };
      }
      if (args[0] === "exec" && args[1] === gatewayName && args.includes("gatewayctl")) {
        return {
          code: 0,
          stdout: args.includes("epoch.end")
            ? gatewayDrainResponse(epochRefFromCommand(args))
            : "{\"ok\":true}\n",
          stderr: ""
        };
      }
      if (args[0] === "rm" && args.at(-1) === gatewayName) {
        return { code: 0, stdout: gatewayName, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
    }
  });
  const internal = manager as unknown as {
    gatewaySpec(taskRef: string): Promise<{ containerName: string; configDigest: string }>;
    gateways: Map<string, { epochId: string }>;
  };
  await manager.configureAuthorizedScope("198.51.100.0/24");
  const spec = await internal.gatewaySpec(taskId);
  gatewayName = spec.containerName;
  gatewayDigest = spec.configDigest;

  try {
    await manager.start({ connector: false });
    assert.equal(internal.gateways.get(taskId)?.epochId, "epoch:old");

    const gateway = await manager.createGateway({ taskId, epochId: "epoch:new" });
    assert.equal(gateway.containerName, gatewayName);
    assert.equal(gateway.epochId, "epoch:new");
    assert.equal(commands.some((args) => args[0] === "start" || (args[0] === "run" && !args.includes("--rm"))), false);

    await manager.close();
    closed = true;
    const gatewayRemoveIndex = commands.findIndex((args) => args[0] === "rm" && args.at(-1) === gatewayName);
    const networkRemoveIndex = commands.findIndex((args) => args[0] === "network" && args[1] === "rm");
    assert.ok(gatewayRemoveIndex >= 0);
    assert.ok(networkRemoveIndex > gatewayRemoveIndex);
    assert.equal(internal.gateways.has(taskId), false);
  } finally {
    if (!closed) await manager.close().catch(() => undefined);
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("cross-process recovery retires an owned gateway from a stale image without adopting its epoch", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-adopt-stale-image-");
  const runRef = "run:stale-gateway";
  const taskId = "task:stale-gateway";
  const currentImageId = "sha256:network-current";
  const staleImageId = "sha256:network-stale";
  const commands: string[][] = [];
  let gatewayName = "";
  let gatewayDigest = "";
  let gatewayExists = true;
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef,
    knownTaskIds: [taskId],
    manageFlowIndex: false,
    runner: async (args) => {
      commands.push(args);
      if (args[0] === "image" && args[1] === "inspect") {
        return { code: 0, stdout: `${currentImageId}\n`, stderr: "" };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        return ownedNetworkInspect(args, runRef, taskId)!;
      }
      if (args[0] === "network" && args[1] === "rm") {
        return { code: 0, stdout: args.at(-1) ?? "", stderr: "" };
      }
      if (args[0] === "inspect" && args.at(-1) === gatewayName) {
        if (!gatewayExists) return { code: 1, stdout: "", stderr: "missing" };
        return args[2]?.includes(".State.Running")
          ? {
              code: 0,
              stdout: `true|true|gateway|${gatewayDigest}|${runRef}|${taskId}|${staleImageId}`,
              stderr: ""
            }
          : { code: 0, stdout: `true|gateway|${runRef}|${taskId}`, stderr: "" };
      }
      if (args[0] === "stop" && args.at(-1) === gatewayName) {
        return { code: 1, stdout: "", stderr: "old gateway did not stop gracefully" };
      }
      if (args[0] === "rm" && args.at(-1) === gatewayName) {
        gatewayExists = false;
        return { code: 0, stdout: gatewayName, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
    }
  });
  const internal = manager as unknown as {
    gatewaySpec(taskRef: string): Promise<{ containerName: string; configDigest: string }>;
    gateways: Map<string, { epochId: string }>;
  };
  await manager.configureAuthorizedScope("198.51.100.0/24");
  const spec = await internal.gatewaySpec(taskId);
  gatewayName = spec.containerName;
  gatewayDigest = spec.configDigest;

  try {
    await manager.start({ connector: false });

    const stopIndex = commands.findIndex((args) => args[0] === "stop" && args.at(-1) === gatewayName);
    const removeIndex = commands.findIndex((args) => args[0] === "rm" && args.at(-1) === gatewayName);
    assert.ok(stopIndex >= 0);
    assert.ok(removeIndex > stopIndex);
    assert.equal(gatewayExists, false);
    assert.equal(internal.gateways.has(taskId), false);
    assert.equal(commands.some((args) => args[0] === "exec" && args[1] === gatewayName), false);
  } finally {
    await manager.close();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("cross-process recovery never removes an unlabeled gateway with a mismatched config digest", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-adopt-config-collision-");
  const runRef = "run:config-collision";
  const taskId = "task:config-collision";
  const commands: string[][] = [];
  let gatewayName = "";
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef,
    knownTaskIds: [taskId],
    manageFlowIndex: false,
    runner: async (args) => {
      commands.push(args);
      if (args[0] === "network" && args[1] === "inspect") {
        return ownedNetworkInspect(args, runRef, taskId)!;
      }
      if (args[0] === "inspect" && args.at(-1) === gatewayName) {
        return {
          code: 0,
          stdout: "true|true|gateway|different-config|<no value>|<no value>|sha256:network-current",
          stderr: ""
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
    }
  });
  gatewayName = manager.gatewayContainerName(taskId);

  try {
    await manager.configureAuthorizedScope("198.51.100.0/24");
    await assert.rejects(() => manager.start({ connector: false }), /outside this runtime/);
    assert.equal(commands.some((args) => args[0] === "image" && args[1] === "inspect"), false);
    assert.equal(commands.some((args) => args[0] === "stop" || args[0] === "rm"), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("network sandbox refuses a labeled persisted gateway owned by another run", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-adopt-conflict-");
  const taskId = "task:checkpoint";
  const commands: string[][] = [];
  let gatewayName = "";
  let gatewayDigest = "";
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef: "run:current",
    knownTaskIds: [taskId],
    manageFlowIndex: false,
    runner: async (args) => {
      commands.push(args);
      if (args[0] === "network" && args[1] === "inspect") {
        return ownedNetworkInspect(args, "run:current", taskId)!;
      }
      if (args[0] === "inspect" && args.at(-1) === gatewayName) {
        return {
          code: 0,
          stdout: `true|true|gateway|${gatewayDigest}|run:other|${taskId}`,
          stderr: ""
        };
      }
      return { code: 1, stdout: "", stderr: "missing" };
    }
  });
  const internal = manager as unknown as {
    gatewaySpec(taskRef: string): Promise<{ containerName: string; configDigest: string }>;
  };
  await manager.configureAuthorizedScope("198.51.100.0/24");
  const spec = await internal.gatewaySpec(taskId);
  gatewayName = spec.containerName;
  gatewayDigest = spec.configDigest;

  try {
    await assert.rejects(() => manager.start({ connector: false }), /outside this runtime/);
    assert.equal(commands.some((args) => args[0] === "run" || args[0] === "start" || args[0] === "rm"), false);
    assert.equal(commands.some((args) => args[0] === "network" && args[1] === "rm"), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("network sandbox refuses to replace an unmanaged deterministic container", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-unmanaged-");
  const commands: string[][] = [];
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef: "run:unmanaged",
    runner: async (args) => {
      commands.push(args);
      if (args[0] === "network" && args[1] === "inspect") {
        return { code: 0, stdout: "true|run-network", stderr: "" };
      }
      if (args[0] === "inspect") {
        return { code: 0, stdout: "true|||", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
  });

  try {
    await assert.rejects(() => manager.start(), /Refusing to replace unmanaged container/);
    assert.equal(commands.some((args) => args[0] === "rm" && args.includes(manager.connectorName)), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("gateway reconciliation never removes an unmanaged deterministic collision", async () => {
  const runtimeDir = await mkdtemp("/tmp/luanniao-network-unmanaged-gateway-");
  const commands: string[][] = [];
  const manager = new NetworkSandboxManager({
    runtimeDir,
    runRef: "run:unmanaged-gateway",
    runner: async (args) => {
      commands.push(args);
      if (args[0] === "network" && args[1] === "inspect") {
        return ownedNetworkInspect(args, "run:unmanaged-gateway", "task:collision")!;
      }
      if (args[0] === "inspect") return { code: 0, stdout: "true|false|other|collision", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  (manager as unknown as { started: boolean }).started = true;

  try {
    await manager.configureAuthorizedScope("198.51.100.0/24");
    await assert.rejects(
      () => manager.createGateway({ taskId: "task:collision", epochId: "epoch:one" }),
      /Refusing to replace unmanaged container/
    );
    assert.equal(commands.some((args) => args[0] === "rm"), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("network shutdown retries endpoint detachment and verifies final removal", async () => {
  const commands: string[][] = [];
  let removeAttempts = 0;
  const manager = new NetworkSandboxManager({
    runtimeDir: "/tmp/luanniao-network-close-retry",
    runRef: "run:close-retry",
    runner: async (args) => {
      commands.push(args);
      if (args[0] === "network" && args[1] === "rm") {
        removeAttempts += 1;
        return removeAttempts === 1
          ? { code: 1, stdout: "", stderr: "network has active endpoints" }
          : { code: 0, stdout: manager.networkName, stderr: "" };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        return { code: 0, stdout: "true|run-network", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    }
  });
  (manager as unknown as { started: boolean }).started = true;

  await manager.close();

  assert.equal(removeAttempts, 2);
  assert.equal(commands.some((args) => args[0] === "network" && args[1] === "inspect"), true);
  assert.equal((manager as unknown as { started: boolean }).started, false);
});

test("network shutdown fails closed while a managed network remains", async () => {
  let removeAttempts = 0;
  const manager = new NetworkSandboxManager({
    runtimeDir: "/tmp/luanniao-network-close-residual",
    runRef: "run:close-residual",
    runner: async (args) => {
      if (args[0] === "network" && args[1] === "rm") {
        removeAttempts += 1;
        return { code: 1, stdout: "", stderr: "network has active endpoints" };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        return { code: 0, stdout: "true|run-network", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    }
  });
  (manager as unknown as { started: boolean }).started = true;

  await assert.rejects(manager.close(), /Failed to remove network .*active endpoints/);

  assert.equal(removeAttempts, 20);
  assert.equal((manager as unknown as { started: boolean }).started, true);
});

function epochRefFromCommand(args: string[]): string {
  try {
    const payload = JSON.parse(args.at(-1) ?? "{}") as { epochRef?: unknown };
    return typeof payload.epochRef === "string" ? payload.epochRef : "";
  } catch {
    return "";
  }
}

function gatewayDrainResponse(epochRef: string): string {
  return JSON.stringify({
    ok: true,
    result: {
      epochRef,
      activeFlowCount: 0,
      activeTcpCount: 0,
      activeNetworkCount: 0,
      persistedFlowSequence: 2,
      persistedNetworkSequence: 3,
      flowBytes: 128,
      netBytes: 256,
      flushed: true
    }
  }) + "\n";
}
