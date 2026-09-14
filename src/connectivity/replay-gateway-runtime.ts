import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, chown, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MitmFlowClient } from "./mitm-flow-client.js";
import {
  TrafficProxyControlError,
  type TrafficHeaderEntry,
  type TrafficProxyContext,
  type TrafficReplayResult
} from "./traffic-proxy-client.js";
import {
  DEFAULT_NETWORK_IMAGE,
  networkCaptureDockerEnv,
  type NetworkRoute
} from "./network-sandbox-manager.js";
import {
  HostEgressBroker,
  type HostEgressBrokerEndpoint
} from "./host-egress-broker.js";

type CommandResult = { code: number | null; stdout: string; stderr: string };
type CommandRunner = (args: string[], stdin?: string, timeoutMs?: number) => Promise<CommandResult>;

export type GatewayReplayInput = {
  flowRef: string;
  method: string;
  url: string;
  headers: TrafficHeaderEntry[];
  body?: { encoding: "base64"; data: string };
  routeRef?: string;
  context: TrafficProxyContext & { connection_ref?: string };
};

export class ReplayGatewayRuntime {
  readonly runtimeDir: string;
  readonly containerName: string;
  readonly networkName: string;
  readonly taskNetworkName: string;
  private readonly image: string;
  private readonly runner: CommandRunner;
  private readonly captureEnvironment: string[];
  private targetImageIdPromise?: Promise<string>;
  private readonly hostEgress: () => Promise<HostEgressBrokerEndpoint>;
  private readonly ownedHostEgress?: HostEgressBroker;
  private taskNetworkStarted = false;

  constructor(input: {
    runtimeDir: string;
    networkName: string;
    image?: string;
    runner?: CommandRunner;
    hostEgress?: () => Promise<HostEgressBrokerEndpoint>;
  }) {
    this.runtimeDir = resolve(input.runtimeDir);
    const digest = createHash("sha256").update(this.runtimeDir).digest("hex").slice(0, 16);
    this.containerName = `luanniao-replay-gateway-${digest}`;
    this.taskNetworkName = `luanniao-replay-task-${digest}`;
    this.networkName = input.networkName;
    this.image = input.image ?? (process.env.LUANNIAO_NETWORK_IMAGE?.trim() || DEFAULT_NETWORK_IMAGE);
    this.runner = input.runner ?? dockerCommand;
    this.captureEnvironment = networkCaptureDockerEnv();
    if (input.hostEgress) {
      this.hostEgress = input.hostEgress;
    } else {
      this.ownedHostEgress = new HostEgressBroker();
      this.hostEgress = () => this.ownedHostEgress!.start();
    }
  }

  replay(
    client: MitmFlowClient,
    input: GatewayReplayInput,
    routeSnapshot: NetworkRoute[]
  ): Promise<TrafficReplayResult> {
    return this.replayUnlocked(client, input, routeSnapshot);
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    await this.removeGateway().catch((error: unknown) => failures.push(error));
    await this.removeTaskNetwork().catch((error: unknown) => failures.push(error));
    await this.ownedHostEgress?.close().catch((error: unknown) => failures.push(error));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Replay Gateway cleanup failed");
  }

  private async replayUnlocked(
    client: MitmFlowClient,
    input: GatewayReplayInput,
    routeSnapshot: NetworkRoute[]
  ): Promise<TrafficReplayResult> {
    const selectedRoutes = input.routeRef
      ? routeSnapshot.filter((route) => route.routeRef === input.routeRef)
      : [];
    if (input.routeRef && selectedRoutes.length === 0) {
      throw new TrafficProxyControlError("Original replay route is unavailable", "route_unavailable");
    }
    await this.ensureGateway();
    await this.applyRoutes(selectedRoutes);
    const epochRef = `web-replay:${randomUUID()}`;
    const epochName = safeName(epochRef);
    const flowFile = `/traffic/flows/web-replay/${epochName}.mitm`;
    const netFile = `/traffic/flows/web-replay/${epochName}.net.jsonl`;
    await this.gatewayControl("epoch.begin", { epochRef, flowFile, netFile });
    let commandResult: CommandResult | undefined;
    let replayFailed = false;
    try {
      commandResult = await this.runner([
        "exec", "-i", "--user", "1000:1000", this.containerName,
        "python3", "/opt/luanniao/replay_client.py"
      ], JSON.stringify({
        method: input.method,
        url: input.url,
        headers: input.headers.map(({ name, value }) => ({ name, value })),
        ...(input.body ? { body: input.body.data } : {}),
        context: {
          replayOf: input.flowRef,
          runtimeRef: input.context.runtime_ref,
          taskRef: input.context.task_ref,
          runRef: input.context.run_ref,
          routeRef: input.routeRef ?? input.context.route_ref,
          connectionRef: input.context.connection_ref ?? input.context.session_ref,
          attribution: input.context.attribution
        },
        ...(input.routeRef ? { targetCidrs: selectedRoutes.map((route) => route.cidr) } : {})
      }), 40_000);
      if (commandResult.code !== 0) {
        const message = replayCommandError(commandResult);
        throw new TrafficProxyControlError(
          message,
          input.routeRef && /route|resolv|outside/i.test(message) ? "route_unavailable" : "replay_failed"
        );
      }
      await delay(100);
    } catch (error) {
      replayFailed = true;
      throw error;
    } finally {
      try {
        await this.gatewayControl("epoch.end", { epochRef });
      } catch (error) {
        if (!replayFailed) throw error;
      }
    }
    const commandStatus = replayCommandStatus(commandResult);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const page = await client.historyList({
        limit: 10,
        filter: { epoch_ref: epochRef, replay_of: input.flowRef }
      });
      const flow = page.items.find((candidate) => candidate.kind === "http" && candidate.replay_of === input.flowRef);
      if (flow) {
        return {
          exchange_id: flow.id,
          replay_of: input.flowRef,
          status: flow.status || commandStatus
        };
      }
      await delay(100);
    }
    throw new TrafficProxyControlError("Replay completed without a captured HTTP flow", "replay_capture_missing");
  }

  private async ensureGateway(): Promise<void> {
    await mkdir(join(this.runtimeDir, "traffic", "flows", "web-replay"), { recursive: true });
    await mkdir(join(this.runtimeDir, "traffic", "ca"), { recursive: true });
    // Best-effort host-side expression of the uid 101 single-owner invariant:
    // hand host-created capture storage over to the container data plane uid.
    for (const dir of [join(this.runtimeDir, "traffic", "flows", "web-replay"), join(this.runtimeDir, "traffic", "ca")]) {
      try {
        await chown(dir, 101, 101);
        await chmod(dir, 0o2770);
      } catch {
        // Best-effort only: storage-init below remains authoritative.
      }
    }
    const trafficRoot = join(this.runtimeDir, "traffic");
    const storage = await this.runner([
      "run", "--rm", "--network", "none",
      "--read-only", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE",
      "--security-opt", "no-new-privileges",
      "--mount", `type=bind,src=${join(trafficRoot, "flows", "web-replay")},dst=/storage/flows`,
      "--mount", `type=bind,src=${join(trafficRoot, "ca")},dst=/storage/ca`,
      this.image, "storage-init", "/storage/flows", "/storage/ca"
    ]);
    if (storage.code !== 0) throw new Error(`Failed to initialize Replay Gateway storage: ${storage.stderr || storage.stdout}`);
    const taskSubnet = await this.ensureTaskNetwork();
    const controlSubnet = await this.networkSubnet(this.networkName);
    const hostEgress = await this.hostEgress();
    const containerArgs = [
      "--network", this.networkName,
      "--add-host", "host.docker.internal:host-gateway",
      "--sysctl", "net.ipv6.conf.all.disable_ipv6=1",
      "--sysctl", "net.ipv6.conf.default.disable_ipv6=1",
      "--sysctl", "net.netfilter.nf_conntrack_acct=1",
      "--sysctl", "net.ipv4.conf.all.rp_filter=0",
      "--sysctl", "net.ipv4.conf.default.rp_filter=0",
      "--read-only", "--cap-drop", "ALL",
      "--cap-add", "NET_ADMIN", "--cap-add", "SETUID", "--cap-add", "SETGID",
      "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "SETPCAP",
      "--device", "/dev/net/tun:/dev/net/tun",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "256", "--memory", "1g", "--cpus", "1",
      "--tmpfs", "/run:rw,nosuid,nodev,mode=1777,size=64m",
      "--mount", `type=bind,src=${join(trafficRoot, "flows", "web-replay")},dst=/traffic/flows/web-replay`,
      "--mount", `type=bind,src=${join(trafficRoot, "ca")},dst=/traffic/ca`,
      "--env", "LUANNIAO_TASK_FLOW_ROOT=/traffic/flows/web-replay",
      "--env", `LUANNIAO_RUN_REF=${basenameRef(this.runtimeDir)}`,
      "--env", "LUANNIAO_TASK_REF=web-replay",
      "--env", `LUANNIAO_TASK_NETWORK_CIDR=${taskSubnet}`,
      "--env", `LUANNIAO_CONTROL_NETWORK_CIDR=${controlSubnet}`,
      "--env", `LUANNIAO_DIRECT_BROKER=${hostEgress.host}:${hostEgress.port}`,
      "--env", `LUANNIAO_DIRECT_BROKER_TOKEN=${hostEgress.token}`,
      "--env", `LUANNIAO_LOCAL_DIRECT_DENY_PORTS=${hostEgress.port}`,
      "--env", "LUANNIAO_TRUSTED_REPLAY=1",
      ...this.captureEnvironment,
      this.image, "gateway"
    ];
    const configDigest = createHash("sha256").update(JSON.stringify(containerArgs)).digest("hex");
    const inspected = await this.runner([
      "inspect", "--format",
      "{{.State.Running}}|{{index .Config.Labels \"luanniao.managed\"}}|{{index .Config.Labels \"luanniao.role\"}}|{{index .Config.Labels \"luanniao.config\"}}|{{.Image}}",
      this.containerName
    ]);
    const [running, managed, role, actualDigest, actualImageId] = inspected.stdout.trim().split("|");
    if (inspected.code === 0 && (managed !== "true" || role !== "replay-gateway")) {
      throw new Error(`Refusing to replace unmanaged container ${this.containerName}`);
    }
    const targetImageId = inspected.code === 0 ? await this.resolveTargetImageId() : undefined;
    if (inspected.code !== 0 || running !== "true" || actualDigest !== configDigest || actualImageId !== targetImageId) {
      if (inspected.code === 0) await this.removeGateway();
      const started = await this.runner([
        "run", "-d", "--name", this.containerName,
        "--label", "luanniao.managed=true", "--label", "luanniao.role=replay-gateway",
        "--label", `luanniao.config=${configDigest}`,
        "--label", `luanniao.runtime_dir=${this.runtimeDir}`,
        ...containerArgs
      ]);
      if (started.code !== 0) throw new Error(`Failed to start replay gateway: ${started.stderr}`);
    }
    const attached = await this.runner(["network", "connect", this.taskNetworkName, this.containerName]);
    if (attached.code !== 0 && !/already exists|already connected/i.test(attached.stderr)) {
      throw new Error(`Failed to attach Replay Gateway task network: ${attached.stderr || attached.stdout}`);
    }
    await this.waitForGateway();
  }

  private async ensureTaskNetwork(): Promise<string> {
    const inspected = await this.runner([
      "network", "inspect", "--format",
      "{{index .Labels \"luanniao.managed\"}}|{{index .Labels \"luanniao.role\"}}|{{(index .IPAM.Config 0).Subnet}}|{{.Internal}}",
      this.taskNetworkName
    ]);
    if (inspected.code === 0) {
      const [managed, role, subnet, internal] = inspected.stdout.trim().split("|");
      if (managed !== "true" || role !== "replay-task-network" || internal !== "true" || !subnet) {
        throw new Error(`Refusing to use unmanaged replay task network ${this.taskNetworkName}`);
      }
      this.taskNetworkStarted = true;
      return subnet;
    }
    const created = await this.runner([
      "network", "create", "--internal",
      "--label", "luanniao.managed=true",
      "--label", "luanniao.role=replay-task-network",
      "--label", `luanniao.runtime_dir=${this.runtimeDir}`,
      this.taskNetworkName
    ]);
    if (created.code !== 0) throw new Error(`Failed to create replay task network: ${created.stderr || created.stdout}`);
    this.taskNetworkStarted = true;
    return this.networkSubnet(this.taskNetworkName);
  }

  private async networkSubnet(name: string): Promise<string> {
    const result = await this.runner(["network", "inspect", "--format", "{{(index .IPAM.Config 0).Subnet}}", name]);
    const subnet = result.stdout.trim();
    if (result.code !== 0 || !subnet) throw new Error(`Failed to inspect Docker network ${name}: ${result.stderr || result.stdout}`);
    return subnet;
  }

  private async removeTaskNetwork(): Promise<void> {
    if (!this.taskNetworkStarted) return;
    const removed = await this.runner(["network", "rm", this.taskNetworkName]);
    if (removed.code !== 0 && !/not found|no such network/i.test(removed.stderr)) {
      throw new Error(`Failed to remove replay task network: ${removed.stderr || removed.stdout}`);
    }
    this.taskNetworkStarted = false;
  }

  private resolveTargetImageId(): Promise<string> {
    this.targetImageIdPromise ??= this.runner([
      "image", "inspect", "--format", "{{.Id}}", this.image
    ]).then((result) => {
      const imageId = result.stdout.trim();
      if (result.code !== 0 || !imageId) {
        throw new Error(`Failed to resolve replay gateway image ${this.image}: ${result.stderr || result.stdout}`);
      }
      return imageId;
    }).catch((error: unknown) => {
      this.targetImageIdPromise = undefined;
      throw error;
    });
    return this.targetImageIdPromise;
  }

  private async removeGateway(): Promise<void> {
    const inspected = await this.runner([
      "inspect", "--format",
      "{{index .Config.Labels \"luanniao.managed\"}}|{{index .Config.Labels \"luanniao.role\"}}",
      this.containerName
    ]);
    if (inspected.code !== 0) return;
    const [managed, role] = inspected.stdout.trim().split("|");
    if (managed !== "true" || role !== "replay-gateway") {
      throw new Error(`Refusing to remove unmanaged container ${this.containerName}`);
    }
    const removed = await this.runner(["rm", "-f", this.containerName]);
    if (removed.code !== 0) throw new Error(`Failed to remove replay gateway: ${removed.stderr}`);
  }

  private async applyRoutes(routes: NetworkRoute[]): Promise<void> {
    await this.gatewayControl("routes.replace", { routes });
  }

  private async gatewayControl(command: string, payload: object): Promise<void> {
    const result = await this.runner([
      "exec", this.containerName, "gatewayctl", command, JSON.stringify(payload)
    ]);
    if (result.code !== 0 || !result.stdout.includes('"ok":true')) {
      throw new Error(`Replay gateway ${command} failed: ${result.stderr || result.stdout}`);
    }
  }

  private async waitForGateway(): Promise<void> {
    let lastError = "gateway control socket is not ready";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await this.runner(["exec", this.containerName, "gatewayctl", "health", "{}"]);
      if (result.code === 0 && result.stdout.includes('"ok":true')) return;
      lastError = result.stderr || result.stdout || lastError;
      await delay(100);
    }
    throw new Error(`Replay gateway failed readiness: ${lastError}`);
  }

}

function replayCommandStatus(result: CommandResult | undefined): number {
  if (!result) return 0;
  try {
    const value = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as { status?: unknown };
    return typeof value.status === "number" ? value.status : 0;
  } catch {
    return 0;
  }
}

function replayCommandError(result: CommandResult): string {
  try {
    const value = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as { error?: unknown };
    if (typeof value.error === "string" && value.error) return value.error;
  } catch {
    // Fall through to process output.
  }
  return result.stderr || result.stdout || "Replay request failed";
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 180);
}

function basenameRef(runtimeDir: string): string {
  return runtimeDir.split(/[\\/]/).filter(Boolean).at(-1) ?? "web-replay";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function dockerCommand(args: string[], stdin?: string, timeoutMs = 30_000): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn("docker", args, { stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(result);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      finish({ code: null, stdout, stderr: `${stderr}${stderr ? "\n" : ""}docker command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timeout.unref();
    if (stdin !== undefined) child.stdin!.end(stdin);
    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish({ code: 1, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}
