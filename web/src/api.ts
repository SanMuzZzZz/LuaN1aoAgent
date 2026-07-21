import type { ActiveRunsResponse, ArtifactContent, AuthResponse, RuntimeState, SessionsResponse, StartRunInput, StartRunResponse, StopRunResponse } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...options });
  const body = await response.json().catch(() => ({})) as { error?: string | { code?: string; message?: string } };
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    const code = typeof body.error === "object" ? body.error?.code : undefined;
    throw new ApiError(message || `HTTP ${response.status}`, response.status, code);
  }
  return body as T;
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

export function logoutUser(): Promise<{ ok: boolean }> {
  return requestJson("/api/auth/logout", { method: "POST" });
}
