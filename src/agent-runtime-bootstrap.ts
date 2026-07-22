import { join } from "node:path";
import { SecurityAgentController } from "./controller.js";
import { TrafficProxyManager } from "./connectivity/traffic-proxy-manager.js";
import { TrafficProxyManagerRegistry } from "./connectivity/traffic-proxy-manager-registry.js";
import { ExecutionLog } from "./stores/execution-log.js";

export type AgentRuntimeLifecycle = {
  controller: SecurityAgentController;
  trafficProxyManager: TrafficProxyManager;
  close: () => Promise<void>;
};

export type AgentRuntimeBootstrapOptions = {
  cwd: string;
  runtimeDir: string;
  routeRef: string;
  trafficProxyRegistry?: TrafficProxyManagerRegistry;
  controllerFactory?: (input: { cwd: string; runtimeDir: string; environment: NodeJS.ProcessEnv }) => SecurityAgentController;
};

export function createAgentTrafficProxyRegistry(): TrafficProxyManagerRegistry {
  return new TrafficProxyManagerRegistry({
    logEventForRuntime: async (runtimeDir, event) => {
      const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"), join(runtimeDir, "state.sqlite"));
      try {
        await executionLog.append({ role: "runtime", ...event });
        await executionLog.drain();
      } finally {
        executionLog.close();
      }
    }
  });
}

export async function bootstrapAgentRuntime(input: AgentRuntimeBootstrapOptions): Promise<AgentRuntimeLifecycle> {
  const registry = input.trafficProxyRegistry ?? createAgentTrafficProxyRegistry();
  let controller: SecurityAgentController | undefined;
  try {
    const trafficProxyManager = await registry.get(input.runtimeDir);
    controller = (input.controllerFactory ?? ((options) => new SecurityAgentController(options)))({
      cwd: input.cwd,
      runtimeDir: input.runtimeDir,
      environment: trafficProxyManager.managedEnvironment()
    });
    await controller.initialize();
    await trafficProxyManager.configureManagedHttpScope({
      taskRef: controller.runId,
      runRef: controller.runId,
      sessionRef: controller.runId,
      routeRef: input.routeRef,
      attribution: "security-agent"
    });

    let closePromise: Promise<void> | undefined;
    return {
      controller,
      trafficProxyManager,
      close: () => {
        closePromise ??= closeAgentRuntime(controller!, registry, input.runtimeDir);
        return closePromise;
      }
    };
  } catch (error) {
    await closeAgentRuntime(controller, registry, input.runtimeDir);
    throw error;
  }
}

async function closeAgentRuntime(
  controller: SecurityAgentController | undefined,
  registry: TrafficProxyManagerRegistry,
  runtimeDir: string
): Promise<void> {
  try {
    await controller?.close();
  } finally {
    await registry.close(runtimeDir);
  }
}
