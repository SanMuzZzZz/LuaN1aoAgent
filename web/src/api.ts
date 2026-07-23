import { translate } from "./language";
import type { ActiveRunsResponse, ArtifactContent, AuthResponse, ConnectionItem, ConnectionsResponse, CreateSshTunnelInput, RuntimeState, SessionsResponse, StartRunInput, StartRunResponse, StopRunResponse, TrafficExchange, TrafficHistoryBody, TrafficHistoryFilters, TrafficHistoryPage, TrafficReplayInput, TrafficReplayResponse } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

let csrfTokenPromise: Promise<string> | undefined;

async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const requestOptions = { cache: "no-store" as RequestCache, credentials: "same-origin" as RequestCredentials, ...options };
  if (isMutation(options.method)) {
    const headers = new Headers(options.headers);
    headers.set("X-CSRF-Token", await csrfToken());
    requestOptions.headers = headers;
  }
  const response = await fetch(url, requestOptions);
  const body = await response.json().catch(() => ({})) as { error?: string | { code?: string; message?: string } };
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    const code = typeof body.error === "object" ? body.error?.code : undefined;
    throw new ApiError(message || `HTTP ${response.status}`, response.status, code);
  }
  return body as T;
}

function csrfToken(): Promise<string> {
  csrfTokenPromise ??= fetch("/api/auth/csrf", { cache: "no-store", credentials: "same-origin" })
    .then(async (response) => {
      const body = await response.json().catch(() => ({})) as { csrfToken?: string };
      if (!response.ok || !body.csrfToken) throw new ApiError(translate("api.csrfUnavailable"), response.status, "csrf_token_unavailable");
      return body.csrfToken;
    })
    .catch((error) => {
      csrfTokenPromise = undefined;
      throw error;
    });
  return csrfTokenPromise;
}

function isMutation(method: string | undefined): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes((method ?? "GET").toUpperCase());
}

export function runtimeRoot(runtimeDir: string): string {
  const normalized = runtimeDir.trim() || ".agent-runtime";
  return normalized === ".agent-runtime" || normalized.startsWith(".agent-runtime/")
    ? ".agent-runtime"
    : normalized;
}

export function fetchRuntimeState(runtimeDir: string, signal?: AbortSignal): Promise<RuntimeState> {
  return requestJson(`/api/state?runtimeDir=${encodeURIComponent(runtimeDir)}`, { signal });
}

export function fetchSessions(runtimeDir: string, signal?: AbortSignal): Promise<SessionsResponse> {
  return requestJson(`/api/sessions?rootDir=${encodeURIComponent(runtimeRoot(runtimeDir))}`, { signal });
}

export function startRun(input: StartRunInput): Promise<StartRunResponse> {
  return requestJson("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function fetchRuns(signal?: AbortSignal): Promise<ActiveRunsResponse> {
  return requestJson("/api/runs", { signal });
}

export function stopRun(runtimeDir: string): Promise<StopRunResponse> {
  return requestJson("/api/runs/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runtimeDir })
  });
}

export function fetchArtifact(runtimeDir: string, artifactRef: string, signal?: AbortSignal): Promise<ArtifactContent> {
  return requestJson(`/api/artifact?runtimeDir=${encodeURIComponent(runtimeDir)}&artifactRef=${encodeURIComponent(artifactRef)}`, { signal });
}

export function fetchTrafficHistory(
  runtimeDir: string,
  options: { cursor?: string; limit?: number; filters?: TrafficHistoryFilters } = {},
  signal?: AbortSignal
): Promise<TrafficHistoryPage> {
  const params = new URLSearchParams({ runtimeDir, limit: String(options.limit ?? 50) });
  if (options.cursor) params.set("cursor", options.cursor);
  for (const [key, value] of Object.entries(options.filters ?? {})) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return requestJson(`/api/traffic/history?${params}`, { signal });
}

export function fetchTrafficExchange(runtimeDir: string, exchangeId: number, signal?: AbortSignal): Promise<TrafficExchange> {
  const params = new URLSearchParams({ runtimeDir });
  return requestJson(`/api/traffic/history/${exchangeId}?${params}`, { signal });
}

export function fetchTrafficBody(
  runtimeDir: string,
  exchangeId: number,
  side: "request" | "response",
  byteLimit = 256 * 1024,
  signal?: AbortSignal
): Promise<TrafficHistoryBody> {
  const params = new URLSearchParams({ runtimeDir, side, byteLimit: String(Math.min(256 * 1024, Math.max(1, byteLimit))) });
  return requestJson(`/api/traffic/history/${exchangeId}/body?${params}`, { signal });
}

export function replayTrafficExchange(exchangeId: number, input: TrafficReplayInput): Promise<TrafficReplayResponse> {
  return requestJson(`/api/traffic/history/${exchangeId}/replay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function fetchCurrentUser(signal?: AbortSignal): Promise<AuthResponse> {
  return requestJson("/api/auth/me", { signal });
}

export function loginUser(input: { username: string; password: string }): Promise<AuthResponse> {
  return requestJson("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function registerUser(input: { username: string; displayName: string; password: string }): Promise<AuthResponse> {
  return requestJson("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function logoutUser(): Promise<{ ok: boolean }> {
  try {
    return await requestJson("/api/auth/logout", { method: "POST" });
  } finally {
    csrfTokenPromise = undefined;
  }
}

export function fetchConnections(runtimeDir: string, signal?: AbortSignal): Promise<ConnectionsResponse> {
  return requestJson(`/api/connectivity?runtimeDir=${encodeURIComponent(runtimeDir)}`, { signal });
}

export function createSshTunnel(input: CreateSshTunnelInput): Promise<ConnectionItem> {
  return requestJson("/api/connectivity/tunnels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function mutateConnection(runtimeDir: string, connectionId: string, action: "start" | "stop" | "close"): Promise<ConnectionItem> {
  return requestJson(`/api/connectivity/${encodeURIComponent(connectionId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runtimeDir })
  });
}
