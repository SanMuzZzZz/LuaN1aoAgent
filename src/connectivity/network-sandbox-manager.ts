import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, chown, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HostEgressBroker, luanniaoDebugEnabled, type HostEgressBrokerEndpoint } from "./host-egress-broker.js";
import { normalizeScope, parseAuthorizedScope } from "../scope.js";

export const DEFAULT_NETWORK_IMAGE = "luanniao-network:latest";
const DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const NETWORK_REMOVE_ATTEMPTS = 20;
const NETWORK_REMOVE_RETRY_MS = 100;
const NETWORK_CAPTURE_ENV_LIMITS = {
  LUANNIAO_CAPTURE_BYTES: 2_147_483_647,
  LUANNIAO_TCP_CAPTURE_BYTES: 2_147_483_647,
  LUANNIAO_MITM_SEGMENT_BYTES: 2_147_483_647,
  LUANNIAO_NET_SEGMENT_BYTES: 2_147_483_647,
  LUANNIAO_CAPTURE_MAX_FILES: 1024
} as const;

export function networkCaptureDockerEnv(environment: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = [];
  for (const [key, maximum] of Object.entries(NETWORK_CAPTURE_ENV_LIMITS)) {
    const raw = environment[key]?.trim();
    if (!raw) continue;
    if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a positive integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${key} must be between 1 and ${maximum}`);
    }
    args.push("--env", `${key}=${value}`);
  }
  return args;
}

export type NetworkRoute = {
  routeRef: string;
  cidr: string;
  prefixLength: number;
  socksHost: string;
  socksPort: number;
  connectionRef?: string;
};

export type TaskGateway = {
  taskId: string;
  epochId: string;
  containerName: string;
  networkName: string;
  controlNetworkName?: string;
  gatewayAddress: string;
  controlAddress?: string;
  dnsAddress: string;
  imageId?: string;
  flowFile: string;
  netFile: string;
};

export type GatewayEpochDrainAck = {
  epochRef: string;
  gatewayPresent: boolean;
  activeFlowCount: number;
  activeTcpCount: number;
  activeNetworkCount: number;
  persistedFlowSequence: number;
  persistedNetworkSequence: number;
  flowBytes: number;
  netBytes: number;
  flushed: boolean;
  captureError?: string;
};

type CommandResult = { code: number | null; stdout: string; stderr: string };
type CommandRunner = (args: string[], stdin?: string) => Promise<CommandResult>;

export type NetworkSandboxStartOptions = {
  connector?: boolean;
};

export class NetworkSandboxManager {
  readonly runtimeDir: string;
  readonly runRef: string;
  readonly image: string;
  readonly connectorName: string;
  readonly indexName: string;
  readonly networkName: string;
  indexToken = "";
  indexUrl?: string;
  connectorAddress?: string;
  chiselEndpoint?: string;
  chiselAuth?: string;
  chiselFingerprint?: string;
  private readonly gateways = new Map<string, TaskGateway>();
  private readonly routes = new Map<string, NetworkRoute>();
  private readonly partialContainers = new Map<string, string>();
  private readonly runner: CommandRunner;
  private readonly fetcher: typeof fetch;
  private readonly manageFlowIndex: boolean;
  private readonly captureEnvironment: string[];
  private readonly knownTaskIds: string[];
  private readonly hostEgressBroker: HostEgressBroker;
  private hostEgressEndpoint?: HostEgressBrokerEndpoint;
  private readonly taskNetworks = new Set<string>();
  private authorizedScope?: string;
  private mutationQueue: Promise<void> = Promise.resolve();
  private started = false;
  private connectorStarted = false;
  private indexStarted = false;
  private baseStartPromise?: Promise<void>;
  private connectorStartPromise?: Promise<void>;
  private targetImageIdPromise?: Promise<string>;
  private cleanupNetworkPending = false;

  constructor(input: {
    runtimeDir: string;
    runRef: string;
    image?: string;
    runner?: CommandRunner;
    fetcher?: typeof fetch;
    manageFlowIndex?: boolean;
    knownTaskIds?: string[];
    environment?: NodeJS.ProcessEnv;
    hostEgressBroker?: HostEgressBroker;
  }) {
    this.runtimeDir = resolve(input.runtimeDir);
    this.runRef = input.runRef;
    this.image = input.image ?? (process.env.LUANNIAO_NETWORK_IMAGE?.trim() || DEFAULT_NETWORK_IMAGE);
    const digest = createHash("sha256").update(`${this.runtimeDir}:${this.runRef}`).digest("hex").slice(0, 16);
    this.connectorName = `luanniao-connect-${digest}`;
    this.indexName = `luanniao-index-${digest}`;
    this.networkName = `luanniao-net-${digest}`;
    this.runner = input.runner ?? dockerCommand;
    this.fetcher = input.fetcher ?? fetch;
    this.manageFlowIndex = input.manageFlowIndex ?? true;
    this.captureEnvironment = networkCaptureDockerEnv(input.environment ?? process.env);
    this.knownTaskIds = [...new Set(input.knownTaskIds ?? [])].sort();
    this.hostEgressBroker = input.hostEgressBroker ?? new HostEgressBroker();
  }

  configureAuthorizedScope(scope: string): Promise<void> {
    return this.withMutation(async () => {
      const normalized = normalizeScope(scope);
      if (this.authorizedScope && this.authorizedScope !== normalized) {
        throw new Error("Authorized scope cannot change after network sandbox initialization");
      }
      this.authorizedScope = normalized;
      if (this.started) {
        await this.adoptPersistedGateways();
      }
    });
  }

  async start(options: NetworkSandboxStartOptions = {}): Promise<void> {
    await this.ensureBaseStarted();
    if (options.connector !== false) await this.ensureConnectorStarted();
  }

  private async ensureBaseStarted(): Promise<void> {
    if (this.started) return;
    this.baseStartPromise ??= this.startBase().catch((error: unknown) => {
      this.baseStartPromise = undefined;
      throw error;
    });
    await this.baseStartPromise;
  }

  private async startBase(): Promise<void> {
    const trafficRoot = join(this.runtimeDir, "traffic");
    await mkdir(join(trafficRoot, "flows"), { recursive: true });
    await mkdir(join(trafficRoot, "ca"), { recursive: true });
    await this.chownGatewayStorage(join(trafficRoot, "flows"));
    await this.chownGatewayStorage(join(trafficRoot, "ca"));
    if (this.manageFlowIndex) this.indexToken = await this.loadIndexToken(trafficRoot);
    await this.ensureHostEgressBroker();
    let networkCreated = false;
    let indexReconciled = false;
    try {
      networkCreated = await this.ensureNetwork();
      if (this.manageFlowIndex) {
        await this.reconcileContainer(this.indexName, "index", [
          "--read-only", "--cap-drop", "ALL",
          "--group-add", "101",
          "--security-opt", "no-new-privileges",
          "--pids-limit", "128",
          "--memory", "512m",
          "--cpus", "1",
          "--publish", "127.0.0.1::8788",
          "--mount", `type=bind,src=${trafficRoot},dst=/traffic,readonly`,
          "--env", "LUANNIAO_FLOW_ROOT=/traffic/flows",
          "--env", `LUANNIAO_INDEX_TOKEN=${this.indexToken}`,
          ...this.captureEnvironment,
          this.image, "index", "--listen", "0.0.0.0:8788"
        ], { runRef: this.runRef });
        indexReconciled = true;
        this.partialContainers.set(this.indexName, "index");
        const port = await this.indexPort();
        this.indexUrl = `http://127.0.0.1:${port}`;
        await this.waitForIndex();
        const descriptorPath = join(trafficRoot, "index.json");
        const temporaryDescriptorPath = `${descriptorPath}.${process.pid}.tmp`;
        await writeFile(temporaryDescriptorPath, JSON.stringify({ url: this.indexUrl, token: this.indexToken }), { mode: 0o600 });
        await chmod(temporaryDescriptorPath, 0o600);
        await rename(temporaryDescriptorPath, descriptorPath);
        this.indexStarted = true;
        this.partialContainers.delete(this.indexName);
      }
      await this.adoptPersistedGateways();
      this.started = true;
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (indexReconciled) {
        try {
          await this.removeManagedContainer(this.indexName, "index");
          this.partialContainers.delete(this.indexName);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (networkCreated) {
        this.cleanupNetworkPending = true;
        try {
          await this.removeManagedNetwork();
          this.cleanupNetworkPending = false;
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      try {
        await this.hostEgressBroker.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      this.hostEgressEndpoint = undefined;
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], "Network sandbox startup cleanup failed");
      }
      throw error;
    }
  }

  private async ensureConnectorStarted(): Promise<void> {
    if (this.connectorStarted) return;
    this.connectorStartPromise ??= this.startConnector().catch((error: unknown) => {
      this.connectorStartPromise = undefined;
      throw error;
    });
    await this.connectorStartPromise;
  }

  private async startConnector(): Promise<void> {
    await this.ensureBaseStarted();
    const chiselPublicHost = process.env.LUANNIAO_CHISEL_PUBLIC_HOST?.trim();
    if (chiselPublicHost && !/^[A-Za-z0-9.-]+$/.test(chiselPublicHost)) {
      throw new Error("LUANNIAO_CHISEL_PUBLIC_HOST must be a hostname or IPv4 address");
    }
    let connectorReconciled = false;
    try {
      await this.reconcileContainer(this.connectorName, "connector", [
        "--network", this.networkName,
        "--network-alias", "connector",
        "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "256",
        "--memory", "512m",
        "--cpus", "1",
        ...(chiselPublicHost ? ["--publish", `${process.env.LUANNIAO_CHISEL_BIND_HOST?.trim() || "0.0.0.0"}::19090`] : []),
        "--tmpfs", "/run:rw,nosuid,nodev,size=64m",
        this.image, "connector"
      ], { runRef: this.runRef });
      connectorReconciled = true;
      this.partialContainers.set(this.connectorName, "connector");
      this.connectorAddress = await this.rememberContainerAddresses(this.connectorName);
      if (!this.connectorAddress) throw new Error("Connector container has no routable IPv4 address");
      if (chiselPublicHost) await this.startChiselServer(chiselPublicHost);
      this.connectorStarted = true;
      this.partialContainers.delete(this.connectorName);
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (connectorReconciled) {
        try {
          await this.removeManagedContainer(this.connectorName, "connector");
          this.partialContainers.delete(this.connectorName);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      this.connectorAddress = undefined;
      this.chiselEndpoint = undefined;
      this.chiselAuth = undefined;
      this.chiselFingerprint = undefined;
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], "Connector startup cleanup failed");
      }
      throw error;
    }
  }

  createGateway(input: { taskId: string; epochId: string }): Promise<TaskGateway> {
    return this.withMutation(() => this.createGatewayUnlocked(input));
  }

  private async createGatewayUnlocked(input: { taskId: string; epochId: string }): Promise<TaskGateway> {
    await this.start({ connector: false });
    const existing = this.gateways.get(input.taskId);
    if (existing) {
      await this.ensureGatewayReady(input.taskId);
      const ready = this.gateways.get(input.taskId);
      if (!ready) throw new Error(`Gateway ${input.taskId} disappeared during recovery`);
      const epoch = await this.readGatewayEpoch(ready.containerName);
      if (epoch?.active === true && epoch.epochRef === input.epochId) return ready;
      const pendingEpoch = epoch?.epochRef || (ready.epochId !== input.epochId ? ready.epochId : "");
      if (pendingEpoch) {
        await this.endGatewayEpoch({ ...ready, epochId: pendingEpoch }, pendingEpoch);
      }
      return this.beginEpoch({ ...ready, epochId: "" }, input.epochId);
    }
    const taskNetwork = await this.ensureTaskNetwork(input.taskId);
    const { containerName, runArgs } = await this.gatewaySpec(input.taskId, taskNetwork);
    let gatewayReconciled = false;
    try {
      await this.prepareGatewayStorage(input.taskId);
      await this.reconcileContainer(containerName, "gateway", runArgs, {
        runRef: this.runRef,
        taskRef: input.taskId
      });
      gatewayReconciled = true;
      this.partialContainers.set(containerName, "gateway");
      await this.ensureContainerNetwork(containerName, taskNetwork.name);
      await this.waitForGateway(containerName);
      const gatewayAddress = await this.containerAddress(containerName, taskNetwork.name);
      if (!gatewayAddress) throw new Error(`Gateway ${containerName} has no task-network address`);
      const controlAddress = await this.containerAddress(containerName, this.networkName);
      const gateway: TaskGateway = {
        taskId: input.taskId,
        epochId: "",
        containerName,
        networkName: taskNetwork.name,
        controlNetworkName: this.networkName,
        gatewayAddress,
        controlAddress,
        dnsAddress: gatewayAddress,
        imageId: await this.resolveTargetImageId(),
        flowFile: "",
        netFile: ""
      };
      this.gateways.set(input.taskId, gateway);
      await this.applyRoutes(gateway);
      const startedGateway = await this.beginEpoch(gateway, input.epochId);
      this.partialContainers.delete(containerName);
      return startedGateway;
    } catch (error) {
      this.gateways.delete(input.taskId);
      const cleanupFailures: unknown[] = [];
      if (gatewayReconciled) {
        try {
          await this.removeManagedContainer(containerName, "gateway", input.taskId);
          this.partialContainers.delete(containerName);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      await this.removeManagedTaskNetwork(input.taskId).catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], "Gateway startup cleanup failed");
      }
      throw error;
    }
  }

  gatewayContainerName(taskId: string): string {
    const digest = createHash("sha256").update(`${this.runtimeDir}:${taskId}`).digest("hex").slice(0, 16);
    return `luanniao-gateway-${digest}`;
  }

  taskNetworkName(taskId: string): string {
    const digest = createHash("sha256").update(`${this.runtimeDir}:${taskId}:task-network`).digest("hex").slice(0, 16);
    return `luanniao-task-${digest}`;
  }

  private async gatewaySpec(
    taskId: string,
    taskNetwork?: { name: string; subnet: string }
  ): Promise<{ containerName: string; runArgs: string[]; configDigest: string }> {
    if (!this.authorizedScope) {
      throw new Error("Authorized scope must be configured before creating a task Gateway");
    }
    const authorizedScope = parseAuthorizedScope(this.authorizedScope);
    const hostEgress = await this.ensureHostEgressBroker();
    const indexPort = this.indexUrl ? Number(new URL(this.indexUrl).port) : undefined;
    const protectedHostPorts = [hostEgress.port, indexPort]
      .filter((port): port is number => Number.isInteger(port) && (port ?? 0) > 0);
    taskNetwork ??= await this.ensureTaskNetwork(taskId);
    const containerName = this.gatewayContainerName(taskId);
    const taskFlowName = safeName(taskId);
    const hostDir = join(this.runtimeDir, "traffic", "flows", taskFlowName);
    await mkdir(hostDir, { recursive: true });
    await this.chownGatewayStorage(hostDir);
    const runArgs = [
      "--network", this.networkName,
      "--add-host", "host.docker.internal:host-gateway",
      "--sysctl", "net.ipv6.conf.all.disable_ipv6=1",
      "--sysctl", "net.ipv6.conf.default.disable_ipv6=1",
      "--sysctl", "net.netfilter.nf_conntrack_acct=1",
      "--sysctl", "net.ipv4.ip_forward=1",
      "--sysctl", "net.ipv4.conf.all.rp_filter=0",
      "--sysctl", "net.ipv4.conf.default.rp_filter=0",
      "--read-only", "--cap-drop", "ALL",
      "--cap-add", "NET_ADMIN", "--cap-add", "SETUID", "--cap-add", "SETGID",
      "--group-add", "101",
      "--device", "/dev/net/tun:/dev/net/tun",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "256",
      "--memory", "1g",
      "--cpus", "1",
      "--tmpfs", "/run:rw,nosuid,nodev,size=64m",
      "--mount", `type=bind,src=${hostDir},dst=/traffic/flows/${taskFlowName}`,
      "--mount", `type=bind,src=${join(this.runtimeDir, "traffic", "ca")},dst=/traffic/ca`,
      "--env", `LUANNIAO_TASK_FLOW_ROOT=/traffic/flows/${taskFlowName}`,
      "--env", `LUANNIAO_RUN_REF=${this.runRef}`,
      "--env", `LUANNIAO_TASK_REF=${taskId}`,
      "--env", `LUANNIAO_TASK_NETWORK_CIDR=${taskNetwork.subnet}`,
      "--env", `LUANNIAO_CONTROL_NETWORK_CIDR=${await this.networkSubnet(this.networkName)}`,
      "--env", `LUANNIAO_AUTHORIZED_CIDRS=${authorizedScope.cidrs.join(",")}`,
      "--env", `LUANNIAO_AUTHORIZED_DOMAINS=${authorizedScope.domains.join(",")}`,
      "--env", `LUANNIAO_DIRECT_BROKER=${hostEgress.host}:${hostEgress.port}`,
      "--env", `LUANNIAO_DIRECT_BROKER_TOKEN=${hostEgress.token}`,
      "--env", `LUANNIAO_LOCAL_DIRECT_DENY_PORTS=${protectedHostPorts.join(",")}`,
      ...(luanniaoDebugEnabled() ? ["--env", "LUANNIAO_DEBUG=1"] : []),
      ...this.captureEnvironment,
      this.image, "gateway"
    ];
    return {
      containerName,
      runArgs,
      configDigest: createHash("sha256").update(JSON.stringify(runArgs)).digest("hex")
    };
  }

  // Best-effort host-side expression of the uid 101 single-owner invariant:
  // the in-container data planes run as uid/gid 101, so capture storage
  // created by this (root) host process must be handed over before the
  // storage-init helper or the gateway ever touches it. The storage-init
  // container remains the authoritative enforcement point.
  private async chownGatewayStorage(dir: string): Promise<void> {
    try {
      await chown(dir, 101, 101);
      await chmod(dir, 0o2770);
    } catch {
      // Best-effort only: insufficient privileges (e.g. non-root host) must
      // not block gateway startup.
    }
  }

  private async prepareGatewayStorage(taskId: string): Promise<void> {
    const taskFlowName = safeName(taskId);
    const flowDir = join(this.runtimeDir, "traffic", "flows", taskFlowName);
    const caDir = join(this.runtimeDir, "traffic", "ca");
    const result = await this.runner([
      "run", "--rm", "--network", "none",
      "--read-only", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE",
      "--security-opt", "no-new-privileges",
      "--mount", `type=bind,src=${flowDir},dst=/storage/flows`,
      "--mount", `type=bind,src=${caDir},dst=/storage/ca`,
      this.image, "storage-init", "/storage/flows", "/storage/ca"
    ]);
    if (result.code !== 0) {
      throw new Error(`Failed to initialize Gateway storage for ${taskId}: ${result.stderr || result.stdout}`);
    }
  }

  private async adoptPersistedGateways(): Promise<void> {
    if (!this.authorizedScope) return;
    for (const taskId of this.knownTaskIds) {
      const taskNetwork = await this.ensureTaskNetwork(taskId);
      const spec = await this.gatewaySpec(taskId, taskNetwork);
      const inspect = await this.runner([
        "inspect", "--format",
        "{{.State.Running}}|{{index .Config.Labels \"luanniao.managed\"}}|{{index .Config.Labels \"luanniao.role\"}}|{{index .Config.Labels \"luanniao.config\"}}|{{index .Config.Labels \"luanniao.run_ref\"}}|{{index .Config.Labels \"luanniao.task_ref\"}}|{{.Image}}",
        spec.containerName
      ]);
      if (inspect.code !== 0) continue;
      const [running, managed, role, configDigest, rawRunRef, rawTaskRef, actualImageId] = inspect.stdout.trim().split("|");
      const runRef = optionalDockerLabel(rawRunRef);
      const taskRef = optionalDockerLabel(rawTaskRef);
      const labeled = runRef !== undefined || taskRef !== undefined;
      const owned = managed === "true"
        && role === "gateway"
        && (labeled
          ? runRef === this.runRef && taskRef === taskId
          : configDigest === spec.configDigest);
      if (!owned) {
        throw new Error(`Refusing to adopt gateway outside this runtime: ${spec.containerName}`);
      }
      const targetImageId = await this.resolveTargetImageId();
      if (configDigest !== spec.configDigest || actualImageId !== targetImageId) {
        if (running === "true") await this.stopContainerBestEffort(spec.containerName);
        await this.removeManagedContainer(spec.containerName, "gateway", taskId);
        continue;
      }
      const epoch = running === "true" ? await this.readGatewayEpoch(spec.containerName) : undefined;
      const epochRef = typeof epoch?.epochRef === "string" ? epoch.epochRef : "";
      const epochId = epochRef && (epoch?.active === true || !persistedDrainComplete(epoch?.drainAck, epochRef))
        ? epochRef
        : "";
      const taskFlowName = safeName(taskId);
      if (running === "true") await this.ensureContainerNetwork(spec.containerName, taskNetwork.name);
      const gatewayAddress = running === "true"
        ? await this.containerAddress(spec.containerName, taskNetwork.name)
        : "";
      this.gateways.set(taskId, {
        taskId,
        epochId,
        containerName: spec.containerName,
        networkName: taskNetwork.name,
        controlNetworkName: this.networkName,
        gatewayAddress: gatewayAddress ?? "",
        controlAddress: running === "true"
          ? await this.containerAddress(spec.containerName, this.networkName)
          : undefined,
        dnsAddress: gatewayAddress ?? "",
        imageId: targetImageId,
        flowFile: epochId
          ? join(this.runtimeDir, "traffic", "flows", taskFlowName, `${safeName(epochId)}.mitm`)
          : "",
        netFile: epochId
          ? join(this.runtimeDir, "traffic", "flows", taskFlowName, `${safeName(epochId)}.net.jsonl`)
          : ""
      });
      if (running === "true" && !gatewayAddress) {
        throw new Error(`Persisted gateway ${spec.containerName} has no task-network address`);
      }
    }
  }

  private async ensureGatewayReady(taskId: string): Promise<void> {
    const gateway = this.gateways.get(taskId);
    if (!gateway) return;
    const taskNetwork = await this.ensureTaskNetwork(taskId);
    const spec = await this.gatewaySpec(taskId, taskNetwork);
    await this.prepareGatewayStorage(taskId);
    await this.reconcileContainer(spec.containerName, "gateway", spec.runArgs, {
      runRef: this.runRef,
      taskRef: taskId
    });
    await this.ensureContainerNetwork(spec.containerName, taskNetwork.name);
    await this.waitForGateway(spec.containerName);
    const gatewayAddress = await this.containerAddress(spec.containerName, taskNetwork.name);
    if (!gatewayAddress) throw new Error(`Gateway ${spec.containerName} has no task-network address`);
    const controlAddress = await this.containerAddress(spec.containerName, this.networkName);
    this.gateways.set(taskId, {
      ...gateway,
      networkName: taskNetwork.name,
      controlNetworkName: this.networkName,
      gatewayAddress,
      controlAddress,
      dnsAddress: gatewayAddress,
      imageId: await this.resolveTargetImageId()
    });
    await this.applyRoutes(gateway);
  }

  private async readGatewayEpoch(containerName: string): Promise<{
    active?: boolean;
    epochRef?: string;
    drainAck?: unknown;
  } | undefined> {
    const result = await this.runner(["exec", containerName, "cat", "/run/luanniao/epoch.json"]);
    if (result.code !== 0) return undefined;
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as { active?: boolean; epochRef?: string; drainAck?: unknown }
        : undefined;
    } catch {
      return undefined;
    }
  }

  endEpoch(taskId: string, epochId?: string): Promise<GatewayEpochDrainAck> {
    return this.withMutation(() => this.endEpochUnlocked(taskId, epochId));
  }

  private async endEpochUnlocked(taskId: string, epochId?: string): Promise<GatewayEpochDrainAck> {
    const gateway = this.gateways.get(taskId);
    if (!gateway) return emptyDrainAck(epochId ?? "", false);
    if (epochId && gateway.epochId && gateway.epochId !== epochId) {
      throw new Error(`Gateway epoch mismatch for ${taskId}: active=${gateway.epochId} requested=${epochId}`);
    }
    if (!gateway.epochId) return emptyDrainAck(epochId ?? "", true);
    const ack = await this.endGatewayEpoch(gateway, epochId ?? gateway.epochId);
    this.gateways.set(taskId, { ...gateway, epochId: "" });
    return ack;
  }

  gatewayCaPath(): string {
    return join(this.runtimeDir, "traffic", "ca", "mitmproxy-ca-cert.pem");
  }

  hostEgress(): Promise<HostEgressBrokerEndpoint> {
    return this.ensureHostEgressBroker();
  }

  replaceRoutes(routes: NetworkRoute[]): Promise<void> {
    return this.withMutation(() => this.replaceRoutesUnlocked(routes));
  }

  routeSnapshot(): NetworkRoute[] {
    return [...this.routes.values()].map((route) => ({ ...route }));
  }

  pendingEpochs(): Array<{ taskId: string; epochId: string }> {
    return [...this.gateways.values()]
      .filter((gateway) => gateway.epochId.length > 0)
      .map((gateway) => ({ taskId: gateway.taskId, epochId: gateway.epochId }));
  }

  private async replaceRoutesUnlocked(routes: NetworkRoute[]): Promise<void> {
    const previousRoutes = [...this.routes.values()];
    const gateways = [...this.gateways.values()];
    const routesPath = join(this.runtimeDir, "traffic", "routes.json");
    const temporaryPath = `${routesPath}.tmp-${process.pid}`;
    await writeFile(temporaryPath, JSON.stringify({ routes }), { mode: 0o644 });
    await chmod(temporaryPath, 0o644);
    const applied = await Promise.allSettled(gateways.map((gateway) => this.applyRoutes(gateway, routes)));
    const applyFailures = applied.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (applyFailures.length > 0) {
      const rollbackFailures = await this.rollbackRoutes(gateways, previousRoutes);
      await rm(temporaryPath, { force: true });
      throw new AggregateError(
        [...applyFailures.map((result) => result.reason), ...rollbackFailures],
        "Failed to update gateway route snapshots"
      );
    }
    try {
      await rename(temporaryPath, routesPath);
    } catch (error) {
      const rollbackFailures = await this.rollbackRoutes(gateways, previousRoutes);
      await rm(temporaryPath, { force: true });
      throw new AggregateError([error, ...rollbackFailures], "Failed to commit gateway route snapshot");
    }
    this.routes.clear();
    for (const route of routes) this.routes.set(`${route.routeRef}|${route.cidr}`, route);
  }

  async connectorExec(command: string, stdin?: string): Promise<CommandResult> {
    await this.start();
    return this.runner(["exec", "-i", this.connectorName, "sh", "-c", command], stdin);
  }

  disposeGateway(taskId: string): Promise<void> {
    return this.withMutation(() => this.disposeGatewayUnlocked(taskId));
  }

  private async disposeGatewayUnlocked(taskId: string): Promise<void> {
    const gateway = this.gateways.get(taskId);
    if (!gateway) return;
    await this.endGatewayEpoch(gateway);
    this.gateways.set(taskId, { ...gateway, epochId: "" });
    await this.removeManagedContainer(gateway.containerName, "gateway", taskId);
    this.gateways.delete(taskId);
    await this.removeManagedTaskNetwork(taskId);
  }

  close(): Promise<void> {
    return this.withMutation(() => this.closeUnlocked());
  }

  private async closeUnlocked(): Promise<void> {
    if (!this.started
      && !this.cleanupNetworkPending
      && !this.indexStarted
      && !this.connectorStarted
      && !this.hostEgressEndpoint
      && this.gateways.size === 0
      && this.partialContainers.size === 0) return;
    const failures: unknown[] = [];
    for (const taskId of [...this.gateways.keys()]) {
      try {
        await this.disposeGatewayUnlocked(taskId);
      } catch (error) {
        failures.push(error);
      }
    }
    const containers = new Map(this.partialContainers);
    if (this.indexStarted) containers.set(this.indexName, "index");
    if (this.connectorStarted) containers.set(this.connectorName, "connector");
    const removals = await Promise.allSettled([...containers].map(async ([name, role]) => {
      await this.removeManagedContainer(name, role);
      this.partialContainers.delete(name);
      if (name === this.indexName) {
        this.indexStarted = false;
        this.indexUrl = undefined;
      }
      if (name === this.connectorName) {
        this.connectorStarted = false;
        this.connectorAddress = undefined;
        this.chiselEndpoint = undefined;
        this.chiselAuth = undefined;
        this.chiselFingerprint = undefined;
      }
    }));
    failures.push(...removals
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason));
    const taskNetworkRemovals = await Promise.allSettled(
      [...this.taskNetworks].map((taskId) => this.removeManagedTaskNetwork(taskId))
    );
    failures.push(...taskNetworkRemovals
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason));
    if (this.started || this.cleanupNetworkPending) {
      try {
        await this.removeManagedNetwork();
        this.cleanupNetworkPending = false;
        this.started = false;
        this.baseStartPromise = undefined;
        this.connectorStartPromise = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.hostEgressBroker.close();
      this.hostEgressEndpoint = undefined;
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, "Network sandbox cleanup failed");
    }
  }

  private async removeManagedNetwork(): Promise<void> {
    let lastError = "network still exists";
    for (let attempt = 0; attempt < NETWORK_REMOVE_ATTEMPTS; attempt += 1) {
      const removed = await this.runner(["network", "rm", this.networkName]);
      if (removed.code === 0) return;
      lastError = removed.stderr || removed.stdout || lastError;
      const inspected = await this.runner([
        "network", "inspect", "--format",
        "{{index .Labels \"luanniao.managed\"}}|{{index .Labels \"luanniao.role\"}}|{{index .Labels \"luanniao.run_ref\"}}",
        this.networkName
      ]);
      if (inspected.code !== 0) return;
      const [managed, role, rawRunRef] = inspected.stdout.trim().split("|");
      const runRef = optionalDockerLabel(rawRunRef);
      if (managed !== "true" || role !== "run-network" || (runRef !== undefined && runRef !== this.runRef)) {
        throw new Error(`Refusing to remove unmanaged network ${this.networkName}`);
      }
      if (attempt + 1 < NETWORK_REMOVE_ATTEMPTS) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, NETWORK_REMOVE_RETRY_MS));
      }
    }
    throw new Error(`Failed to remove network ${this.networkName}: ${lastError}`);
  }

  private async ensureHostEgressBroker(): Promise<HostEgressBrokerEndpoint> {
    this.hostEgressEndpoint ??= await this.hostEgressBroker.start();
    return this.hostEgressEndpoint;
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async applyRoutes(gateway: TaskGateway, routes: NetworkRoute[] = [...this.routes.values()]): Promise<void> {
    const payload = JSON.stringify({ routes });
    const result = await this.runner(["exec", gateway.containerName, "gatewayctl", "routes.replace", payload]);
    if (result.code !== 0 || !result.stdout.includes('"ok":true')) {
      throw new Error(`Failed to configure gateway routes: ${result.stderr || result.stdout}`);
    }
  }

  private async rollbackRoutes(gateways: TaskGateway[], routes: NetworkRoute[]): Promise<unknown[]> {
    const results = await Promise.allSettled(gateways.map((gateway) => this.applyRoutes(gateway, routes)));
    const failures: unknown[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "fulfilled") continue;
      failures.push(result.reason);
      const gateway = gateways[index];
      this.gateways.delete(gateway.taskId);
      try {
        await this.removeManagedContainer(gateway.containerName, "gateway", gateway.taskId);
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }

  private async beginEpoch(gateway: TaskGateway, epochId: string): Promise<TaskGateway> {
    if (gateway.epochId && gateway.epochId !== epochId) {
      await this.endGatewayEpoch(gateway);
    }
    const taskFlowName = safeName(gateway.taskId);
    const epochFlowName = safeName(epochId);
    const flowFile = join(this.runtimeDir, "traffic", "flows", taskFlowName, `${epochFlowName}.mitm`);
    const netFile = join(this.runtimeDir, "traffic", "flows", taskFlowName, `${epochFlowName}.net.jsonl`);
    const result = await this.runner([
      "exec", gateway.containerName, "gatewayctl", "epoch.begin",
      JSON.stringify({
        epochRef: epochId,
        flowFile: `/traffic/flows/${taskFlowName}/${epochFlowName}.mitm`,
        netFile: `/traffic/flows/${taskFlowName}/${epochFlowName}.net.jsonl`
      })
    ]);
    if (result.code !== 0 || !result.stdout.includes('"ok":true')) {
      throw new Error(`Failed to begin gateway epoch: ${result.stderr || result.stdout}`);
    }
    const updated = { ...gateway, epochId, flowFile, netFile };
    this.gateways.set(gateway.taskId, updated);
    return updated;
  }

  private async endGatewayEpoch(
    gateway: TaskGateway,
    epochId: string = gateway.epochId
  ): Promise<GatewayEpochDrainAck> {
    if (!gateway.epochId) return emptyDrainAck(epochId, true);
    const result = await this.runner([
      "exec", gateway.containerName, "gatewayctl", "epoch.end",
      JSON.stringify({ epochRef: epochId })
    ]);
    if (result.code !== 0) {
      const message = result.stderr || result.stdout;
      if (message.includes("capture persistence failed")) {
        // Older gateway images still raise on a latched capture persistence
        // error. Degrade the epoch instead of failing the whole run; the
        // capture gap is surfaced through the acknowledgement.
        return { ...emptyDrainAck(epochId, true), flushed: false, captureError: message };
      }
      throw new Error(`Failed to end gateway epoch: ${message}`);
    }
    return parseDrainAck(result.stdout, epochId);
  }

  private async waitForGateway(containerName: string): Promise<void> {
    let lastError = "gateway control socket is not ready";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await this.runner(["exec", containerName, "gatewayctl", "health", "{}"]);
      if (result.code === 0 && result.stdout.includes('"ok":true')) return;
      lastError = result.stderr || result.stdout || lastError;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`Gateway ${containerName} failed readiness: ${lastError}`);
  }

  private async ensureNetwork(): Promise<boolean> {
    const inspect = await this.runner([
      "network", "inspect", "--format",
      "{{index .Labels \"luanniao.managed\"}}|{{index .Labels \"luanniao.role\"}}|{{index .Labels \"luanniao.run_ref\"}}",
      this.networkName
    ]);
    if (inspect.code === 0) {
      const [managed, role, rawRunRef] = inspect.stdout.trim().split("|");
      const runRef = optionalDockerLabel(rawRunRef);
      if (managed !== "true" || role !== "run-network" || (runRef !== undefined && runRef !== this.runRef)) {
        throw new Error(`Refusing to reuse unmanaged network ${this.networkName}`);
      }
      return false;
    }
    const created = await this.runner([
      "network", "create", "--driver", "bridge",
      "--label", "luanniao.managed=true", "--label", "luanniao.role=run-network",
      "--label", `luanniao.run_ref=${this.runRef}`,
      "--label", `luanniao.runtime_dir=${this.runtimeDir}`,
      this.networkName
    ]);
    if (created.code !== 0) throw new Error(`Failed to create network ${this.networkName}: ${created.stderr}`);
    return true;
  }

  private async ensureTaskNetwork(taskId: string): Promise<{ name: string; subnet: string }> {
    const name = this.taskNetworkName(taskId);
    const inspect = await this.runner([
      "network", "inspect", "--format",
      "{{index .Labels \"luanniao.managed\"}}|{{index .Labels \"luanniao.role\"}}|{{index .Labels \"luanniao.run_ref\"}}|{{index .Labels \"luanniao.task_ref\"}}|{{(index .IPAM.Config 0).Subnet}}|{{.Internal}}",
      name
    ]);
    if (inspect.code === 0) {
      const [managed, role, rawRunRef, rawTaskRef, subnet, internal] = inspect.stdout.trim().split("|");
      if (managed !== "true" || role !== "task-network"
        || optionalDockerLabel(rawRunRef) !== this.runRef
        || optionalDockerLabel(rawTaskRef) !== taskId
        || internal !== "true" || !subnet) {
        throw new Error(`Refusing to reuse invalid task network ${name}`);
      }
      this.taskNetworks.add(taskId);
      return { name, subnet };
    }
    const created = await this.runner([
      "network", "create", "--driver", "bridge", "--internal",
      "--label", "luanniao.managed=true", "--label", "luanniao.role=task-network",
      "--label", `luanniao.run_ref=${this.runRef}`,
      "--label", `luanniao.task_ref=${taskId}`,
      "--label", `luanniao.runtime_dir=${this.runtimeDir}`,
      name
    ]);
    if (created.code !== 0) throw new Error(`Failed to create task network ${name}: ${created.stderr}`);
    this.taskNetworks.add(taskId);
    const subnet = await this.networkSubnet(name);
    return { name, subnet };
  }

  private async networkSubnet(name: string): Promise<string> {
    const result = await this.runner([
      "network", "inspect", "--format", "{{(index .IPAM.Config 0).Subnet}}", name
    ]);
    const subnet = result.stdout.trim();
    if (result.code !== 0 || !subnet) throw new Error(`Failed to inspect network subnet ${name}: ${result.stderr || result.stdout}`);
    return subnet;
  }

  private async ensureContainerNetwork(containerName: string, networkName: string): Promise<void> {
    const attached = await this.runner([
      "inspect", "--format", `{{with index .NetworkSettings.Networks "${networkName}"}}{{.IPAddress}}{{end}}`, containerName
    ]);
    if (attached.code === 0 && attached.stdout.trim()) return;
    const connected = await this.runner(["network", "connect", networkName, containerName]);
    if (connected.code !== 0) throw new Error(`Failed to connect ${containerName} to ${networkName}: ${connected.stderr || connected.stdout}`);
  }

  private async containerAddress(containerName: string, networkName: string): Promise<string | undefined> {
    const result = await this.runner([
      "inspect", "--format", `{{with index .NetworkSettings.Networks "${networkName}"}}{{.IPAddress}}{{end}}`, containerName
    ]);
    const address = result.stdout.trim();
    return result.code === 0 && address ? address : undefined;
  }

  private async removeManagedTaskNetwork(taskId: string): Promise<void> {
    const name = this.taskNetworkName(taskId);
    const inspect = await this.runner([
      "network", "inspect", "--format",
      "{{index .Labels \"luanniao.managed\"}}|{{index .Labels \"luanniao.role\"}}|{{index .Labels \"luanniao.run_ref\"}}|{{index .Labels \"luanniao.task_ref\"}}",
      name
    ]);
    if (inspect.code !== 0) {
      this.taskNetworks.delete(taskId);
      return;
    }
    const [managed, role, rawRunRef, rawTaskRef] = inspect.stdout.trim().split("|");
    if (managed !== "true" || role !== "task-network"
      || optionalDockerLabel(rawRunRef) !== this.runRef
      || optionalDockerLabel(rawTaskRef) !== taskId) {
      throw new Error(`Refusing to remove unmanaged task network ${name}`);
    }
    const removed = await this.runner(["network", "rm", name]);
    if (removed.code !== 0) throw new Error(`Failed to remove task network ${name}: ${removed.stderr || removed.stdout}`);
    this.taskNetworks.delete(taskId);
  }

  private async loadIndexToken(trafficRoot: string): Promise<string> {
    const tokenPath = join(trafficRoot, "index.token");
    try {
      const token = (await readFile(tokenPath, "utf8")).trim();
      if (/^[a-f0-9]{64}$/.test(token)) return token;
    } catch {
      // Create a new runtime-local token below.
    }
    const token = randomBytes(32).toString("hex");
    await writeFile(tokenPath, token, { mode: 0o600 });
    await chmod(tokenPath, 0o600);
    return token;
  }

  private async indexPort(): Promise<number> {
    const result = await this.runner(["port", this.indexName, "8788/tcp"]);
    const match = /127\.0\.0\.1:(\d+)/.exec(result.stdout);
    if (result.code !== 0 || !match) throw new Error(`Failed to resolve flow index port: ${result.stderr || result.stdout}`);
    return Number(match[1]);
  }

  private async waitForIndex(): Promise<void> {
    let lastError = "flow index is not ready";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await this.fetcher(`${this.indexUrl}/health`, {
          headers: { Authorization: `Bearer ${this.indexToken}` },
          signal: AbortSignal.timeout(500)
        });
        if (response.ok) return;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`Flow index failed readiness: ${lastError}`);
  }

  private async startChiselServer(publicHost: string): Promise<void> {
    const username = `run-${createHash("sha256").update(this.runRef).digest("hex").slice(0, 12)}`;
    const password = randomBytes(32).toString("hex");
    const auth = `${username}:${password}`;
    const start = await this.runner([
      "exec", "-i", this.connectorName, "sh", "-c",
      "umask 077; cat > /run/luanniao/chisel.auth; " +
      "old=$(cat /run/luanniao/chisel.pid 2>/dev/null || true); " +
      "[ -z \"$old\" ] || kill -TERM \"$old\" 2>/dev/null || true; " +
      "for _ in 1 2 3 4 5 6 7 8 9 10; do [ -z \"$old\" ] || ! kill -0 \"$old\" 2>/dev/null && break; sleep 0.1; done; " +
      "[ -s /run/luanniao/chisel.key ] || chisel server --keygen /run/luanniao/chisel.key >/dev/null; " +
      ": > /run/luanniao/chisel.log; " +
      "AUTH=$(cat /run/luanniao/chisel.auth) nohup chisel server --reverse --keyfile /run/luanniao/chisel.key --host 0.0.0.0 --port 19090 " +
      ">/run/luanniao/chisel.log 2>&1 & pid=$!; echo $pid > /run/luanniao/chisel.pid; kill -0 \"$pid\""
    ], auth);
    if (start.code !== 0) throw new Error(`Failed to start Chisel connector: ${start.stderr}`);
    let fingerprint: string | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const probe = await this.runner(["exec", this.connectorName, "sh", "-c", "cat /run/luanniao/chisel.log 2>/dev/null || true"]);
      fingerprint = /Fingerprint\s+([A-Za-z0-9+/]{43}=)/.exec(probe.stdout)?.[1];
      if (fingerprint) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (!fingerprint) throw new Error("Chisel connector fingerprint was not reported");
    const portResult = await this.runner(["port", this.connectorName, "19090/tcp"]);
    const port = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/.exec(portResult.stdout)?.[1];
    if (portResult.code !== 0 || !port) throw new Error(`Failed to resolve Chisel connector port: ${portResult.stderr || portResult.stdout}`);
    this.chiselEndpoint = `http://${publicHost}:${port}`;
    this.chiselAuth = auth;
    this.chiselFingerprint = fingerprint;
  }

  private async rememberContainerAddresses(containerName: string): Promise<string | undefined> {
    const result = await this.runner(["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", containerName]);
    if (result.code !== 0) return undefined;
    return result.stdout.trim().split(/\s+/).find(Boolean);
  }

  private async resolveTargetImageId(): Promise<string> {
    this.targetImageIdPromise ??= this.runner([
      "image", "inspect", "--format", "{{.Id}}", this.image
    ]).then((result) => {
      const imageId = result.stdout.trim();
      if (result.code !== 0 || !imageId) {
        throw new Error(`Failed to resolve network image ${this.image}: ${result.stderr || result.stdout}`);
      }
      return imageId;
    }).catch((error: unknown) => {
      this.targetImageIdPromise = undefined;
      throw error;
    });
    return this.targetImageIdPromise;
  }

  private async stopContainerBestEffort(name: string): Promise<void> {
    try {
      await this.runner(["stop", "--time", "5", name]);
    } catch {
      // Removal below remains authoritative when graceful stop is unavailable.
    }
  }

  private async reconcileContainer(name: string, role: string, args: string[], identity: {
    runRef: string;
    taskRef?: string;
  }): Promise<void> {
    const configDigest = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    const inspect = await this.runner([
      "inspect", "--format",
      "{{.State.Running}}|{{index .Config.Labels \"luanniao.managed\"}}|{{index .Config.Labels \"luanniao.role\"}}|{{index .Config.Labels \"luanniao.config\"}}|{{index .Config.Labels \"luanniao.run_ref\"}}|{{index .Config.Labels \"luanniao.task_ref\"}}|{{.Image}}",
      name
    ]);
    const [running, managed, actualRole, actualDigest, rawRunRef, rawTaskRef, actualImageId] = inspect.stdout.trim().split("|");
    const actualRunRef = optionalDockerLabel(rawRunRef);
    const actualTaskRef = optionalDockerLabel(rawTaskRef);
    const labeled = actualRunRef !== undefined || actualTaskRef !== undefined;
    if (inspect.code === 0 && (managed !== "true" || actualRole !== role)) {
      throw new Error(`Refusing to replace unmanaged container ${name}`);
    }
    if (inspect.code === 0 && labeled
      && (actualRunRef !== identity.runRef || actualTaskRef !== identity.taskRef)) {
      throw new Error(`Refusing to replace container outside this runtime: ${name}`);
    }
    const targetImageId = inspect.code === 0 ? await this.resolveTargetImageId() : undefined;
    const compatible = actualDigest === configDigest && actualImageId === targetImageId;
    if (inspect.code === 0 && running === "true" && compatible) return;
    if (inspect.code === 0 && compatible) {
      const started = await this.runner(["start", name]);
      if (started.code === 0) return;
    }
    if (inspect.code === 0) {
      if (role === "gateway" && running === "true") await this.stopContainerBestEffort(name);
      await this.removeManagedContainer(name, role, identity.taskRef);
    }
    const created = await this.runner([
      "run", "-d", "--name", name,
      "--label", "luanniao.managed=true",
      "--label", `luanniao.role=${role}`,
      "--label", `luanniao.config=${configDigest}`,
      "--label", `luanniao.run_ref=${identity.runRef}`,
      "--label", `luanniao.runtime_dir=${this.runtimeDir}`,
      ...(identity.taskRef ? ["--label", `luanniao.task_ref=${identity.taskRef}`] : []),
      ...args
    ]);
    if (created.code !== 0) throw new Error(`Failed to start ${name}: ${created.stderr}`);
  }

  private async removeManagedContainer(name: string, role: string, taskRef?: string): Promise<void> {
    const inspect = await this.runner([
      "inspect", "--format",
      "{{index .Config.Labels \"luanniao.managed\"}}|{{index .Config.Labels \"luanniao.role\"}}|{{index .Config.Labels \"luanniao.run_ref\"}}|{{index .Config.Labels \"luanniao.task_ref\"}}",
      name
    ]);
    if (inspect.code !== 0) return;
    const [managed, actualRole, rawRunRef, rawTaskRef] = inspect.stdout.trim().split("|");
    const actualRunRef = optionalDockerLabel(rawRunRef);
    const actualTaskRef = optionalDockerLabel(rawTaskRef);
    if (managed !== "true" || actualRole !== role) {
      throw new Error(`Refusing to remove unmanaged container ${name}`);
    }
    if ((actualRunRef !== undefined && actualRunRef !== this.runRef)
      || (taskRef !== undefined && actualTaskRef !== undefined && actualTaskRef !== taskRef)) {
      throw new Error(`Refusing to remove container outside this runtime: ${name}`);
    }
    const removed = await this.runner(["rm", "-f", name]);
    if (removed.code !== 0) throw new Error(`Failed to remove ${name}: ${removed.stderr}`);
  }
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "unknown";
}

function optionalDockerLabel(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return !normalized || normalized === "<no value>" || normalized === "<nil>"
    ? undefined
    : normalized;
}

function emptyDrainAck(epochRef: string, gatewayPresent: boolean): GatewayEpochDrainAck {
  return {
    epochRef,
    gatewayPresent,
    activeFlowCount: 0,
    activeTcpCount: 0,
    activeNetworkCount: 0,
    persistedFlowSequence: 0,
    persistedNetworkSequence: 0,
    flowBytes: 0,
    netBytes: 0,
    flushed: true
  };
}

function persistedDrainComplete(value: unknown, expectedEpochRef: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.epochRef === expectedEpochRef
    && record.flushed === true
    && record.activeFlowCount === 0
    && record.activeTcpCount === 0
    && record.activeNetworkCount === 0
    && Number.isSafeInteger(record.persistedFlowSequence)
    && Number(record.persistedFlowSequence) >= 0
    && Number.isSafeInteger(record.persistedNetworkSequence)
    && Number(record.persistedNetworkSequence) >= 0
    && Number.isSafeInteger(record.flowBytes)
    && Number(record.flowBytes) >= 0
    && Number.isSafeInteger(record.netBytes)
    && Number(record.netBytes) >= 0;
}

function parseDrainAck(stdout: string, expectedEpochRef: string): GatewayEpochDrainAck {
  let response: unknown;
  try {
    response = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Failed to end gateway epoch: invalid control response: ${stdout.trim()}`);
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Failed to end gateway epoch: invalid control response");
  }
  const record = response as { ok?: unknown; error?: unknown; result?: unknown };
  if (record.ok !== true) {
    throw new Error(`Failed to end gateway epoch: ${typeof record.error === "string" ? record.error : stdout.trim()}`);
  }
  if (!record.result || typeof record.result !== "object" || Array.isArray(record.result)) {
    throw new Error("Failed to end gateway epoch: missing drain acknowledgement");
  }
  const result = record.result as Record<string, unknown>;
  const epochRef = typeof result.epochRef === "string" ? result.epochRef : "";
  if (epochRef !== expectedEpochRef) {
    throw new Error(`Failed to end gateway epoch: acknowledgement mismatch ${epochRef || "<missing>"}`);
  }
  const numericFields = [
    "activeFlowCount",
    "activeTcpCount",
    "activeNetworkCount",
    "persistedFlowSequence",
    "persistedNetworkSequence",
    "flowBytes",
    "netBytes"
  ] as const;
  for (const field of numericFields) {
    if (!Number.isSafeInteger(result[field]) || Number(result[field]) < 0) {
      throw new Error(`Failed to end gateway epoch: invalid ${field}`);
    }
  }
  const captureError = typeof result.captureError === "string" && result.captureError
    ? result.captureError
    : undefined;
  if (result.flushed !== true && captureError === undefined) {
    throw new Error("Failed to end gateway epoch: capture files were not flushed");
  }
  if (Number(result.activeFlowCount) !== 0
    || Number(result.activeTcpCount) !== 0
    || Number(result.activeNetworkCount) !== 0) {
    throw new Error("Failed to end gateway epoch: active network work remains");
  }
  return {
    epochRef,
    gatewayPresent: true,
    activeFlowCount: Number(result.activeFlowCount),
    activeTcpCount: Number(result.activeTcpCount),
    activeNetworkCount: Number(result.activeNetworkCount),
    persistedFlowSequence: Number(result.persistedFlowSequence),
    persistedNetworkSequence: Number(result.persistedNetworkSequence),
    flowBytes: Number(result.flowBytes),
    netBytes: Number(result.netBytes),
    flushed: result.flushed === true,
    ...(captureError !== undefined ? { captureError } : {})
  };
}

function dockerCommand(args: string[], stdin?: string): Promise<CommandResult> {
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
      finish({
        code: null,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}docker command timed out after ${DOCKER_COMMAND_TIMEOUT_MS}ms`
      });
    }, DOCKER_COMMAND_TIMEOUT_MS);
    timeout.unref();
    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish({ code: 1, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin!.end(stdin);
  });
}
