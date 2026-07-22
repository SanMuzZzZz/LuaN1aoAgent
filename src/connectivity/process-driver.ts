import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export type ProcessOutputStream = "stdout" | "stderr";

export interface ManagedProcess {
  readonly pid: number;
  isRunning(): boolean;
  onOutput(listener: (stream: ProcessOutputStream, chunk: string) => void): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
  terminateGroup(signal?: NodeJS.Signals): void;
}

export interface ProcessDriver {
  spawn(command: string, argv: readonly string[], options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
  }): ManagedProcess;
}

export class NodeProcessDriver implements ProcessDriver {
  spawn(command: string, argv: readonly string[], options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
  } = {}): ManagedProcess {
    const child = spawn(command, [...argv], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let running = true;
    child.once("exit", () => { running = false; });
    child.once("error", () => { running = false; });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
    return {
      get pid(): number {
        if (child.pid === undefined) throw new Error("Managed process did not receive a pid");
        return child.pid;
      },
      isRunning: () => running && child.exitCode === null && child.signalCode === null,
      onOutput(listener) {
        attachOutput(child.stdout, "stdout", listener);
        attachOutput(child.stderr, "stderr", listener);
      },
      onExit(listener) {
        child.once("exit", listener);
      },
      onError(listener) {
        child.once("error", listener);
      },
      terminateGroup(signal = "SIGTERM") {
        if (!child.pid || !running) return;
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    };
  }
}

function attachOutput(
  stream: Readable | null,
  kind: ProcessOutputStream,
  listener: (stream: ProcessOutputStream, chunk: string) => void
): void {
  stream?.on("data", (chunk: Buffer | string) => listener(kind, chunk.toString()));
}

export class BoundedRedactedOutput {
  private value = "";
  private readonly rawLimit: number;

  constructor(
    private readonly limit = 16_384,
    private readonly secrets: readonly string[] = []
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("output limit must be a positive integer");
    this.rawLimit = limit + Math.max(256, ...secrets.map((secret) => secret.length));
  }

  append(chunk: string): void {
    this.value = (this.value + chunk).slice(-this.rawLimit);
  }

  read(): string {
    let sanitized = this.value;
    for (const secret of this.secrets) {
      if (secret) sanitized = sanitized.split(secret).join("[REDACTED]");
    }
    sanitized = sanitized
      .replace(/(authorization\s*:\s*)([^\r\n]+)/gi, "$1[REDACTED]")
      .replace(/((?:token|password|passphrase|secret)\s*[=:]\s*)([^\s]+)/gi, "$1[REDACTED]");
    return sanitized.slice(-this.limit);
  }
}
