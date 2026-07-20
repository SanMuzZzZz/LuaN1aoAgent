import { cliHelp, parseCliOptions, shouldUseTui } from "./cli-options.js";
import { resolveCliRunContext } from "./cli-runtime.js";
import { SecurityAgentController } from "./controller.js";
import { AgentCliApp } from "./tui/app.js";

try {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(cliHelp());
  } else {
    await run(options);
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}

async function run(options: ReturnType<typeof parseCliOptions>): Promise<void> {
  const runContext = resolveCliRunContext(options, process.cwd());
  const controller = new SecurityAgentController({ cwd: process.cwd(), runtimeDir: runContext.runtimeDir });
  const useTui = shouldUseTui(options, {
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY
  });
  let receivedSignal: NodeJS.Signals | undefined;
  let signalCount = 0;
  let stopRequest: Promise<void> | undefined;
  let unsubscribeJsonl: (() => void) | undefined;
  let jsonlResult: unknown;
  const requestStop = (signal: NodeJS.Signals): Promise<void> => {
    signalCount += 1;
    if (signalCount > 1) {
      process.exit(128 + signalNumber(signal));
    }
    receivedSignal = signal;
    process.exitCode = 128 + signalNumber(signal);
    stopRequest ??= controller.requestStop(`Received ${signal}`);
    return stopRequest;
  };
  const handleSignal = (signal: NodeJS.Signals): void => {
    void requestStop(signal);
  };
  const app = useTui
    ? new AgentCliApp({
      executionLog: controller.executionLog,
      artifactStore: controller.artifactStore,
      goal: runContext.userGoal,
      runtimeDir: runContext.runtimeDir,
      resumed: runContext.resumed,
      onInterrupt: () => requestStop("SIGINT"),
      onForceInterrupt: () => {
        void requestStop("SIGINT");
      }
    })
    : undefined;

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    if (options.jsonl) {
      process.stdout.write(`${JSON.stringify({
        type: "run",
        runtimeDir: runContext.runtimeDir,
        resumed: runContext.resumed,
        userGoal: runContext.userGoal,
        scopeSummary: runContext.scopeSummary
      })}\n`);
      unsubscribeJsonl = controller.executionLog.subscribe((event) => {
        process.stdout.write(`${JSON.stringify({ type: "event", event })}\n`);
      });
    }
    await app?.start();
    await controller.initialize();
    const result = await controller.runUntilDone({
      userGoal: runContext.userGoal,
      scopeSummary: runContext.scopeSummary,
      maxPlannerCycles: options.maxPlannerCycles,
      maxParallelTasks: options.maxParallelTasks,
      maxRunTimeMs: options.maxRunTimeMs
    });
    if (app) {
      app.setStatus(receivedSignal ? "interrupting" : "completed", receivedSignal ? "运行已中断" : "运行结果已生成");
    } else if (options.jsonl) {
      jsonlResult = result;
    } else if (!receivedSignal) {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    app?.setStatus("failed", errorMessage(error));
    if (!app) {
      console.error(errorMessage(error));
    }
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    await stopRequest;
    await controller.close();
    if (options.jsonl && jsonlResult !== undefined) {
      process.stdout.write(`${JSON.stringify({ type: "result", result: jsonlResult })}\n`);
    }
    unsubscribeJsonl?.();
    await app?.stop();
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === "SIGTERM" ? 15 : 2;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
