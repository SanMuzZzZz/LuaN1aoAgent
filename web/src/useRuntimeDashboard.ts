import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRuntimeState, fetchSessions } from "./api";
import type { RuntimeSession, RuntimeState } from "./types";

export interface RuntimeDashboardState {
  data?: RuntimeState;
  sessions: RuntimeSession[];
  loading: boolean;
  refreshing: boolean;
  error?: string;
  autoRefresh: boolean;
  setAutoRefresh: (enabled: boolean) => void;
  refresh: () => Promise<void>;
}

export function useRuntimeDashboard(runtimeDir: string): RuntimeDashboardState {
  const [data, setData] = useState<RuntimeState>();
  const [sessions, setSessions] = useState<RuntimeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const requestSequence = useRef(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const sessionsControllerRef = useRef<AbortController | undefined>(undefined);

  const loadSessions = useCallback(async () => {
    sessionsControllerRef.current?.abort();
    const controller = new AbortController();
    sessionsControllerRef.current = controller;
    try {
      const response = await fetchSessions(runtimeDir, controller.signal);
      if (!controller.signal.aborted) setSessions(response.sessions || []);
    } catch (requestError) {
      if (!controller.signal.aborted) setError((current) => current || `会话列表加载失败：${errorText(requestError)}`);
    }
  }, [runtimeDir]);

  const refresh = useCallback(async () => {
    const requestId = ++requestSequence.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRefreshing(true);
    try {
      const stateResult = await fetchRuntimeState(runtimeDir, controller.signal);
      if (requestId !== requestSequence.current) return;
      setData(stateResult);
      setError(undefined);
    } catch (requestError) {
      if (controller.signal.aborted) return;
      if (requestId === requestSequence.current) {
        setError(`运行态加载失败：${errorText(requestError)}`);
      }
    } finally {
      if (requestId === requestSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [runtimeDir]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refresh().finally(() => { if (!cancelled) void loadSessions(); });
    return () => {
      cancelled = true;
      controllerRef.current?.abort();
      sessionsControllerRef.current?.abort();
    };
  }, [loadSessions, refresh]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      if (document.hidden) return;
      timer = window.setTimeout(async () => {
        await refresh();
        schedule();
      }, 5000);
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        window.clearTimeout(timer);
      } else {
        void refresh().finally(schedule);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule();
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [autoRefresh, refresh]);

  return { data, sessions, loading, refreshing, error, autoRefresh, setAutoRefresh, refresh };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
