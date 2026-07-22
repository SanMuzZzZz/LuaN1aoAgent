import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

export const TRAFFIC_PROXY_PROTOCOL_VERSION = 1;
export const TRAFFIC_PROXY_MESSAGE_LIMIT = 64 * 1024;
export const TRAFFIC_PROXY_RESPONSE_LIMIT = 1024 * 1024;
export const TRAFFIC_PROXY_REPLAY_TIMEOUT_MS = 35_000;
export type TrafficProxyField = "runtime_ref" | "task_ref" | "run_ref" | "attribution" | "route_ref" | "session_ref";
export type TrafficProxyContext = Record<TrafficProxyField, string>;
export type TrafficProxyStatus = { uptime_seconds: number; requests: number; context: TrafficProxyContext };
export type ManagedHttpTrafficScope = {
  routeRef: string;
  sessionRef: string;
  taskRef?: string;
  runRef?: string;
  attribution?: string;
};
export const RAW_TRAFFIC_ATTRIBUTION_NOTICE = "Only HTTP operations executed inside a managed scope carry routeRef/sessionRef; raw or unmanaged traffic is not automatically attributed.";
export type TrafficHistoryFilter = Partial<Pick<TrafficProxyContext, "runtime_ref" | "task_ref" | "run_ref" | "route_ref" | "session_ref">> & {
  started_after?: string;
  started_before?: string;
  mode?: string;
  method?: string;
  host?: string;
  connect_ref?: string;
  error?: string;
  status?: number;
};
export type TrafficHeaderEntry = { name: string; value: string; ordinal: number };
export type TrafficReplayBody = { encoding: "base64"; data: string };
export type TrafficReplayInput = {
  exchange_id: number;
  method?: string;
  url?: string;
  headers?: TrafficHeaderEntry[];
  body?: TrafficReplayBody;
  route_ref?: string;
  session_ref?: string;
  context: TrafficProxyContext;
};
export type TrafficReplayResult = {
  exchange_id: number;
  replay_of: number;
  status: number;
  error_code?: string;
};
export type TrafficExchange = {
  id: number;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  method: string;
  url: string;
  host: string;
  scheme: string;
  protocol: string;
  mode: string;
  status: number;
  request_observed_bytes: number;
  response_observed_bytes: number;
  request_captured_bytes: number;
  response_captured_bytes: number;
  request_body_ref?: string;
  response_body_ref?: string;
  request_capture_state: string;
  response_capture_state: string;
  request_truncated: boolean;
  response_truncated: boolean;
  headers_truncated: boolean;
  quota_pressure: boolean;
  request_truncation_reason?: string;
  response_truncation_reason?: string;
  header_truncation_reason?: string;
  error?: string;
  runtime_ref?: string;
  task_ref?: string;
  run_ref?: string;
  attribution?: string;
  route_ref?: string;
  session_ref?: string;
  connect_ref?: string;
  connect_authority?: string;
  connect_host?: string;
  connect_port?: string;
  replay_of?: number;
  error_code?: string;
  evicted_exchanges: number;
  request_headers?: TrafficHeaderEntry[];
  response_headers?: TrafficHeaderEntry[];
};
export type TrafficHistoryPage = { items: TrafficExchange[]; has_more: boolean; next_cursor?: string };
export type TrafficHistoryBody = { exchange_id: number; side: "request" | "response"; body_ref: string; encoding: "base64"; data: string; bytes: number; truncated: boolean };
type ControlResponse<T> = { version: number; id?: string; ok: boolean; result?: T; error?: string; error_code?: string };
type ControlPayload = Record<string, unknown>;

export class TrafficProxyControlError extends Error {
  constructor(
    message: string,
    readonly errorCode = "traffic_proxy_control_error",
    readonly result?: unknown
  ) {
    super(message);
  }
}

export class TrafficProxyClient {
  readonly socketPath: string;
  readonly timeoutMs: number;
  readonly replayTimeoutMs: number;
  private scopeTail: Promise<void> = Promise.resolve();

  constructor(socketPath: string, options: { timeoutMs?: number; replayTimeoutMs?: number } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.replayTimeoutMs = options.replayTimeoutMs ?? TRAFFIC_PROXY_REPLAY_TIMEOUT_MS;
  }

  hello(): Promise<{ protocol: string; version: number; runtime_ref: string; proxy: string }> { return this.request("hello"); }
  health(): Promise<{ status: string; runtime_ref: string }> { return this.request("health"); }
  status(): Promise<TrafficProxyStatus> { return this.request("status"); }
  async set(field: TrafficProxyField, value: string): Promise<void> { await this.request("set", { field, value }); }
  async clear(field: TrafficProxyField): Promise<void> { await this.request("clear", { field }); }
  async shutdown(): Promise<void> { await this.request("shutdown"); }
  historyList(options: { cursor?: string; limit?: number; filter?: TrafficHistoryFilter } = {}): Promise<TrafficHistoryPage> {
    return this.request("history_list", options);
  }
  historyGet(exchangeId: number): Promise<TrafficExchange> {
    return this.request("history_get", { exchange_id: exchangeId });
  }
  historyBody(exchangeId: number, side: "request" | "response", byteLimit?: number): Promise<TrafficHistoryBody> {
    return this.request("history_body", { exchange_id: exchangeId, side, ...(byteLimit === undefined ? {} : { byte_limit: byteLimit }) });
  }
  replay(input: TrafficReplayInput): Promise<TrafficReplayResult> {
    return this.request("replay", input, this.replayTimeoutMs);
  }

  async configureManagedHttpScope(scope: ManagedHttpTrafficScope): Promise<void> {
    const values = managedHttpContext(scope);
    const previousTail = this.scopeTail;
    let release!: () => void;
    this.scopeTail = new Promise<void>((resolve) => { release = resolve; });
    await previousTail;
    try {
      for (const field of fields) if (values[field] !== undefined) await this.apply(field, values[field]!);
    } finally {
      release();
    }
  }

  async withManagedHttpScope<T>(scope: ManagedHttpTrafficScope, operation: () => Promise<T>): Promise<T> {
    return this.withAttributionScope(managedHttpContext(scope), operation);
  }

  async withAttributionScope<T>(values: Partial<TrafficProxyContext>, operation: () => Promise<T>): Promise<T> {
    const previousTail = this.scopeTail;
    let release!: () => void;
    this.scopeTail = new Promise<void>((resolve) => { release = resolve; });
    await previousTail;
    try {
      const previous = (await this.status()).context;
      for (const field of fields) if (values[field] !== undefined) await this.apply(field, values[field]!);
      try {
        return await operation();
      } finally {
        for (const field of fields) if (values[field] !== undefined) await this.apply(field, previous[field]);
      }
    } finally {
      release();
    }
  }

  private async apply(field: TrafficProxyField, value: string): Promise<void> {
    if (value) await this.set(field, value);
    else await this.clear(field);
  }

  private request<T>(command: string, fields: ControlPayload = {}, timeoutMs = this.timeoutMs): Promise<T> {
    const id = randomUUID();
    const payload = JSON.stringify({ version: TRAFFIC_PROXY_PROTOCOL_VERSION, id, command, ...fields }) + "\n";
    if (Buffer.byteLength(payload) > TRAFFIC_PROXY_MESSAGE_LIMIT) {
      return Promise.reject(new TrafficProxyControlError("traffic-proxy request exceeds 64KiB", "traffic_proxy_request_too_large"));
    }
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let settled = false;
      let bytes = 0;
      let input = "";
      const finish = (error?: Error, result?: T) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(result as T);
      };
      socket.setTimeout(timeoutMs, () => finish(new TrafficProxyControlError(
        `traffic-proxy request timed out after ${timeoutMs}ms`,
        "traffic_proxy_timeout"
      )));
      socket.on("error", (error) => finish(new TrafficProxyControlError(
        `traffic-proxy control error: ${error.message}`,
        "traffic_proxy_control_error"
      )));
      socket.on("connect", () => socket.write(payload));
      socket.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > TRAFFIC_PROXY_RESPONSE_LIMIT) {
          return finish(new TrafficProxyControlError("traffic-proxy response exceeds 1MiB", "traffic_proxy_response_too_large"));
        }
        input += chunk.toString("utf8");
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(input.slice(0, newline)) as ControlResponse<T>;
          if (response.version !== TRAFFIC_PROXY_PROTOCOL_VERSION || response.id !== id) {
            throw new TrafficProxyControlError("mismatched traffic-proxy response", "traffic_proxy_invalid_response");
          }
          if (!response.ok) {
            throw new TrafficProxyControlError(
              response.error || "traffic-proxy command failed",
              response.error_code || "traffic_proxy_command_failed",
              response.result
            );
          }
          finish(undefined, response.result as T);
        } catch (error) {
          finish(error instanceof TrafficProxyControlError
            ? error
            : new TrafficProxyControlError(error instanceof Error ? error.message : String(error), "traffic_proxy_invalid_response"));
        }
      });
      socket.on("end", () => finish(new TrafficProxyControlError(
        "traffic-proxy closed without a response",
        "traffic_proxy_closed"
      )));
    });
  }
}

const fields: TrafficProxyField[] = ["runtime_ref", "task_ref", "run_ref", "attribution", "route_ref", "session_ref"];

function managedHttpContext(scope: ManagedHttpTrafficScope): Partial<TrafficProxyContext> {
  return {
    route_ref: requiredScopeRef(scope.routeRef, "routeRef"),
    session_ref: requiredScopeRef(scope.sessionRef, "sessionRef"),
    ...(scope.taskRef === undefined ? {} : { task_ref: requiredScopeRef(scope.taskRef, "taskRef") }),
    ...(scope.runRef === undefined ? {} : { run_ref: requiredScopeRef(scope.runRef, "runRef") }),
    ...(scope.attribution === undefined ? {} : { attribution: requiredScopeRef(scope.attribution, "attribution") })
  };
}

function requiredScopeRef(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TrafficProxyControlError(`${name} is invalid`, "invalid_context");
  }
  return normalized;
}
