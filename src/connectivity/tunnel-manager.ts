import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperationalTopology } from "../operational-topology.js";
import {
  ConnectivityStore,
  stableConnectivityId,
  type ConnectivityDefinition
} from "../stores/connectivity-store.js";
import type { JsonObject, OperationalStatus } from "../types.js";
import {
  BoundedRedactedOutput,
  NodeProcessDriver,
  type ManagedProcess,
  type ProcessDriver
} from "./process-driver.js";

export type SshForward =
  | { mode: "local"; bindHost?: string; bindPort: number; targetHost: string; targetPort: number }
  | { mode: "remote"; bindHost?: string; bindPort: number; targetHost: string; targetPort: number }
  | { mode: "dynamic"; bindHost?: string; bindPort: number };

export type SshTunnelDefinition = {
  externalId: string;
  fromHostRef: string;
  toHostRef: string;
  host: string;
  port?: number;
  user?: string;
  forwards: SshForward[];
  credentialRef?: string;
  controlMaster?: boolean;
  desiredState?: "running" | "stopped";
};

export type CredentialResolver = (credentialRef: string) => Promise<string> | string;
export type TunnelProbe = (definition: ConnectivityDefinition) => Promise<boolean>;

export class TunnelManager {
  private readonly driver: ProcessDriver;
  private readonly sshBinary: string;
  private readonly clock: () => Date;
  private readonly outputLimit: number;
  private readonly baseBackoffMs: number;
  private readonly active = new Map<string, { process: ManagedProcess; output: BoundedRedactedOutput }>();
  private readonly lifecycles = new Map<string, Promise<unknown>>();
  private readonly failures = new Map<string, number>();
  private readonly retryAfter = new Map<string, number>();
  readonly knownHostsPath: string;

  constructor(
    readonly store: ConnectivityStore,
    private readonly topology: Pick<OperationalTopology, "upsertTunnel">,
    private readonly runtimeDir: string,
    private readonly options: {
      processDriver?: ProcessDriver;
      credentialResolver?: CredentialResolver;
      processProbe?: TunnelProbe;
      sshProbe?: TunnelProbe;
      sshBinary?: string;
      clock?: () => Date;
      outputLimit?: number;
      baseBackoffMs?: number;
    } = {}
  ) {
    this.driver = options.processDriver ?? new NodeProcessDriver();
    this.sshBinary = options.sshBinary ?? "ssh";
    this.clock = options.clock ?? (() => new Date());
    this.outputLimit = options.outputLimit ?? 16_384;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.knownHostsPath = join(runtimeDir, "connectivity", "known_hosts");
    mkdirSync(join(runtimeDir, "connectivity", "control"), { recursive: true, mode: 0o700 });
    writeFileSync(this.knownHostsPath, "", { flag: "a", mode: 0o600 });
  }

  define(input: SshTunnelDefinition): ConnectivityDefinition {
    validateTunnel(input);
    const externalId = input.externalId.trim();
    const controlRef = input.controlMaster
      ? `ssh-control:${stableConnectivityId("tunnel", externalId)}`
      : undefined;
    const definition = this.store.upsertDefinition({
      kind: "tunnel",
      externalId,
      desiredState: input.desiredState ?? "running",
      status: "stale",
      fromHostRef: input.fromHostRef,
      toHostRef: input.toHostRef,
      credentialRef: input.credentialRef,
      processRef: `process:${stableConnectivityId("tunnel", externalId)}`,
      controlRef,
      definition: serializeTunnel(input)
    });
    this.publish(definition);
    return definition;
  }

  async start(ref: string): Promise<ConnectivityDefinition> {
    const id = this.requireTunnel(ref).id;
    return this.withLifecycle(id, async () => {
      let definition = this.requireTunnel(id);
      if (definition.desiredState !== "running" || definition.status === "closed") return definition;
      const retryAt = this.retryAfter.get(definition.id) ?? 0;
      if (this.clock().getTime() < retryAt) return definition;
      const active = this.active.get(definition.id);
      if (active?.process.isRunning()) return this.verify(definition, active.process);

      const identity = definition.credentialRef
        ? await this.resolveCredential(definition.credentialRef)
        : undefined;
      const argv = buildSshTunnelArgv(definition, this.knownHostsPath, identity, this.controlPath(definition));
      const output = new BoundedRedactedOutput(this.outputLimit, identity ? [identity] : []);
      try {
        const child = this.driver.spawn(this.sshBinary, argv);
        child.onOutput((_stream, chunk) => output.append(chunk));
        child.onExit((code, signal) => { void this.handleExit(definition.id, child, code, signal); });
        child.onError((error) => { void this.handleProcessError(definition.id, child, error); });
        this.active.set(definition.id, { process: child, output });
        definition = await this.verify(definition, child);
        return definition;
      } catch (error) {
        return this.fail(definition, error);
      }
    });
  }

  async heartbeat(ref: string): Promise<ConnectivityDefinition> {
    const id = this.requireTunnel(ref).id;
    return this.withLifecycle(id, async () => {
      const definition = this.requireTunnel(id);
      if (definition.desiredState !== "running" || definition.status === "closed") return definition;
      const child = this.active.get(definition.id)?.process;
      return this.verify(definition, child);
    });
  }

  async stop(ref: string, close = false): Promise<ConnectivityDefinition> {
    const id = this.requireTunnel(ref).id;
    return this.withLifecycle(id, async () => {
      let definition = this.requireTunnel(id);
      this.active.get(id)?.process.terminateGroup();
      this.active.delete(id);
      definition = this.store.updateDesiredState(id, close ? "closed" : "stopped");
      this.failures.delete(id);
      this.retryAfter.delete(id);
      this.publish(definition);
      return definition;
    });
  }

  async recover(): Promise<ConnectivityDefinition[]> {
    this.store.markObservedStatusesStale("tunnel");
    const recovered: ConnectivityDefinition[] = [];
    for (const definition of this.store.listDefinitions("tunnel")) {
      this.publish(definition);
      if (definition.desiredState !== "running" || definition.status === "closed") {
        recovered.push(definition);
        continue;
      }
      const processLive = await (this.options.processProbe?.(definition) ?? Promise.resolve(false));
      const sshLive = processLive && await (this.options.sshProbe?.(definition) ?? Promise.resolve(false));
      if (processLive && sshLive) {
        const live = this.store.updateStatus(definition.id, "live", true);
        this.publish(live);
        recovered.push(live);
      } else {
        recovered.push(await this.fail(definition, new Error(processLive
          ? "SSH recovery probe failed"
          : "Process/control recovery probe failed"), "stale"));
      }
    }
    return recovered;
  }

  output(ref: string): string {
    return this.active.get(this.resolveId(ref))?.output.read() ?? "";
  }

  nextRetryAt(ref: string): Date | undefined {
    const value = this.retryAfter.get(this.resolveId(ref));
    return value === undefined ? undefined : new Date(value);
  }

  private async verify(definition: ConnectivityDefinition, child?: ManagedProcess): Promise<ConnectivityDefinition> {
    const processLive = child?.isRunning() ?? await (this.options.processProbe?.(definition) ?? Promise.resolve(false));
    const sshLive = processLive && await (this.options.sshProbe?.(definition) ?? Promise.resolve(false));
    if (!processLive || !sshLive) {
      return this.fail(definition, new Error(processLive ? "SSH probe failed" : "Tunnel process exited"), "degraded");
    }
    this.failures.delete(definition.id);
    this.retryAfter.delete(definition.id);
    const live = this.store.updateStatus(definition.id, "live", true);
    this.publish(live);
    return live;
  }

  private async handleExit(
    id: string,
    child: ManagedProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    await this.withLifecycle(id, async () => {
      if (this.active.get(id)?.process !== child) return;
      this.active.delete(id);
      const definition = this.store.getDefinition(id);
      if (!definition || definition.desiredState !== "running" || definition.status === "closed") return;
      await this.fail(definition, new Error(`Tunnel process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    });
  }

  private async handleProcessError(id: string, child: ManagedProcess, error: Error): Promise<void> {
    await this.withLifecycle(id, async () => {
      if (this.active.get(id)?.process !== child) return;
      this.active.delete(id);
      const definition = this.store.getDefinition(id);
      if (!definition || definition.desiredState !== "running" || definition.status === "closed") return;
      await this.fail(definition, error);
    });
  }

  private async withLifecycle<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.lifecycles.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.lifecycles.set(id, current);
    try {
      return await current;
    } finally {
      if (this.lifecycles.get(id) === current) this.lifecycles.delete(id);
    }
  }

  private async fail(
    definition: ConnectivityDefinition,
    error: unknown,
    status: Extract<OperationalStatus, "degraded" | "stale"> = "degraded"
  ): Promise<ConnectivityDefinition> {
    const attempt = (this.failures.get(definition.id) ?? 0) + 1;
    this.failures.set(definition.id, attempt);
    this.retryAfter.set(definition.id, this.clock().getTime() + this.baseBackoffMs * 2 ** Math.min(attempt - 1, 8));
    const reason = error instanceof Error ? error.message : String(error);
    const updated = this.store.upsertDefinition({
      ...definition,
      status,
      definition: { ...definition.definition, lastFailureReason: reason }
    });
    this.publish(updated);
    return updated;
  }

  private publish(definition: ConnectivityDefinition): void {
    if (!definition.fromHostRef || !definition.toHostRef) throw new Error(`Tunnel ${definition.id} requires host refs`);
    this.topology.upsertTunnel({
      tunnelId: definition.externalId,
      fromHostRef: definition.fromHostRef,
      toHostRef: definition.toHostRef,
      status: definition.status,
      properties: {
        connectivityId: definition.id,
        desiredState: definition.desiredState,
        processRef: definition.processRef,
        controlRef: definition.controlRef,
        lastHeartbeat: definition.lastHeartbeat,
        ...definition.definition
      }
    });
  }

  private requireTunnel(ref: string): ConnectivityDefinition {
    const definition = this.store.getDefinition(this.resolveId(ref));
    if (!definition || definition.kind !== "tunnel") throw new Error(`Tunnel not found: ${ref}`);
    return definition;
  }

  private resolveId(ref: string): string {
    return ref.startsWith("connectivity-tunnel:") ? ref : stableConnectivityId("tunnel", ref);
  }

  private async resolveCredential(ref: string): Promise<string> {
    if (!this.options.credentialResolver) throw new Error(`No credential resolver for ${ref}`);
    const value = await this.options.credentialResolver(ref);
    if (!value.trim()) throw new Error(`Credential resolver returned an empty value for ${ref}`);
    assertArg(value, "resolved identity path", true);
    return value;
  }

  private controlPath(definition: ConnectivityDefinition): string | undefined {
    return definition.controlRef
      ? join(this.runtimeDir, "connectivity", "control", encodeURIComponent(definition.externalId))
      : undefined;
  }
}

export function buildSshTunnelArgv(
  definition: ConnectivityDefinition,
  knownHostsPath: string,
  identityPath?: string,
  controlPath?: string
): string[] {
  const raw = definition.definition;
  const host = stringProperty(raw, "host");
  const port = numberProperty(raw, "port", 22);
  const user = optionalStringProperty(raw, "user");
  const forwards = raw.forwards;
  if (!Array.isArray(forwards) || forwards.length === 0) throw new Error("Tunnel forwards must not be empty");
  const argv = [
    "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsPath}`,
    "-p", String(port)
  ];
  if (identityPath) argv.push("-i", identityPath);
  if (controlPath) argv.push("-o", "ControlMaster=auto", "-o", "ControlPersist=60", "-o", `ControlPath=${controlPath}`);
  for (const candidate of forwards) argv.push(...forwardArgs(candidate));
  argv.push(user ? `${user}@${host}` : host);
  argv.forEach((arg) => assertArg(arg, "SSH argument", true));
  return argv;
}

function validateTunnel(input: SshTunnelDefinition): void {
  assertIdentifier(input.externalId, "externalId");
  assertIdentifier(input.fromHostRef, "fromHostRef");
  assertIdentifier(input.toHostRef, "toHostRef");
  assertHost(input.host, "host");
  if (input.user !== undefined) assertIdentifier(input.user, "user");
  validPort(input.port ?? 22, "port");
  if (!Array.isArray(input.forwards) || input.forwards.length === 0) throw new Error("forwards must not be empty");
  input.forwards.forEach((forward) => forwardArgs(forward));
  if (input.credentialRef !== undefined) assertIdentifier(input.credentialRef, "credentialRef");
}

function serializeTunnel(input: SshTunnelDefinition): JsonObject {
  return {
    adapter: "ssh",
    host: input.host,
    port: input.port ?? 22,
    ...(input.user ? { user: input.user } : {}),
    controlMaster: input.controlMaster ?? false,
    forwards: input.forwards as unknown as JsonObject[]
  };
}

function forwardArgs(value: unknown): string[] {
  if (!value || typeof value !== "object") throw new Error("Invalid forward definition");
  const forward = value as Record<string, unknown>;
  const mode = forward.mode;
  const bindPort = validPort(forward.bindPort, "bindPort");
  const bindHost = forward.bindHost === undefined ? undefined : assertHost(String(forward.bindHost), "bindHost");
  const bind = `${bindHost ? `${bindHost}:` : ""}${bindPort}`;
  if (mode === "dynamic") return ["-D", bind];
  if (mode !== "local" && mode !== "remote") throw new Error("forward mode must be local, remote, or dynamic");
  const targetHost = assertHost(String(forward.targetHost ?? ""), "targetHost");
  const targetPort = validPort(forward.targetPort, "targetPort");
  return [mode === "local" ? "-L" : "-R", `${bind}:${targetHost}:${targetPort}`];
}

function assertIdentifier(value: string, name: string): string {
  const result = value.trim();
  if (!result || result.startsWith("-") || /[\0\r\n]/.test(result)) throw new Error(`Invalid ${name}`);
  return result;
}

function assertHost(value: string, name: string): string {
  const result = assertIdentifier(value, name);
  if (/\s/.test(result) || /[\[\]]/.test(result)) throw new Error(`Invalid ${name}`);
  return result;
}

function assertArg(value: string, name: string, allowLeadingDash = false): string {
  if (!value || /[\0\r\n]/.test(value) || (!allowLeadingDash && value.startsWith("-"))) throw new Error(`Invalid ${name}`);
  return value;
}

function validPort(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return Number(value);
}

function stringProperty(value: JsonObject, key: string): string {
  const property = value[key];
  if (typeof property !== "string") throw new Error(`Tunnel definition requires ${key}`);
  return assertHost(property, key);
}

function optionalStringProperty(value: JsonObject, key: string): string | undefined {
  const property = value[key];
  if (property === undefined) return undefined;
  if (typeof property !== "string") throw new Error(`Tunnel definition ${key} must be a string`);
  return assertIdentifier(property, key);
}

function numberProperty(value: JsonObject, key: string, fallback: number): number {
  return validPort(value[key] ?? fallback, key);
}
