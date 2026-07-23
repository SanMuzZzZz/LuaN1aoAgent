import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Input, InputNumber, Select, Skeleton, Tag } from "antd";
import { ChevronLeft, ChevronRight, Filter, RefreshCw } from "lucide-react";
import { fetchTrafficExchange, fetchTrafficHistory } from "../api";
import { useLanguage } from "../language";
import type { TrafficExchange, TrafficHistoryFilters } from "../types";
import { formatTime } from "../utils";

interface TrafficViewProps {
  runtimeDir: string;
  selectedExchangeId?: number;
  refreshToken?: number;
  onSelectExchange: (exchangeId: number | undefined) => void;
  onExchangeLoaded: (exchange: TrafficExchange | undefined) => void;
}

const PAGE_SIZE = 50;

export function TrafficView(props: TrafficViewProps) {
  const { t } = useLanguage();
  const [items, setItems] = useState<TrafficExchange[]>([]);
  const [filters, setFilters] = useState<TrafficHistoryFilters>({});
  const [draft, setDraft] = useState<TrafficHistoryFilters>({});
  const [cursor, setCursor] = useState<string>();
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setCursor(undefined);
    setCursorStack([]);
    setFilters({});
    setDraft({});
    props.onSelectExchange(undefined);
    props.onExchangeLoaded(undefined);
  }, [props.runtimeDir]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setItems([]);
    setHasMore(false);
    setNextCursor(undefined);
    props.onSelectExchange(undefined);
    props.onExchangeLoaded(undefined);
    fetchTrafficHistory(props.runtimeDir, { cursor, limit: PAGE_SIZE, filters }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems(page.items);
        setHasMore(page.has_more);
        setNextCursor(page.next_cursor);
        if (page.items[0]) props.onSelectExchange(page.items[0].id);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setItems([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [props.runtimeDir, cursor, filters, reload, props.refreshToken]);

  useEffect(() => {
    props.onExchangeLoaded(undefined);
    if (props.selectedExchangeId === undefined || !items.some((item) => item.id === props.selectedExchangeId)) return;
    const controller = new AbortController();
    fetchTrafficExchange(props.runtimeDir, props.selectedExchangeId, controller.signal)
      .then((exchange) => { if (!controller.signal.aborted) props.onExchangeLoaded(exchange); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        props.onExchangeLoaded(undefined);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [props.runtimeDir, props.selectedExchangeId, props.refreshToken, items]);

  const activeFilterCount = useMemo(() => Object.values(filters).filter((value) => value !== undefined && value !== "").length, [filters]);
  const applyFilters = () => {
    setFilters({ ...draft });
    setCursor(undefined);
    setCursorStack([]);
    props.onSelectExchange(undefined);
  };
  const clearFilters = () => {
    setDraft({});
    setFilters({});
    setCursor(undefined);
    setCursorStack([]);
    props.onSelectExchange(undefined);
  };
  const goNext = () => {
    if (!nextCursor) return;
    setCursorStack((current) => [...current, cursor]);
    setCursor(nextCursor);
  };
  const goPrevious = () => {
    const previous = cursorStack[cursorStack.length - 1];
    setCursorStack((current) => current.slice(0, -1));
    setCursor(previous);
  };

  return (
    <div className="traffic-view">
      <div className="traffic-toolbar" aria-label={t("traffic.filters")}>
        <Input aria-label={t("traffic.methodFilter")} placeholder="Method" value={draft.method} onChange={(event) => setDraft((value) => ({ ...value, method: event.target.value }))} />
        <Input aria-label={t("traffic.hostFilter")} placeholder="Host" value={draft.host} onChange={(event) => setDraft((value) => ({ ...value, host: event.target.value }))} />
        <InputNumber aria-label={t("traffic.statusFilter")} placeholder="Status" min={0} max={999} value={draft.status} onChange={(value) => setDraft((current) => ({ ...current, status: value ?? undefined }))} />
        <Input aria-label={t("traffic.taskRefFilter")} placeholder="Task ref" value={draft.task_ref} onChange={(event) => setDraft((value) => ({ ...value, task_ref: event.target.value }))} />
        <Input aria-label={t("traffic.runRefFilter")} placeholder="Run ref" value={draft.run_ref} onChange={(event) => setDraft((value) => ({ ...value, run_ref: event.target.value }))} />
        <Select aria-label={t("traffic.modeFilter")} placeholder="Mode" allowClear value={draft.mode} options={[{ value: "mitm", label: "MITM" }, { value: "passthrough", label: "Passthrough" }, { value: "forward", label: "Forward" }, { value: "replay", label: "Replay" }]} onChange={(value) => setDraft((current) => ({ ...current, mode: value }))} />
        <Select aria-label={t("traffic.errorFilter")} placeholder="Error" allowClear value={draft.error} options={[{ value: "true", label: t("traffic.onlyErrors") }, { value: "false", label: t("traffic.noErrors") }]} onChange={(value) => setDraft((current) => ({ ...current, error: value }))} />
        <Button icon={<Filter size={15} />} type="primary" onClick={applyFilters}>{t("common.apply")}{activeFilterCount ? ` (${activeFilterCount})` : ""}</Button>
        <Button onClick={clearFilters}>{t("common.clear")}</Button>
        <Button aria-label={t("traffic.refresh")} icon={<RefreshCw size={15} />} onClick={() => setReload((value) => value + 1)} />
      </div>
      {error ? <Alert type="error" showIcon closable title={error} onClose={() => setError(undefined)} /> : null}
      <div className="traffic-list">
        {loading ? <Skeleton active paragraph={{ rows: 9 }} /> : items.length ? items.map((exchange) => (
          <TrafficRow key={exchange.id} exchange={exchange} selected={props.selectedExchangeId === exchange.id} onSelect={() => props.onSelectExchange(exchange.id)} />
        )) : <Empty description={t("traffic.empty")} />}
      </div>
      <div className="traffic-pagination">
        <span>{t("traffic.pageSize", { value: PAGE_SIZE })}</span>
        <Button icon={<ChevronLeft size={15} />} disabled={!cursorStack.length} onClick={goPrevious}>{t("common.previous")}</Button>
        <Button icon={<ChevronRight size={15} />} iconPlacement="end" disabled={!hasMore || !nextCursor} onClick={goNext}>{t("common.next")}</Button>
      </div>
    </div>
  );
}

function TrafficRow({ exchange, selected, onSelect }: { exchange: TrafficExchange; selected: boolean; onSelect: () => void }) {
  const { t, formatBytes: formatLocalizedBytes, formatDuration: formatLocalizedDuration } = useLanguage();
  const mode = exchange.mode.toLowerCase();
  const bestEffort = mode.includes("best") || exchange.quota_pressure || exchange.request_truncated || exchange.response_truncated || exchange.headers_truncated;
  return (
    <button className={`traffic-row${selected ? " selected" : ""}`} type="button" onClick={onSelect} aria-label={t("traffic.selectExchange", { value: exchange.id })}>
      <div className="traffic-row-primary">
        <Tag color={methodColor(exchange.method)}>{exchange.method}</Tag>
        <strong>{exchange.host || t("traffic.unknownHost")}</strong>
        <Tag color={exchange.status >= 500 || exchange.error ? "error" : exchange.status >= 400 ? "warning" : "success"}>{exchange.status || "-"}</Tag>
        <code>#{exchange.id}</code>
      </div>
      <div className="traffic-row-url">{exchange.url}</div>
      <div className="traffic-row-meta">
        <span>{formatTime(exchange.started_at)} → {formatTime(exchange.completed_at)} · {formatLocalizedDuration(exchange.duration_ms)}</span>
        <span>{t("traffic.requestObserved", { captured: formatLocalizedBytes(exchange.request_captured_bytes), observed: formatLocalizedBytes(exchange.request_observed_bytes) })}</span>
        <span>{t("traffic.responseObserved", { captured: formatLocalizedBytes(exchange.response_captured_bytes), observed: formatLocalizedBytes(exchange.response_observed_bytes) })}</span>
      </div>
      <div className="traffic-row-flags">
        <Tag>{formatTrafficMode(exchange.mode)}</Tag>
        {bestEffort ? <Tag color="warning">best-effort</Tag> : null}
        {exchange.request_truncated || exchange.response_truncated || exchange.headers_truncated ? <Tag color="warning">truncated</Tag> : null}
        {exchange.error ? <Tag color="error">{exchange.error_code || "error"}</Tag> : null}
      </div>
    </button>
  );
}

function methodColor(method: string): string {
  if (method === "GET") return "blue";
  if (method === "POST") return "green";
  if (["PUT", "PATCH"].includes(method)) return "orange";
  if (method === "DELETE") return "red";
  return "default";
}

export function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function formatTrafficMode(value: string): string {
  const mode = value.toLowerCase();
  if (mode.includes("mitm")) return "MITM";
  if (mode.includes("passthrough")) return "Passthrough";
  if (mode === "replay") return "Replay";
  if (mode === "forward") return "Forward";
  return value || "Unknown";
}

function formatDuration(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
}
