import {
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLocalBashOperations,
  createLsToolDefinition,
  createReadToolDefinition
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { constants, existsSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
  sep
} from "node:path";

export type ExecutorSandboxMode = "macos-seatbelt" | "linux-bubblewrap" | "workspace";

// Default per-call bash timeout (seconds) when the model does not pass one.
// The Pi SDK schema leaves timeout optional with no default; without a floor a
// runaway command (e.g. an unbounded brute-force loop) stalls the epoch until
// the global run deadline. The SDK kills the whole process tree on timeout and
// returns a "Command timed out" tool error the Executor can react to.
function executorBashDefaultTimeoutSeconds(): number {
  const value = Number(process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 300;
}

export type ExecutorSandboxRequestedMode = "auto" | "seatbelt" | "bubblewrap" | "workspace";

export type ExecutorSandbox = {
  root: string;
  mode: ExecutorSandboxMode;
  profilePath?: string;
  backendPath?: string;
  allowedReadRoots: string[];
  createTools: () => ToolDefinition<any, any, any>[];
};

export async function createExecutorSandbox(input: {
  runtimeDir: string;
  runId: string;
  mode?: ExecutorSandboxRequestedMode;
  environment?: NodeJS.ProcessEnv;
  additionalReadRoots?: string[];
}): Promise<ExecutorSandbox> {
  const runtimeDir = resolve(input.runtimeDir);
  const root = join(runtimeDir, "sandboxes", input.runId);
  const home = join(root, "home");
  const temp = join(root, "tmp");
  await Promise.all([mkdir(root, { recursive: true }), mkdir(home, { recursive: true }), mkdir(temp, { recursive: true })]);
  const canonicalRoot = await realpath(root);
  const environment = await prepareSandboxEnvironment(input.environment, canonicalRoot);
  const allowedReadRoots = await existingCanonicalRoots([
    canonicalRoot,
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".codex", "skills"),
    join(homedir(), ".pi", "agent", "skills"),
    ...(input.additionalReadRoots ?? [])
  ]);
  const requestedMode = input.mode ?? executorSandboxModeFromEnv();
  const seatbeltPath = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")
    ? "/usr/bin/sandbox-exec"
    : undefined;
  const bubblewrapPath = process.platform === "linux" || requestedMode === "bubblewrap"
    ? await findExecutable(process.env.BWRAP_PATH, "bwrap")
    : undefined;
  if (requestedMode === "seatbelt" && !seatbeltPath) {
    throw new Error("EXECUTOR_SANDBOX_MODE=seatbelt requires macOS sandbox-exec");
  }
  if (requestedMode === "bubblewrap" && !bubblewrapPath) {
    throw new Error("EXECUTOR_SANDBOX_MODE=bubblewrap requires the bwrap executable");
  }
  const useSeatbelt = requestedMode === "seatbelt"
    || (requestedMode === "auto" && Boolean(seatbeltPath));
  const useBubblewrap = requestedMode === "bubblewrap"
    || (requestedMode === "auto" && !useSeatbelt && Boolean(bubblewrapPath));
  const mode: ExecutorSandboxMode = useSeatbelt
    ? "macos-seatbelt"
    : useBubblewrap
      ? "linux-bubblewrap"
      : "workspace";
  const profilePath = useSeatbelt ? join(runtimeDir, `executor-${input.runId}.sb`) : undefined;
  if (profilePath) {
    await writeFile(profilePath, createSeatbeltProfile({
      sandboxRoot: canonicalRoot,
      readOnlyRoots: allowedReadRoots.filter((candidate) => candidate !== canonicalRoot)
    }), "utf8");
  }
  const pathPolicy = new SandboxPathPolicy(canonicalRoot, allowedReadRoots);
  const localBash = createLocalBashOperations();

  return {
    root: canonicalRoot,
    mode,
    profilePath,
    backendPath: useSeatbelt ? seatbeltPath : useBubblewrap ? bubblewrapPath : undefined,
    allowedReadRoots,
    createTools: () => [
      createReadToolDefinition(canonicalRoot, {
        operations: {
          access: async (absolutePath) => {
            const readablePath = await pathPolicy.requireReadable(absolutePath);
            await access(readablePath, constants.R_OK);
          },
          readFile: async (absolutePath) => readFile(await pathPolicy.requireReadable(absolutePath))
        }
      }),
      createBashToolDefinition(canonicalRoot, {
        operations: {
          exec: async (command, _cwd, options) => {
            const wrappedCommand = profilePath
              ? `${shellQuote(seatbeltPath!)} -f ${shellQuote(profilePath)} /bin/zsh --emulate sh -f -c ${shellQuote(command)}`
              : bubblewrapPath && useBubblewrap
                ? renderShellCommand(createBubblewrapCommand({
                    bubblewrapPath,
                    sandboxRoot: canonicalRoot,
                    readOnlyRoots: allowedReadRoots.filter((candidate) => candidate !== canonicalRoot),
                    command
                  }))
                : command;
            return localBash.exec(wrappedCommand, canonicalRoot, {
              ...options,
              timeout: options.timeout ?? executorBashDefaultTimeoutSeconds(),
              env: sandboxEnvironment(mergeCommandEnvironment(options.env, environment), canonicalRoot)
            });
          }
        }
      }),
      createGrepToolDefinition(canonicalRoot, {
        operations: {
          isDirectory: async (absolutePath) => (await stat(await pathPolicy.requireReadable(absolutePath))).isDirectory(),
          readFile: async (absolutePath) => readFile(await pathPolicy.requireReadable(absolutePath), "utf8")
        }
      }),
      createFindToolDefinition(canonicalRoot, {
        operations: {
          exists: async (absolutePath) => {
            await pathPolicy.requireReadable(absolutePath);
            return true;
          },
          glob: async (pattern, searchRoot, options) => findWithinRoot({
            pattern,
            searchRoot: await pathPolicy.requireReadable(searchRoot),
            ignore: options.ignore,
            limit: options.limit
          })
        }
      }),
      createLsToolDefinition(canonicalRoot, {
        operations: {
          exists: async (absolutePath) => {
            await pathPolicy.requireReadable(absolutePath);
            return true;
          },
          stat: async (absolutePath) => stat(await pathPolicy.requireReadable(absolutePath)),
          readdir: async (absolutePath) => readdir(await pathPolicy.requireReadable(absolutePath))
        }
      })
    ] as ToolDefinition<any, any, any>[]
  };
}

export class SandboxPathPolicy {
  constructor(
    readonly root: string,
    readonly allowedReadRoots: string[] = [root]
  ) {}

  async requireReadable(candidatePath: string): Promise<string> {
    const resolvedPath = resolve(this.root, candidatePath);
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(resolvedPath);
    } catch {
      throw new Error(`Executor sandbox path does not exist: ${candidatePath}`);
    }
    if (!this.allowedReadRoots.some((allowedRoot) => isWithin(allowedRoot, canonicalPath))) {
      throw new Error(`Executor sandbox denied path outside allowed roots: ${candidatePath}`);
    }
    return canonicalPath;
  }
}

export function createSeatbeltProfile(input: {
  sandboxRoot: string;
  readOnlyRoots?: string[];
}): string {
  const readableRoots = [
    input.sandboxRoot,
    ...(input.readOnlyRoots ?? []),
    "/opt",
    "/usr/local",
    "/private/etc",
    "/private/var/select"
  ];
  return [
    "(version 1)",
    "(import \"system.sb\")",
    "(allow process*)",
    "(allow network*)",
    `(allow file-read-metadata (subpath ${seatbeltString(homedir())}) (subpath \"/private/var/folders\"))`,
    `(allow file-read* ${readableRoots.map((root) => `(subpath ${seatbeltString(root)})`).join(" ")})`,
    `(allow file-write* (subpath ${seatbeltString(input.sandboxRoot)}))`
  ].join("\n") + "\n";
}

export function createBubblewrapCommand(input: {
  bubblewrapPath: string;
  sandboxRoot: string;
  readOnlyRoots?: string[];
  command: string;
  shellPath?: string;
}): string[] {
  const shellPath = input.shellPath ?? firstExistingPath(["/bin/bash", "/usr/bin/bash", "/bin/sh"]) ?? "/bin/sh";
  const systemRoots = existingPaths(["/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt"]);
  const systemFiles = existingPaths([
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/nsswitch.conf",
    "/etc/services",
    "/etc/protocols",
    "/etc/passwd",
    "/etc/group",
    "/etc/localtime",
    "/etc/ld.so.cache"
  ]);
  const systemDirectories = existingPaths([
    "/etc/alternatives",
    "/etc/ssl",
    "/etc/ca-certificates",
    "/etc/pki",
    "/etc/ld.so.conf.d",
    "/run/systemd/resolve",
    "/run/NetworkManager"
  ]);
  const argumentsList = [
    input.bubblewrapPath,
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/etc",
    "--dir",
    "/home",
    "--dir",
    "/run"
  ];
  for (const root of dedupeNestedRoots([...systemRoots, ...systemDirectories, ...(input.readOnlyRoots ?? [])])) {
    argumentsList.push("--ro-bind", root, root);
  }
  for (const file of systemFiles) {
    argumentsList.push("--ro-bind", file, file);
  }
  argumentsList.push(
    "--bind",
    input.sandboxRoot,
    input.sandboxRoot,
    "--chdir",
    input.sandboxRoot,
    "--setenv",
    "HOME",
    join(input.sandboxRoot, "home"),
    "--setenv",
    "TMPDIR",
    join(input.sandboxRoot, "tmp"),
    "--setenv",
    "TMPPREFIX",
    join(input.sandboxRoot, "tmp", "zsh"),
    shellPath,
    "-c",
    input.command
  );
  return argumentsList;
}

function executorSandboxModeFromEnv(): ExecutorSandboxRequestedMode {
  const value = process.env.EXECUTOR_SANDBOX_MODE?.trim().toLowerCase();
  if (value === "bwrap" || value === "linux-bubblewrap") {
    return "bubblewrap";
  }
  if (value === "seatbelt" || value === "bubblewrap" || value === "workspace") {
    return value;
  }
  return "auto";
}

async function prepareSandboxEnvironment(input: NodeJS.ProcessEnv | undefined, root: string): Promise<NodeJS.ProcessEnv | undefined> {
  if (!input?.HTTP_PROXY && !input?.http_proxy) return input;
  const sourceCaPath = input.CURL_CA_BUNDLE ?? input.SSL_CERT_FILE ?? input.NODE_EXTRA_CA_CERTS;
  if (!sourceCaPath) throw new Error("managed proxy environment has no public CA certificate");
  const sandboxCaPath = join(root, "traffic-proxy-ca.crt");
  await copyFile(sourceCaPath, sandboxCaPath);
  await chmod(sandboxCaPath, 0o444);
  return {
    ...input,
    SSL_CERT_FILE: sandboxCaPath,
    CURL_CA_BUNDLE: sandboxCaPath,
    NODE_EXTRA_CA_CERTS: sandboxCaPath
  };
}

function mergeCommandEnvironment(
  toolEnvironment: NodeJS.ProcessEnv | undefined,
  managedEnvironment: NodeJS.ProcessEnv | undefined
): NodeJS.ProcessEnv | undefined {
  if (!managedEnvironment) return toolEnvironment;
  const environment = { ...toolEnvironment, ...managedEnvironment };
  if (managedEnvironment.HTTP_PROXY || managedEnvironment.http_proxy) {
    delete environment.ALL_PROXY;
    delete environment.all_proxy;
    delete environment.NO_PROXY;
    delete environment.no_proxy;
  }
  return environment;
}

function sandboxEnvironment(input: NodeJS.ProcessEnv | undefined, root: string): NodeJS.ProcessEnv {
  const source = input ?? process.env;
  const output: NodeJS.ProcessEnv = {
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    TMPPREFIX: join(root, "tmp", "zsh"),
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: source.LANG ?? "C.UTF-8",
    LC_ALL: source.LC_ALL,
    LC_CTYPE: source.LC_CTYPE,
    TERM: source.TERM,
    TZ: source.TZ,
    HTTP_PROXY: source.HTTP_PROXY,
    HTTPS_PROXY: source.HTTPS_PROXY,
    http_proxy: source.http_proxy,
    https_proxy: source.https_proxy,
    NO_PROXY: source.NO_PROXY,
    no_proxy: source.no_proxy,
    SSL_CERT_FILE: source.SSL_CERT_FILE,
    SSL_CERT_DIR: source.SSL_CERT_DIR,
    CURL_CA_BUNDLE: source.CURL_CA_BUNDLE,
    NODE_EXTRA_CA_CERTS: source.NODE_EXTRA_CA_CERTS,
    PYTHONDONTWRITEBYTECODE: "1"
  };
  return Object.fromEntries(Object.entries(output).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function existingCanonicalRoots(candidates: string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      roots.push(await realpath(candidate));
    } catch {
      // Optional read-only roots are omitted when unavailable.
    }
  }
  return [...new Set(roots)];
}

async function findExecutable(explicitPath: string | undefined, executableName: string): Promise<string | undefined> {
  const candidates = explicitPath
    ? [explicitPath]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((pathEntry) => join(pathEntry, executableName));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

function existingPaths(paths: string[]): string[] {
  return paths.filter((candidate) => existsSync(candidate));
}

function firstExistingPath(paths: string[]): string | undefined {
  return paths.find((candidate) => existsSync(candidate));
}

function dedupeNestedRoots(paths: string[]): string[] {
  const uniquePaths = [...new Set(paths)].sort((left, right) => left.length - right.length);
  return uniquePaths.filter((candidate, index) => !uniquePaths.slice(0, index).some((parent) => isWithin(parent, candidate)));
}

function renderShellCommand(argumentsList: string[]): string {
  return argumentsList.map(shellQuote).join(" ");
}

async function findWithinRoot(input: {
  pattern: string;
  searchRoot: string;
  ignore: string[];
  limit: number;
}): Promise<string[]> {
  const results: string[] = [];
  const ignoredNames = new Set(["node_modules", ".git"]);
  const visit = async (currentDirectory: string): Promise<void> => {
    if (results.length >= input.limit) {
      return;
    }
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= input.limit) {
        return;
      }
      if (ignoredNames.has(entry.name) || entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = join(currentDirectory, entry.name);
      const relativePath = relative(input.searchRoot, absolutePath).split(sep).join("/");
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (matchesGlob(relativePath, input.pattern) || (!input.pattern.includes("/") && matchesGlob(entry.name, input.pattern))) {
        results.push(absolutePath);
      }
    }
  };
  await visit(input.searchRoot);
  return results;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function seatbeltString(value: string): string {
  return JSON.stringify(value);
}
