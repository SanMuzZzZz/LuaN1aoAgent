import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Empty, Space, Tag, Tooltip, Typography } from "antd";
import { ExternalLink, Pause, Play, RefreshCw, XCircle } from "lucide-react";
import { fetchConnections, mutateConnection } from "../api";
import { useLanguage } from "../language";
import type { AuthUser, ConnectionItem } from "../types";
import { statusLabel } from "../utils";

export function ConnectionsView({ runtimeDir, user }: { runtimeDir: string; user: AuthUser }) {
  const { locale, t, formatRelative } = useLanguage();
  const [items, setItems] = useState<ConnectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [mutating, setMutating] = useState<string>();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(undefined);
    setItems([]);
    try {
      const response = await fetchConnections(runtimeDir, signal);
      if (!signal?.aborted) setItems(response.connections);
    } catch (cause) {
      if (!signal?.aborted) {
        setItems([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [runtimeDir]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const changeState = async (item: ConnectionItem, action: "start" | "stop" | "close") => {
    setMutating(`${item.id}:${action}`);
    setError(undefined);
    try {
      const updated = await mutateConnection(runtimeDir, item.id, action);
      setItems((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(undefined);
    }
  };

  return (
    <div className="connections-view">
      <div className="connections-toolbar">
        <div>
          <Typography.Title level={5}>{t("nav.connections")}</Typography.Title>
          <span>{t("connections.description")}</span>
        </div>
        <Button icon={<RefreshCw size={15} />} loading={loading} onClick={() => void load()}>{t("common.refresh")}</Button>
      </div>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {!loading && !items.length ? <Empty description={t("connections.empty")} /> : null}
      <div className="connection-grid">
        {items.map((item) => (
          <Card key={item.id} className="connection-card" size="small">
            <div className="connection-card-heading">
              <div><Typography.Text strong>{item.externalId}</Typography.Text><span>{item.kind}</span></div>
              <Badge status={statusBadge(item.observedState)} text={statusLabel(item.observedState, locale)} />
            </div>
            <div className="connection-tags">
              <Tag>{item.direction}</Tag><Tag>{item.transport}</Tag>
              <Tag color={item.managed ? "blue" : "default"}>{t(item.managed ? "connections.managed" : "connections.unmanaged")}</Tag>
              <Tag>{t("connections.desired")}: {statusLabel(item.desiredState, locale)}</Tag>
              <Tag color={item.available ? "green" : "default"}>{t(item.available ? "connections.available" : "connections.unavailable")}</Tag>
            </div>
            <dl className="connection-facts">
              <div><dt>{t("connections.heartbeat")}</dt><dd>{formatRelative(item.lastHeartbeat)}</dd></div>
              <div><dt>{t("connections.error")}</dt><dd>{item.error || "—"}</dd></div>
            </dl>
            <Space wrap>
              {user.role === "admin" && item.managed && item.desiredState !== "closed" ? (
                <>
                  <Button size="small" icon={<Play size={14} />} loading={mutating === `${item.id}:start`} disabled={item.desiredState === "running" && item.observedState === "live"} onClick={() => void changeState(item, "start")}>{t("common.start")}</Button>
                  <Button size="small" icon={<Pause size={14} />} loading={mutating === `${item.id}:stop`} disabled={item.desiredState === "stopped"} onClick={() => void changeState(item, "stop")}>{t("common.stop")}</Button>
                  <Button size="small" danger icon={<XCircle size={14} />} loading={mutating === `${item.id}:close`} onClick={() => void changeState(item, "close")}>{t("common.close")}</Button>
                </>
              ) : null}
              {item.graphUrl ? <Tooltip title={t("connections.viewGraph")}><Button size="small" href={item.graphUrl} icon={<ExternalLink size={14} />}>{t("connections.graph")}</Button></Tooltip> : null}
            </Space>
          </Card>
        ))}
      </div>
    </div>
  );
}

function statusBadge(status: ConnectionItem["observedState"]): "success" | "processing" | "warning" | "error" | "default" {
  if (status === "live") return "success";
  if (status === "degraded") return "error";
  if (status === "stale") return "warning";
  return "default";
}
