export type CliOptions = {
  goal: string;
  scope: string;
  runtimeDir?: string;
  resumeDir?: string;
  maxPlannerCycles?: number;
  maxParallelTasks?: number;
  maxRunTimeMs?: number;
  json: boolean;
  jsonl: boolean;
  noTui: boolean;
  help: boolean;
};

export function parseCliOptions(rawArgs: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const booleanFlags = new Set(["json", "jsonl", "no-tui", "help"]);
  const valueOptions = new Set([
    "goal",
    "scope",
    "runtime-dir",
    "resume",
    "max-cycles",
    "max-parallel-tasks",
    "max-run-time-ms"
  ]);

  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const key = argument.slice(2);
    if (booleanFlags.has(key)) {
      flags.add(key);
      continue;
    }
    if (!valueOptions.has(key)) {
      throw new Error(`Unknown option: --${key}`);
    }
    const value = rawArgs[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    values.set(key, value);
    index += 1;
  }

  if (values.has("runtime-dir") && values.has("resume")) {
    throw new Error("--runtime-dir and --resume cannot be used together");
  }
  if (values.has("resume") && values.has("goal")) {
    throw new Error("--goal cannot be used with --resume; the stored Goal will be restored");
  }
  if (values.has("resume") && values.has("scope")) {
    throw new Error("--scope cannot be used with --resume; the stored authorized scope will be restored");
  }

  return {
    goal: values.get("goal") ?? "在授权范围内完成 Web 安全评估",
    scope: values.get("scope") ?? "仅限用户明确授权的目标范围",
    runtimeDir: values.get("runtime-dir"),
    resumeDir: values.get("resume"),
    maxPlannerCycles: optionalNumber(values, "max-cycles"),
    maxParallelTasks: optionalNumber(values, "max-parallel-tasks"),
    maxRunTimeMs: optionalNumber(values, "max-run-time-ms"),
    json: flags.has("json"),
    jsonl: flags.has("jsonl"),
    noTui: flags.has("no-tui"),
    help: flags.has("help")
  };
}

export function shouldUseTui(options: CliOptions, terminal: { stdinIsTTY?: boolean; stdoutIsTTY?: boolean }): boolean {
  return terminal.stdinIsTTY === true && terminal.stdoutIsTTY === true &&
    !options.noTui && !options.json && !options.jsonl;
}

export function cliHelp(): string {
  return [
    "Usage: npm start -- [options]",
    "",
    "Options:",
    "  --goal <text>                Agent goal",
    "  --scope <text>               Authorized scope summary",
    "  --runtime-dir <path>         New runtime directory; must be empty",
    "  --resume <session>           Resume one runtime; do not pass --goal",
    "  --max-cycles <number>        Maximum Planner cycles",
    "  --max-parallel-tasks <n>     Maximum concurrent tasks",
    "  --max-run-time-ms <number>   Run timeout in milliseconds",
    "  --json                       Disable TUI and print final JSON",
    "  --jsonl                      Stream durable events as JSON Lines",
    "  --no-tui                     Disable TUI",
    "  --help                       Show this help",
    "",
    "Interactive controls:",
    "  Ctrl+C                       Interrupt the active run",
    "  Up/Down                      Select an action",
    "  Enter                        Expand or collapse action details",
    "  Tab                          Show next task",
    "  Shift+Tab                    Show previous task"
  ].join("\n");
}

function optionalNumber(values: Map<string, string>, key: string): number | undefined {
  const value = values.get(key);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid number for --${key}: ${value}`);
  }
  return parsed;
}
