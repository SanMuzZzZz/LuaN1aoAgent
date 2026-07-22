import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type RuntimePathMode = "existing" | "create";

export class RuntimePathPolicyError extends Error {
  constructor(
    message: string,
    readonly code: "runtime_path_outside_root" | "runtime_path_not_found" | "runtime_path_unresolvable"
  ) {
    super(message);
  }
}

/**
 * Resolves request-controlled runtime paths beneath one server-configured root.
 * Existing path prefixes are resolved with realpath, so symlinks cannot escape.
 * Runtimes currently have no owner metadata; authorization therefore grants an
 * authenticated/capable user access to any runtime under this configured root.
 */
export class RuntimePathPolicy {
  readonly rootDir: string;

  private constructor(
    rootDir: string,
    private readonly configuredRoot: string,
    private readonly baseDir: string
  ) {
    this.rootDir = rootDir;
  }

  static async create(rootInput: string, options: { baseDir?: string } = {}): Promise<RuntimePathPolicy> {
    const baseDir = resolve(options.baseDir ?? process.cwd());
    const configuredRoot = resolveInput(baseDir, rootInput);
    const rootDir = await canonicalizePotentialPath(configuredRoot);
    return new RuntimePathPolicy(rootDir, configuredRoot, baseDir);
  }

  async resolveRuntime(input: string, mode: RuntimePathMode = "existing"): Promise<string> {
    const candidate = resolveInput(this.baseDir, input);
    this.assertInsideConfiguredRoot(candidate);
    const canonical = await canonicalizePotentialPath(candidate);
    this.assertInsideCanonicalRoot(canonical);
    if (mode === "existing") await requireExisting(canonical);
    return canonical;
  }

  async resolveRuntimeChild(runtimeDir: string, childInput: string, mode: RuntimePathMode = "existing"): Promise<string> {
    const canonicalRuntime = await this.resolveRuntime(runtimeDir, "existing");
    const candidate = isAbsolute(childInput) ? resolve(childInput) : resolve(canonicalRuntime, childInput);
    const canonical = await canonicalizePotentialPath(candidate);
    if (!isPathInside(canonicalRuntime, canonical)) {
      throw new RuntimePathPolicyError("路径超出所选 runtime", "runtime_path_outside_root");
    }
    this.assertInsideCanonicalRoot(canonical);
    if (mode === "existing") await requireExisting(canonical);
    return canonical;
  }

  private assertInsideConfiguredRoot(candidate: string): void {
    if (!isPathInside(this.configuredRoot, candidate) && !isPathInside(this.rootDir, candidate)) {
      throw new RuntimePathPolicyError("Runtime 路径超出服务器允许的根目录", "runtime_path_outside_root");
    }
  }

  private assertInsideCanonicalRoot(candidate: string): void {
    if (!isPathInside(this.rootDir, candidate)) {
      throw new RuntimePathPolicyError("Runtime 路径通过符号链接超出服务器允许的根目录", "runtime_path_outside_root");
    }
  }
}

export function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

function resolveInput(baseDir: string, input: string): string {
  return resolve(baseDir, input.trim() || ".");
}

async function canonicalizePotentialPath(input: string): Promise<string> {
  const absolute = resolve(input);
  let existing = absolute;
  const missingSegments: string[] = [];

  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new RuntimePathPolicyError("无法检查 Runtime 路径", "runtime_path_unresolvable");
      }
      const parent = dirname(existing);
      if (parent === existing) {
        throw new RuntimePathPolicyError("无法解析 Runtime 路径", "runtime_path_unresolvable");
      }
      missingSegments.unshift(relative(parent, existing));
      existing = parent;
    }
  }

  let canonicalExisting: string;
  try {
    canonicalExisting = await realpath(existing);
  } catch {
    throw new RuntimePathPolicyError("Runtime 路径包含无法解析的符号链接", "runtime_path_unresolvable");
  }
  return resolve(canonicalExisting, ...missingSegments);
}

async function requireExisting(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RuntimePathPolicyError("Runtime 路径不存在", "runtime_path_not_found");
    }
    throw new RuntimePathPolicyError("无法访问 Runtime 路径", "runtime_path_unresolvable");
  }
}
