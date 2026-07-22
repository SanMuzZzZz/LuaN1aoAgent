import { constants, accessSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { CredentialResolver } from "./tunnel-manager.js";
import { NodeProcessDriver, type ManagedProcess, type ProcessDriver } from "./process-driver.js";

export type ChiselMode = "client" | "server";

export type ChiselClientDefinition = {
  mode: "client";
  server: string;
  routes: string[];
  tokenCredentialRef?: string;
};

export type ChiselServerDefinition = {
  mode: "server";
  port: number;
  reverse?: boolean;
  tokenCredentialRef?: string;
};

export type ChiselDefinition = ChiselClientDefinition | ChiselServerDefinition;

export class ChiselAdapter {
  private readonly driver: ProcessDriver;
  private binary?: string;

  constructor(private readonly options: {
    binaryPath?: string;
    allowedBinaries: string[];
    allowedRoots: string[];
    processDriver?: ProcessDriver;
    credentialResolver?: CredentialResolver;
  }) {
    this.driver = options.processDriver ?? new NodeProcessDriver();
  }

  availability(): { available: boolean; reason?: string; binary?: string } {
    try {
      return { available: true, binary: this.resolveBinary() };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  buildArgv(definition: ChiselDefinition): string[] {
    validateDefinition(definition);
    if (definition.mode === "server") {
      return ["server", "--port", String(definition.port), ...(definition.reverse ? ["--reverse"] : [])];
    }
    return ["client", definition.server, ...definition.routes];
  }

  async start(definition: ChiselDefinition): Promise<ManagedProcess> {
    const binary = this.resolveBinary();
    const argv = this.buildArgv(definition);
    let token: string | undefined;
    if (definition.tokenCredentialRef) {
      if (!this.options.credentialResolver) throw new Error("Chisel token credential resolver is unavailable");
      token = await this.options.credentialResolver(definition.tokenCredentialRef);
      if (!token) throw new Error("Chisel token credential is empty");
    }
    return this.driver.spawn(binary, argv, {
      env: token ? { ...process.env, AUTH: token } : process.env
    });
  }

  private resolveBinary(): string {
    if (this.binary) return this.binary;
    const candidate = this.options.binaryPath;
    if (!candidate) throw new Error("Chisel binary is not configured");
    if (!isAbsolute(candidate)) throw new Error("Chisel binary path must be absolute");
    const requested = resolve(candidate);
    const allowlisted = this.options.allowedBinaries.map((path) => resolve(path));
    if (!allowlisted.includes(requested)) throw new Error("Chisel binary is not allowlisted");
    const stat = lstatSync(requested);
    if (stat.isSymbolicLink()) throw new Error("Chisel binary must not be a symbolic link");
    if (!stat.isFile()) throw new Error("Chisel binary must be a regular file");
    const canonical = realpathSync(requested);
    if (!this.options.allowedRoots.some((root) => isInside(realpathSync(root), canonical))) {
      throw new Error("Chisel binary resolves outside trusted roots");
    }
    accessSync(canonical, constants.X_OK);
    this.binary = canonical;
    return canonical;
  }
}

function validateDefinition(definition: ChiselDefinition): void {
  if (definition.tokenCredentialRef !== undefined) safeValue(definition.tokenCredentialRef, "tokenCredentialRef");
  if (definition.mode === "server") {
    validPort(definition.port);
    return;
  }
  if (!/^https?:\/\/[^\s]+$/.test(definition.server) && !/^wss?:\/\/[^\s]+$/.test(definition.server)) {
    throw new Error("Invalid Chisel server URL");
  }
  if (!definition.routes.length) throw new Error("Chisel client requires at least one route");
  definition.routes.forEach(validateRoute);
}

function validateRoute(route: string): void {
  safeValue(route, "route");
  const value = route.startsWith("R:") ? route.slice(2) : route;
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 4 || parts.some((part) => !part)) throw new Error(`Invalid Chisel route: ${route}`);
  const ports = parts.filter((part) => /^\d+$/.test(part)).map(Number);
  if (!ports.length || ports.some((port) => port < 1 || port > 65_535)) throw new Error(`Invalid Chisel route: ${route}`);
}

function safeValue(value: string, name: string): string {
  if (!value || value.startsWith("-") || /[\0\r\n\s]/.test(value)) throw new Error(`Invalid Chisel ${name}`);
  return value;
}

function validPort(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error("Invalid Chisel server port");
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
