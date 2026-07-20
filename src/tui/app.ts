import { matchesKey, ProcessTerminal, TUI, type Terminal } from "@earendil-works/pi-tui";
import type { ArtifactStore } from "../stores/artifact-store.js";
import type { ExecutionLog } from "../stores/execution-log.js";
import { AgentTimeline, type TimelineStatus } from "./timeline.js";

export class AgentCliApp {
  private readonly ui: TUI;
  private readonly timeline: AgentTimeline;
  private unsubscribe?: () => void;
  private removeInputListener?: () => void;
  private interruptRequested = false;
  private started = false;

  constructor(private readonly input: {
    executionLog: ExecutionLog;
    artifactStore?: Pick<ArtifactStore, "get" | "read">;
    goal: string;
    runtimeDir?: string;
    resumed?: boolean;
    onInterrupt: () => Promise<void>;
    onForceInterrupt: () => void;
    terminal?: Terminal;
  }) {
    this.ui = new TUI(input.terminal ?? new ProcessTerminal(), false);
    this.timeline = new AgentTimeline(500, input.artifactStore
      ? async (artifactRef) => {
        const maxBytes = 64 * 1024;
        const record = await input.artifactStore!.get(artifactRef);
        const content = await input.artifactStore!.read(artifactRef, { length: maxBytes });
        return record && record.byteLength > maxBytes
          ? `${content}\n...完整输出超过 ${maxBytes} 字节，终端详情已截断`
          : content;
      }
      : undefined);
    this.timeline.setGoal(input.goal);
    if (input.runtimeDir) {
      this.timeline.setRuntime(input.runtimeDir, input.resumed === true);
    }
    this.ui.addChild(this.timeline);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.unsubscribe = this.input.executionLog.subscribe((event) => {
      this.timeline.ingest(event);
      this.ui.requestRender();
    });
    for (const event of await this.input.executionLog.readAll()) {
      this.timeline.ingest(event);
    }
    this.timeline.setStatus("running", "Agent 正在执行");
    this.removeInputListener = this.ui.addInputListener((data) => {
      if (matchesKey(data, "up") || matchesKey(data, "down")) {
        this.timeline.moveActionSelection(matchesKey(data, "up") ? -1 : 1);
        this.ui.requestRender(true);
        return { consume: true };
      }
      if (matchesKey(data, "enter") || matchesKey(data, "space")) {
        const toggle = this.timeline.toggleSelectedAction();
        this.ui.requestRender(true);
        void toggle.finally(() => this.ui.requestRender(true));
        return { consume: true };
      }
      if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
        this.timeline.cycleTaskFilter(matchesKey(data, "tab") ? 1 : -1);
        this.ui.requestRender(true);
        return { consume: true };
      }
      if (!matchesKey(data, "ctrl+c")) {
        return undefined;
      }
      if (this.interruptRequested) {
        this.stopImmediately();
        this.input.onForceInterrupt();
        return { consume: true };
      }
      this.interruptRequested = true;
      this.timeline.setStatus("interrupting", "正在停止活跃 Agent 会话；再次 Ctrl+C 强制退出");
      this.ui.requestRender(true);
      void this.input.onInterrupt().catch((error: unknown) => {
        this.setStatus("failed", errorMessage(error));
      });
      return { consume: true };
    });
    this.ui.start();
  }

  setStatus(status: TimelineStatus, detail: string): void {
    this.timeline.setStatus(status, detail);
    this.ui.requestRender(true);
  }

  render(width: number): string[] {
    return this.timeline.render(width);
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.ui.requestRender(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    this.stopImmediately();
  }

  private stopImmediately(): void {
    if (!this.started) {
      return;
    }
    this.unsubscribe?.();
    this.removeInputListener?.();
    this.unsubscribe = undefined;
    this.removeInputListener = undefined;
    this.ui.stop();
    this.started = false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
