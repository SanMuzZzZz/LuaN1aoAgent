import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperationalTopology } from "../operational-topology.js";
import {
  ConnectivityStore,
  stableConnectivityId,
  type ConnectivityDefinition,
  type ConnectivityLease
} from "../stores/connectivity-store.js";
import type { JsonObject } from "../types.js";
import {
  BoundedRedactedOutput,
  NodeProcessDriver,
  type ProcessDriver
} from "./process-driver.js";
import type { CredentialResolver } from "./tunnel-manager.js";

export type SshSessionDefinition = {
  externalId: string;
  sessionType?: "agent" | "shell";
  hostRef: string;
  host: string;
  port?: number;
  user?: string;
  credentialRef?: string;
  concurrencySafe?: boolean;
};

export type ObservedAgentSession = {
  externalId: string;
  hostRef: string;
  properties?: JsonObject;
};

export type UnmanagedSessionObservation = ObservedAgentSession & {
  sessionType?: "agent" | "shell";
  adapter: "raw-shell" | "venom" | "stowaway";
};

export type SessionCommand = {
  argv: string[];
  stdin?: string;
  timeoutMs: number;
};

export type SessionCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export class SessionBroker {
  private readonly driver: ProcessDriver;
  private readonly sshBinary: string;
  private readonly outputLimit: number;
  readonly knownHostsPath: string;

  constructor(
    readonly store: ConnectivityStore,
    private readonly topology: Pick<OperationalTopology, "upsertAgentSession" | "upsertShellSession">,
    runtimeDir: string,
    private readonly options: {
      processDriver?: ProcessDriver;
      credentialResolver?: CredentialResolver;
      sshBinary?: string;
      outputLimit?: number;
    } = {}
  ) {
    this.driver = options.processDriver ?? new NodeProcessDriver();
    this.sshBinary = options.sshBinary ?? "ssh";
    this.outputLimit = options.outputLimit ?? 16_384;
    this.knownHostsPath = join(runtimeDir, "connectivity", "known_hosts");
    mkdirSync(join(runtimeDir, "connectivity"), { recursive: true, mode: 0o700 });
    writeFileSync(this.knownHostsPath, "", { flag: "a", mode: 0o600 });
  }

  defineSsh(input: SshSessionDefinition): ConnectivityDefinition {
    validateSshDefinition(input);
    const definition = this.store.upsertDefinition({
      kind: "session",
      externalId: input.externalId.trim(),
      status: "stale",
      desiredState: "running",
      sessionType: input.sessionType ?? "shell",
      hostRef: input.hostRef,
      concurrencySafe: input.concurrencySafe ?? false,
      credentialRef: input.credentialRef,
      definition: {
        transport: "ssh",
        host: input.host,
        port: input.port ?? 22,
        ...(input.user ? { user: input.user } : {})
      }
    });
    this.publish(definition);
    return definition;
  }

  observeAgent(input: ObservedAgentSession): ConnectivityDefinition {
    return this.observeUnmanaged({ ...input, sessionType: "agent", adapter: "raw-shell" });
  }

  observeUnmanaged(input: UnmanagedSessionObservation): ConnectivityDefinition {
    safeIdentifier(input.externalId, "externalId");
    safeIdentifier(input.hostRef, "hostRef");
    const definition = this.store.upsertDefinition({
      kind: "session",
      externalId: input.externalId.trim(),
      status: "stale",
      desiredState: "running",
      sessionType: input.sessionType ?? "shell",
      hostRef: input.hostRef,
      concurrencySafe: false,
      definition: { ...unmanagedProperties(input.properties), observed: true, unmanaged: true, adapter: input.adapter }
    });
    this.publish(definition);
    return definition;
  }

  claim(sessionRef: string, ownerId: string, ttlMs: number): ConnectivityLease | undefined {
    return this.store.claimSessionLease(this.resolveId(sessionRef), ownerId, ttlMs);
  }

  heartbeat(lease: Pick<ConnectivityLease, "id" | "token">, ttlMs: number): ConnectivityLease | undefined {
    return this.store.heartbeatLease(lease.id, lease.token, ttlMs);
  }

  release(lease: Pick<ConnectivityLease, "id" | "token">): boolean {
    return this.store.releaseLease(lease.id, lease.token);
  }

  async run(input: {
    sessionRef: string;
    ownerId: string;
    leaseTtlMs: number;
    command: SessionCommand;
  }): Promise<SessionCommandResult> {
    validateCommand(input.command);
    const definition = this.requireSession(input.sessionRef);
    if (definition.definition.transport !== "ssh") {
      throw new Error(`Session ${definition.id} has no managed transport`);
    }
    const lease = this.claim(definition.id, input.ownerId, input.leaseTtlMs);
    if (!lease) throw new Error(`Session is already leased: ${definition.id}`);
    let heartbeatTimer: NodeJS.Timeout | undefined;
    try {
      const identity = definition.credentialRef
        ? await this.resolveCredential(definition.credentialRef)
        : undefined;
      const argv = buildSessionSshArgv(definition, this.knownHostsPath, input.command.argv, identity);
      const child = this.driver.spawn(this.sshBinary, argv, { stdin: input.command.stdin });
      const stdout = new BoundedRedactedOutput(this.outputLimit, identity ? [identity] : []);
      const stderr = new BoundedRedactedOutput(this.outputLimit, identity ? [identity] : []);
      child.onOutput((stream, chunk) => (stream === "stdout" ? stdout : stderr).append(chunk));
      heartbeatTimer = setInterval(() => {
        this.heartbeat(lease, input.leaseTtlMs);
      }, Math.max(50, Math.floor(input.leaseTtlMs / 2)));
      heartbeatTimer.unref();
      return await new Promise<SessionCommandResult>((resolve, reject) => {
        let settled = false;
        let timedOut = false;
        const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve({ code, signal, stdout: stdout.read(), stderr: stderr.read(), timedOut });
        };
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        };
        const timeout = setTimeout(() => {
          timedOut = true;
          child.terminateGroup();
        }, input.command.timeoutMs);
        timeout.unref();
        child.onExit(finish);
        child.onError(fail);
      });
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      this.release(lease);
    }
  }

  private requireSession(ref: string): ConnectivityDefinition {
    const definition = this.store.getDefinition(this.resolveId(ref));
    if (!definition || definition.kind !== "session") throw new Error(`Session not found: ${ref}`);
    if (definition.desiredState !== "running" || definition.status === "closed") {
      throw new Error(`Session is not runnable: ${definition.id}`);
    }
    return definition;
  }

  private resolveId(ref: string): string {
    return ref.startsWith("connectivity-session:") ? ref : stableConnectivityId("session", ref);
  }

  private async resolveCredential(ref: string): Promise<string> {
    if (!this.options.credentialResolver) throw new Error(`No credential resolver for ${ref}`);
    const value = await this.options.credentialResolver(ref);
    if (!value || /[\0\r\n]/.test(value)) throw new Error(`Invalid resolved credential for ${ref}`);
    return value;
  }

  private publish(definition: ConnectivityDefinition): void {
    if (!definition.hostRef) throw new Error(`Session ${definition.id} requires hostRef`);
    const input = {
      sessionId: definition.externalId,
      hostRef: definition.hostRef,
      status: definition.status,
      properties: {
        connectivityId: definition.id,
        desiredState: definition.desiredState,
        ...definition.definition
      }
    };
    if (definition.sessionType === "shell") this.topology.upsertShellSession(input);
    else this.topology.upsertAgentSession(input);
  }
}

export function buildSessionSshArgv(
  definition: ConnectivityDefinition,
  knownHostsPath: string,
  commandArgv: readonly string[],
  identityPath?: string
): string[] {
  const host = propertyString(definition.definition, "host");
  const port = validPort(definition.definition.port ?? 22, "port");
  const user = definition.definition.user === undefined
    ? undefined
    : propertyString(definition.definition, "user");
  commandArgv.forEach((value, index) => safeCommandArg(value, index));
  const argv = [
    "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHostsPath}`, "-p", String(port)
  ];
  if (identityPath) argv.push("-i", identityPath);
  argv.push(user ? `${user}@${host}` : host, "--", commandArgv.map(shellQuote).join(" "));
  return argv;
}

function validateSshDefinition(input: SshSessionDefinition): void {
  safeIdentifier(input.externalId, "externalId");
  safeIdentifier(input.hostRef, "hostRef");
  safeHost(input.host, "host");
  if (input.user !== undefined) safeIdentifier(input.user, "user");
  validPort(input.port ?? 22, "port");
  if (input.credentialRef !== undefined) safeIdentifier(input.credentialRef, "credentialRef");
}

function validateCommand(command: SessionCommand): void {
  if (!Array.isArray(command.argv) || command.argv.length === 0) throw new Error("command argv must not be empty");
  command.argv.forEach((value, index) => safeCommandArg(value, index));
  if (!Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0) throw new Error("command timeoutMs must be positive");
  if (command.stdin !== undefined && Buffer.byteLength(command.stdin) > 1024 * 1024) throw new Error("command stdin exceeds 1 MiB");
}

function safeCommandArg(value: string, index: number): string {
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value)) throw new Error(`Invalid command argv[${index}]`);
  if (index === 0 && (value.startsWith("-") || /\s/.test(value))) throw new Error("Invalid command executable");
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function safeIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.startsWith("-") || /[\0\r\n]/.test(normalized)) throw new Error(`Invalid ${name}`);
  return normalized;
}

function safeHost(value: string, name: string): string {
  const normalized = safeIdentifier(value, name);
  if (/\s/.test(normalized)) throw new Error(`Invalid ${name}`);
  return normalized;
}

function validPort(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return Number(value);
}

function unmanagedProperties(properties: JsonObject | undefined): JsonObject {
  if (!properties) return {};
  const { transport: _transport, ...observed } = properties;
  return observed;
}

function propertyString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new Error(`Session definition requires ${key}`);
  return key === "host" ? safeHost(value, key) : safeIdentifier(value, key);
}
