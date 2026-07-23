import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Descriptions, Empty, Input, Modal, Radio, Select, Space, Spin, Tag, Typography } from "antd";
import { Plus, RotateCcw, Send, Trash2 } from "lucide-react";
import { fetchTrafficBody, replayTrafficExchange } from "../api";
import { useLanguage } from "../language";
import type { AuthUser, TrafficExchange, TrafficHeaderEntry, TrafficHistoryBody } from "../types";
import { formatTime, shortRef } from "../utils";
import { formatTrafficMode } from "./TrafficView";

interface TrafficInspectorProps {
  runtimeDir: string;
  exchange?: TrafficExchange;
  user: AuthUser;
  onSelectExchange: (exchangeId: number) => void;
  onReplayed: (exchangeId: number) => void;
}

type BodySide = "request" | "response";
type BodyState = { loading?: boolean; value?: TrafficHistoryBody; error?: string };
type EditableHeader = TrafficHeaderEntry & { key: string };

export function TrafficInspector(props: TrafficInspectorProps) {
  const { t, formatBytes: formatLocalizedBytes, formatDuration } = useLanguage();
  const [bodies, setBodies] = useState<Record<BodySide, BodyState>>({ request: {}, response: {} });
  const bodyRequests = useRef<Record<BodySide, number>>({ request: 0, response: 0 });

  useEffect(() => {
    bodyRequests.current.request += 1;
    bodyRequests.current.response += 1;
    setBodies({ request: {}, response: {} });
  }, [props.runtimeDir, props.exchange?.id]);

  if (!props.exchange) {
    return <div className="inspector-content"><div className="inspector-heading"><span>{t("traffic.inspector")}</span><Typography.Title level={4}>{t("traffic.exchangeDetails")}</Typography.Title></div><Empty description={t("traffic.selectRecord")} /></div>;
  }

  const exchange = props.exchange;
  const loadBody = async (side: BodySide): Promise<TrafficHistoryBody | undefined> => {
    const current = bodies[side];
    if (current.value) return current.value;
    const requestId = ++bodyRequests.current[side];
    setBodies((value) => ({ ...value, [side]: { loading: true } }));
    try {
      const result = await fetchTrafficBody(props.runtimeDir, exchange.id, side);
      if (bodyRequests.current[side] !== requestId) return undefined;
      setBodies((value) => ({ ...value, [side]: { value: result } }));
      return result;
    } catch (cause) {
      if (bodyRequests.current[side] !== requestId) return undefined;
      const error = cause instanceof Error ? cause.message : String(cause);
      setBodies((value) => ({ ...value, [side]: { error } }));
      return undefined;
    }
  };

  return (
    <div className="inspector-content traffic-inspector">
      <div className="inspector-heading"><span>{t("traffic.inspector")}</span><Typography.Title level={4}>Exchange #{exchange.id}</Typography.Title></div>
      <section className="inspector-primary">
        <div className="traffic-inspector-title"><Tag color="blue">{exchange.method}</Tag><strong>{exchange.host}</strong><Tag color={exchange.error ? "error" : "success"}>{exchange.status || "-"}</Tag></div>
        <code className="node-id">{exchange.url}</code>
        <Descriptions size="small" column={1} colon={false} items={[
          { key: "started", label: t("traffic.started"), children: formatTime(exchange.started_at) },
          { key: "completed", label: t("traffic.completed"), children: formatTime(exchange.completed_at) },
          { key: "duration", label: t("traffic.duration"), children: formatDuration(exchange.duration_ms) },
          { key: "protocol", label: t("traffic.protocol"), children: `${exchange.scheme} · ${exchange.protocol}` },
          { key: "mode", label: t("traffic.mode"), children: modeDescription(exchange) },
          { key: "request", label: t("traffic.requestBytes"), children: t("traffic.capturedObserved", { captured: formatLocalizedBytes(exchange.request_captured_bytes), observed: formatLocalizedBytes(exchange.request_observed_bytes) }) },
          { key: "response", label: t("traffic.responseBytes"), children: t("traffic.capturedObserved", { captured: formatLocalizedBytes(exchange.response_captured_bytes), observed: formatLocalizedBytes(exchange.response_observed_bytes) }) },
          { key: "error", label: t("traffic.error"), children: exchange.error ? `${exchange.error_code || "error"}: ${exchange.error}` : t("common.none") }
        ]} />
        <ReferenceChain exchange={exchange} onSelectExchange={props.onSelectExchange} />
        <HeaderSection title={t("traffic.requestHeaders")} headers={exchange.request_headers} truncated={exchange.headers_truncated} reason={exchange.header_truncation_reason} />
        <BodySection side="request" exchange={exchange} state={bodies.request} onLoad={() => void loadBody("request")} />
        <HeaderSection title={t("traffic.responseHeaders")} headers={exchange.response_headers} truncated={exchange.headers_truncated} reason={exchange.header_truncation_reason} />
        <BodySection side="response" exchange={exchange} state={bodies.response} onLoad={() => void loadBody("response")} />
        <ReplayEditor
          runtimeDir={props.runtimeDir}
          exchange={exchange}
          user={props.user}
          requestBody={bodies.request.value}
          loadRequestBody={() => loadBody("request")}
          onReplayed={props.onReplayed}
        />
      </section>
    </div>
  );
}

function HeaderSection({ title, headers, truncated, reason }: { title: string; headers?: TrafficHeaderEntry[]; truncated: boolean; reason?: string }) {
  const { t } = useLanguage();
  return (
    <div className="traffic-section">
      <strong>{title}</strong>
      {truncated ? <Alert type="warning" showIcon title={t("traffic.headersTruncated", { reason: reason ? `: ${reason}` : "" })} /> : null}
      {headers?.length ? <div className="traffic-headers">{headers.map((header, index) => (
        <div key={`${header.ordinal}:${index}`}><span>{header.name}</span><code>{header.value}</code></div>
      ))}</div> : <span className="muted-line">{t("traffic.noHeaders")}</span>}
    </div>
  );
}

function BodySection({ side, exchange, state, onLoad }: { side: BodySide; exchange: TrafficExchange; state: BodyState; onLoad: () => void }) {
  const { t } = useLanguage();
  const [representation, setRepresentation] = useState<"text" | "base64" | "hex">("text");
  const ref = side === "request" ? exchange.request_body_ref : exchange.response_body_ref;
  const captureState = side === "request" ? exchange.request_capture_state : exchange.response_capture_state;
  const captured = side === "request" ? exchange.request_captured_bytes : exchange.response_captured_bytes;
  const observed = side === "request" ? exchange.request_observed_bytes : exchange.response_observed_bytes;
  const exchangeTruncated = side === "request" ? exchange.request_truncated : exchange.response_truncated;
  const reason = side === "request" ? exchange.request_truncation_reason : exchange.response_truncation_reason;
  const bodyLabel = t(side === "request" ? "traffic.requestBody" : "traffic.responseBody");
  const availability = bodyAvailability(t, ref, captureState, captured, observed, exchangeTruncated, reason);
  const decoded = state.value ? decodeBody(state.value.data) : undefined;
  const displayMode = representation === "text" && !decoded?.text ? "base64" : representation;

  return (
    <div className="traffic-section traffic-body-section">
      <div className="traffic-section-heading"><strong>{bodyLabel}</strong>{state.value ? (
        <Select size="small" aria-label={t("traffic.displayFormat", { side: bodyLabel })} value={displayMode} onChange={setRepresentation} options={[
          ...(decoded?.text ? [{ value: "text", label: decoded.json ? "Text / JSON" : "Text" }] : []),
          { value: "base64", label: "Base64" },
          { value: "hex", label: "Hex" }
        ]} />
      ) : null}</div>
      {!state.value ? <Alert type={availability.level} showIcon title={availability.message} /> : null}
      {state.loading ? <div className="traffic-body-loading"><Spin size="small" /> {t("traffic.loadingOnDemand")}</div> : null}
      {state.error ? <Alert type="warning" showIcon title={t("traffic.bodyReadFailed", { error: state.error })} /> : null}
      {!state.value && ref && !state.loading ? <Button size="small" onClick={onLoad}>{t("traffic.loadBody")}</Button> : null}
      {state.value ? (
        <>
          {state.value.truncated || exchangeTruncated ? <Alert type="warning" showIcon title={t("traffic.bodyTruncated", { reason: reason ? `: ${reason}` : "" })} /> : null}
          <pre className="traffic-body-pre">{renderBody(state.value.data, displayMode, decoded)}</pre>
        </>
      ) : null}
    </div>
  );
}

function ReplayEditor({ runtimeDir, exchange, user, requestBody, loadRequestBody, onReplayed }: {
  runtimeDir: string;
  exchange: TrafficExchange;
  user: AuthUser;
  requestBody?: TrafficHistoryBody;
  loadRequestBody: () => Promise<TrafficHistoryBody | undefined>;
  onReplayed: (exchangeId: number) => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [method, setMethod] = useState(exchange.method);
  const [url, setUrl] = useState(exchange.url);
  const [headers, setHeaders] = useState<EditableHeader[]>(() => editableHeaders(exchange.request_headers));
  const [bodyMode, setBodyMode] = useState<"utf8" | "base64">("utf8");
  const [body, setBody] = useState("");
  const [bodyOverride, setBodyOverride] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setOpen(false);
    setConfirmOpen(false);
    setMethod(exchange.method);
    setUrl(exchange.url);
    setHeaders(editableHeaders(exchange.request_headers));
    setBody("");
    setBodyMode("utf8");
    setBodyOverride(false);
    setError(undefined);
  }, [exchange.id]);

  const initialize = async () => {
    setOpen(true);
    setBodyOverride(false);
    const source = requestBody ?? (exchange.request_body_ref ? await loadRequestBody() : undefined);
    if (!source) return;
    const decoded = decodeBody(source.data);
    if (decoded.text !== undefined) {
      setBodyMode("utf8");
      setBody(decoded.text);
    } else {
      setBodyMode("base64");
      setBody(source.data);
    }
  };
  const target = safeTarget(url, t("traffic.invalidUrl"));
  const submit = async () => {
    setSending(true);
    setError(undefined);
    try {
      const encodedBody = bodyOverride
        ? bodyMode === "base64" ? normalizeBase64(body) : utf8ToBase64(body)
        : undefined;
      const replayHeaders = headers.map(({ name, value }, ordinal) => ({ name, value, ordinal }));
      const result = await replayTrafficExchange(exchange.id, {
        runtimeDir,
        method: method.trim(),
        url: url.trim(),
        ...(sameHeaders(replayHeaders, exchange.request_headers) ? {} : { headers: replayHeaders }),
        ...(encodedBody === undefined ? {} : { body: { encoding: "base64" as const, data: encodedBody } }),
        ...(exchange.route_ref ? { route_ref: exchange.route_ref } : {}),
        ...(exchange.session_ref ? { session_ref: exchange.session_ref } : {}),
        ...(exchange.task_ref ? { task_ref: exchange.task_ref } : {}),
        ...(exchange.run_ref ? { run_ref: exchange.run_ref } : {})
      });
      setConfirmOpen(false);
      setOpen(false);
      onReplayed(result.exchangeId);
    } catch (cause) {
      setConfirmOpen(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="traffic-section replay-editor">
      <strong>Replay</strong>
      {user.role !== "admin" ? <Alert type="info" showIcon title={t("traffic.replayAdminOnly")} /> : (
        <Button icon={<RotateCcw size={15} />} onClick={() => void initialize()}>{t("traffic.editReplay")}</Button>
      )}
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {open && user.role === "admin" ? (
        <div className="replay-form">
          <div className="replay-method-url"><Input aria-label={t("traffic.replayMethod")} value={method} onChange={(event) => setMethod(event.target.value)} /><Input aria-label={t("traffic.replayUrl")} value={url} onChange={(event) => setUrl(event.target.value)} /></div>
          <div className="replay-header-list">{headers.map((header, index) => (
            <div key={header.key}><Input aria-label={t("traffic.replayHeaderName", { value: index + 1 })} value={header.name} onChange={(event) => setHeaders((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} /><Input aria-label={t("traffic.replayHeaderValue", { value: index + 1 })} value={header.value} onChange={(event) => setHeaders((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} /><Button aria-label={t("traffic.deleteHeader", { value: index + 1 })} icon={<Trash2 size={14} />} onClick={() => setHeaders((current) => current.filter((_, itemIndex) => itemIndex !== index))} /></div>
          ))}</div>
          <Button size="small" icon={<Plus size={14} />} onClick={() => setHeaders((current) => [...current, { key: crypto.randomUUID(), name: "", value: "", ordinal: current.length }])}>{t("traffic.addHeader")}</Button>
          <Radio.Group value={bodyMode} onChange={(event) => setBodyMode(event.target.value)} options={[{ value: "utf8", label: "UTF-8" }, { value: "base64", label: "Base64" }]} />
          <Input.TextArea aria-label={t("traffic.replayBody")} rows={7} value={body} onChange={(event) => { setBody(event.target.value); setBodyOverride(true); }} />
          <span className="muted-line">{t(bodyOverride ? "traffic.editedBody" : "traffic.sourceBody")}</span>
          <Button type="primary" icon={<Send size={15} />} onClick={() => setConfirmOpen(true)}>{t("traffic.prepareSend")}</Button>
        </div>
      ) : null}
      <Modal title={t("traffic.confirmReplay")} open={confirmOpen} confirmLoading={sending} okText={t("traffic.confirmSend")} cancelText={t("common.cancel")} onOk={() => void submit()} onCancel={() => setConfirmOpen(false)}>
        <Alert type="warning" showIcon title={t("traffic.replayWarning")} description={t("traffic.replayWarningDescription")} />
        <Descriptions size="small" column={1} colon={false} items={[
          { key: "host", label: "Host", children: target.host },
          { key: "origin", label: "Origin", children: target.origin },
          { key: "method", label: "Method", children: method },
          { key: "headers", label: "Headers", children: t("traffic.headersCount", { value: headers.length }) },
          { key: "body", label: "Body", children: bodyOverride ? t("traffic.bodyOverride", { value: body.length, mode: bodyMode }) : t("traffic.fullSourceBody") }
        ]} />
      </Modal>
    </div>
  );
}

function ReferenceChain({ exchange, onSelectExchange }: { exchange: TrafficExchange; onSelectExchange: (id: number) => void }) {
  const { t } = useLanguage();
  const refs = [
    ["task", exchange.task_ref], ["run", exchange.run_ref], ["route", exchange.route_ref], ["session", exchange.session_ref],
    ["connect", exchange.connect_ref]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  return (
    <div className="traffic-section"><strong>{t("traffic.referenceChain")}</strong><Space size={[4, 4]} wrap>{refs.length ? refs.map(([label, value]) => <Tag key={`${label}:${value}`}>{label}: {shortRef(value, 28)}</Tag>) : <span className="muted-line">{t("traffic.noReferenceChain")}</span>}{exchange.replay_of ? <Button type="link" size="small" onClick={() => onSelectExchange(exchange.replay_of!)}>replay_of #{exchange.replay_of}</Button> : null}</Space></div>
  );
}

type Translate = ReturnType<typeof useLanguage>["t"];

function bodyAvailability(t: Translate, ref: string | undefined, state: string, captured: number, observed: number, truncated: boolean, reason?: string): { level: "info" | "warning"; message: string } {
  if (ref) return { level: truncated ? "warning" : "info", message: t("traffic.bodyAvailable") };
  if (state.toLowerCase().includes("evict")) return { level: "warning", message: t("traffic.bodyEvicted") };
  if (truncated || captured < observed) return { level: "warning", message: t("traffic.bodyUnavailableTruncated", { reason: reason ? `: ${reason}` : "" }) };
  if (observed === 0) return { level: "info", message: t("traffic.bodyNoBytes") };
  return { level: "warning", message: t("traffic.bodyNotCaptured", { state: state || "unknown" }) };
}

function modeDescription(exchange: TrafficExchange): React.ReactNode {
  const mode = exchange.mode.toLowerCase();
  const bestEffort = mode.includes("best") || exchange.quota_pressure || exchange.request_truncated || exchange.response_truncated || exchange.headers_truncated;
  return <Space size={4}><Tag>{formatTrafficMode(exchange.mode)}</Tag>{bestEffort ? <Tag color="warning">best-effort</Tag> : null}</Space>;
}

function editableHeaders(headers?: TrafficHeaderEntry[]): EditableHeader[] {
  return (headers ?? []).map((header, index) => ({ ...header, key: `${header.ordinal}:${index}:${header.name}` }));
}

function sameHeaders(current: TrafficHeaderEntry[], source?: TrafficHeaderEntry[]): boolean {
  const original = source ?? [];
  return current.length === original.length
    && current.every((header, index) => header.name === original[index].name && header.value === original[index].value);
}

function decodeBody(data: string): { bytes: Uint8Array; text?: string; json?: boolean } {
  let bytes: Uint8Array;
  try {
    const raw = atob(data);
    bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  } catch {
    return { bytes: new Uint8Array() };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let json = false;
    try { JSON.parse(text); json = true; } catch { json = false; }
    return { bytes, text, json };
  } catch {
    return { bytes };
  }
}

function renderBody(data: string, mode: "text" | "base64" | "hex", decoded = decodeBody(data)): string {
  if (mode === "base64") return data;
  if (mode === "hex") return Array.from(decoded.bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
  if (decoded.text === undefined) return data;
  if (decoded.json) {
    try { return JSON.stringify(JSON.parse(decoded.text), null, 2); } catch { return decoded.text; }
  }
  return decoded.text;
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function normalizeBase64(value: string): string {
  const normalized = value.replace(/\s+/g, "");
  atob(normalized);
  return normalized;
}

function safeTarget(value: string, invalidUrl: string): { host: string; origin: string } {
  try {
    const url = new URL(value);
    return { host: url.host, origin: url.origin };
  } catch {
    return { host: invalidUrl, origin: invalidUrl };
  }
}
