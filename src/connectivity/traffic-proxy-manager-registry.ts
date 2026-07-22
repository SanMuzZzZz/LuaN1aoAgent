import { TrafficProxyManager, type TrafficProxyLifecycleEvent, type TrafficProxyManagerOptions } from "./traffic-proxy-manager.js";
import { canonicalTrafficProxyRuntimeDir } from "./traffic-proxy-runtime.js";

type TrafficProxyManagerRegistryOptions = TrafficProxyManagerOptions & {
  logEventForRuntime?: (runtimeDir: string, event: TrafficProxyLifecycleEvent) => void | Promise<void>;
};

export class TrafficProxyManagerRegistry {
  private readonly entries = new Map<string, Promise<TrafficProxyManager>>();
  private closeAllPromise?: Promise<void>;

  constructor(private readonly options: TrafficProxyManagerRegistryOptions = {}) {}

  get(runtimeDir: string): Promise<TrafficProxyManager> {
    if (this.closeAllPromise) return Promise.reject(new Error("traffic-proxy manager registry is closing"));
    const canonical = canonicalTrafficProxyRuntimeDir(runtimeDir);
    const existing = this.entries.get(canonical);
    if (existing) return existing;
    const created = Promise.resolve().then(async () => {
      const { logEventForRuntime, onUnavailable, ...managerOptions } = this.options;
      const manager = new TrafficProxyManager(canonical, {
        ...managerOptions,
        ...(logEventForRuntime ? { logEvent: (event) => logEventForRuntime(canonical, event) } : {}),
        onUnavailable: () => {
          if (this.entries.get(canonical) === created) this.entries.delete(canonical);
          onUnavailable?.();
        }
      });
      await manager.start();
      return manager;
    });
    this.entries.set(canonical, created);
    void created.catch(() => {
      if (this.entries.get(canonical) === created) this.entries.delete(canonical);
    });
    return created;
  }

  async getExisting(runtimeDir: string): Promise<TrafficProxyManager | undefined> {
    const canonical = canonicalTrafficProxyRuntimeDir(runtimeDir);
    const existing = this.entries.get(canonical);
    if (existing) return existing;
    const { logEventForRuntime: _logEventForRuntime, ...managerOptions } = this.options;
    const manager = new TrafficProxyManager(canonical, managerOptions);
    try {
      await manager.attachExisting();
      return manager;
    } catch {
      return undefined;
    }
  }

  has(runtimeDir: string): boolean {
    return this.entries.has(canonicalTrafficProxyRuntimeDir(runtimeDir));
  }

  get size(): number {
    return this.entries.size;
  }

  async close(runtimeDir: string): Promise<void> {
    const canonical = canonicalTrafficProxyRuntimeDir(runtimeDir);
    const entry = this.entries.get(canonical);
    if (!entry) return;
    this.entries.delete(canonical);
    const result = await Promise.allSettled([entry]);
    if (result[0].status === "fulfilled") await result[0].value.close();
  }

  closeAll(): Promise<void> {
    if (!this.closeAllPromise) this.closeAllPromise = this.closeAllInternal();
    return this.closeAllPromise;
  }

  private async closeAllInternal(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    const managers = await Promise.allSettled(entries);
    await Promise.allSettled(managers.flatMap((result) => result.status === "fulfilled" ? [result.value.close()] : []));
  }
}
