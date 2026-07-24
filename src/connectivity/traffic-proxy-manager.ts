import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TrafficProxyClient,
  TRAFFIC_PROXY_MESSAGE_LIMIT,
  type ManagedHttpTrafficScope
} from "./traffic-proxy-client.js";
import { ensureTrafficProxySocketDir, trafficProxyRuntimeIdentity } from "./traffic-proxy-runtime.js";

export type TrafficProxyLifecycleEvent = {
  eventType: "traffic_proxy_sidecar_lifecycle" | "traffic_proxy_ca_created" | "traffic_proxy_ready";
  summary: string;
  payload: Record<string, string | boolean | number>;
};

export type TrafficProxyManagerOptions = {
  binary?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  logEvent?: (event: TrafficProxyLifecycleEvent) => void | Promise<void>;
  onUnavailable?: () => void;
};

export class TrafficProxyManager {
  readonly runtimeDir: string;
  readonly proxyDir: string;
  readonly dataDir: string;
  readonly controlSocket: string;
  readonly binary: string;
  readonly client: TrafficProxyClient;
  readonly requestedRuntimeRef: string;
  private readonly socketDir: string;
  runtimeRef?: string;
  proxyAddress?: string;
  private child?: ChildProcess;
  private owned = false;
  private startPromise?: Promise<TrafficProxyClient>;
  private closePromise?: Promise<void>;

  constructor(runtimeDir: string, options: TrafficProxyManagerOptions = {}) {
    const identity = trafficProxyRuntimeIdentity(runtimeDir);
    this.runtimeDir = identity.runtimeDir;
    this.requestedRuntimeRef = identity.runtimeRef;
    this.socketDir = identity.socketDir;
    this.proxyDir = join(this.runtimeDir, "traffic-proxy");
    this.dataDir = join(this.proxyDir, "data");
    this.controlSocket = identity.controlSocket;
    this.binary = options.binary ?? process.env.TRAFFIC_PROXY_BINARY ?? resolve("traffic-proxy/bin/traffic-proxy");
    this.client = new TrafficProxyClient(this.controlSocket, { timeoutMs: options.requestTimeoutMs });
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.logEvent = options.logEvent;
    this.onUnavailable = options.onUnavailable;
  }

  private readonly startupTimeoutMs: number;
  private readonly logEvent?: TrafficProxyManagerOptions["logEvent"];
  private readonly onUnavailable?: TrafficProxyManagerOptions["onUnavailable"];

  get proxyUrl(): string | undefined {
    return this.proxyAddress ? `http://${this.proxyAddress}` : undefined;
  }

  get caCertPath(): string {
    return join(this.dataDir, "ca", this.runtimeRef ?? this.requestedRuntimeRef, "ca.crt");
  }

  managedEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const proxyUrl = this.proxyUrl;
    if (!proxyUrl) throw new Error("traffic-proxy is not ready");
    const environment: NodeJS.ProcessEnv = {
      ...base,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      SSL_CERT_FILE: this.caCertPath,
      CURL_CA_BUNDLE: this.caCertPath,
      NODE_EXTRA_CA_CERTS: this.caCertPath
    };
    delete environment.ALL_PROXY;
    delete environment.all_proxy;
    delete environment.NO_PROXY;
    delete environment.no_proxy;
    return environment;
  }

  start(): Promise<TrafficProxyClient> {
    if (!this.startPromise) this.startPromise = this.startInternal();
    return this.startPromise;
  }

  async attachExisting(): Promise<TrafficProxyClient> {
    await ensureTrafficProxySocketDir(this.socketDir);
    const hello = await this.client.hello();
    this.acceptHello(hello);
    return this.client;
  }

  async configureManagedHttpScope(scope: ManagedHttpTrafficScope): Promise<void> {
    await this.start();
    await this.client.configureManagedHttpScope(scope);
  }

  async withManagedHttpScope<T>(scope: ManagedHttpTrafficScope, operation: () => Promise<T>): Promise<T> {
    await this.start();
    return this.client.withManagedHttpScope(scope, operation);
  }

  ownsProcess(): boolean {
    return this.owned;
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async startInternal(): Promise<TrafficProxyClient> {
    await mkdir(this.proxyDir, { recursive: true, mode: 0o700 });
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await ensureTrafficProxySocketDir(this.socketDir);
    let existingHello: Awaited<ReturnType<TrafficProxyClient["hello"]>> | undefined;
    try {
      existingHello = await this.client.hello();
    } catch {
      // No healthy sidecar is listening at the managed socket.
    }
    if (existingHello) {
      this.acceptHello(existingHello);
      await this.record("traffic_proxy_sidecar_lifecycle", "Attached to existing traffic proxy sidecar", { state: "attached", owned: false });
      return this.client;
    }

    const caAlreadyExisted = await pathExists(this.caCertPath);
    const child = spawn(this.binary, [
      "-listen", "127.0.0.1:0",
      "-data-dir", this.dataDir,
      "-control-socket", this.controlSocket,
      "-runtime-ref", this.requestedRuntimeRef
    ], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.owned = true;
    await this.record("traffic_proxy_sidecar_lifecycle", "Traffic proxy sidecar started", { state: "started", owned: true });
    try {
      const ready = await readReadyLine(child, this.startupTimeoutMs);
      if (resolve(ready.control) !== this.controlSocket || resolve(ready.data) !== this.dataDir) {
        throw new Error("traffic-proxy ready paths do not match the managed runtime");
      }
      if (ready.runtimeRef !== this.requestedRuntimeRef) throw new Error("traffic-proxy ready runtime identity mismatch");
      const hello = await this.client.hello();
      this.acceptHello(hello);
      if (hello.proxy !== ready.proxy) throw new Error("traffic-proxy address mismatch");
      child.once("exit", () => {
        if (!this.owned || this.child !== child) return;
        this.owned = false;
        this.child = undefined;
        this.proxyAddress = undefined;
        try {
          this.onUnavailable?.();
        } catch {
          // Availability notification failures must not escape the child exit handler.
        }
      });
      if (!caAlreadyExisted && await pathExists(this.caCertPath)) {
        await this.record("traffic_proxy_ca_created", "Traffic proxy public CA certificate created", { created: true });
      }
      await this.record("traffic_proxy_ready", "Traffic proxy is ready", { ready: true });
      return this.client;
    } catch (error) {
      child.kill("SIGTERM");
      await waitForExit(child, 5_000);
      this.owned = false;
      this.child = undefined;
      this.proxyAddress = undefined;
      await this.record("traffic_proxy_sidecar_lifecycle", "Traffic proxy sidecar startup failed", { state: "failed", owned: false });
      throw error;
    }
  }

  private async closeInternal(): Promise<void> {
    const child = this.child;
    if (!this.owned || !child) return;
    this.owned = false;
    try {
      await this.client.shutdown();
    } catch {
      child.kill("SIGTERM");
    }
    await waitForExit(child, 5_000);
    this.child = undefined;
    await this.record("traffic_proxy_sidecar_lifecycle", "Traffic proxy sidecar stopped", { state: "stopped", owned: false });
  }

  private acceptHello(hello: Awaited<ReturnType<TrafficProxyClient["hello"]>>): void {
    if (hello.runtime_ref !== this.requestedRuntimeRef) {
      throw new Error(`traffic-proxy runtime identity mismatch: expected ${this.requestedRuntimeRef}, received ${hello.runtime_ref}`);
    }
    if (!hello.proxy) throw new Error("traffic-proxy hello response has no proxy address");
    this.runtimeRef = hello.runtime_ref;
    this.proxyAddress = hello.proxy;
  }

  private async record(eventType: TrafficProxyLifecycleEvent["eventType"], summary: string, payload: TrafficProxyLifecycleEvent["payload"]): Promise<void> {
    try {
      await this.logEvent?.({ eventType, summary, payload });
    } catch {
      // Lifecycle logging must not prevent proxy startup or shutdown.
    }
  }
}

async function readReadyLine(child: ChildProcess, timeoutMs: number): Promise<{ proxy: string; control: string; data: string; runtimeRef: string }> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("traffic-proxy stdout is unavailable");
  return new Promise((resolveReady, rejectReady) => {
    let input = "";
    let stderr = "";
    const timer = setTimeout(() => done(new Error(`traffic-proxy startup timed out after ${timeoutMs}ms`)), timeoutMs);
    const done = (error?: Error, value?: { proxy: string; control: string; data: string; runtimeRef: string }) => {
      clearTimeout(timer);
      stdout.off("data", onData);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) rejectReady(error);
      else resolveReady(value!);
    };
    const onError = (error: Error) => done(error);
    const onStderr = (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < TRAFFIC_PROXY_MESSAGE_LIMIT) stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => done(new Error(`traffic-proxy exited before ready (${code ?? signal}): ${stderr.trim()}`));
    const onData = (chunk: Buffer) => {
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > TRAFFIC_PROXY_MESSAGE_LIMIT) return done(new Error("traffic-proxy ready line exceeds 64KiB"));
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const match = /^proxy=(\S+) control=(\S+) data=(\S+) runtime_ref=(\S+)(?: connect=\S*)?$/.exec(input.slice(0, newline).trim());
      if (!match) return done(new Error("invalid traffic-proxy ready line"));
      done(undefined, { proxy: match[1]!, control: match[2]!, data: match[3]!, runtimeRef: match[4]! });
    };
    stdout.on("data", onData);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", done);
      child.off("close", done);
      child.off("error", onError);
      resolveExit();
    };
    const onError = () => {
      if (child.pid === undefined) done();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", done);
    child.once("close", done);
    child.once("error", onError);
  });
}
