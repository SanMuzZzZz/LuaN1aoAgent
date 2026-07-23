import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Alert, Avatar, Badge, Button, Drawer, Dropdown, Input, Popconfirm, Skeleton, Spin, Statistic, Switch, Tag, Tooltip, Typography } from "antd";
import { Activity, ChevronDown, Database, FileBox, LogOut, Menu, PanelRight, Play, RefreshCw, Share2, Square } from "lucide-react";
import { stopRun } from "./api";
import { Inspector } from "./components/Inspector";
import { ConnectionsView } from "./components/ConnectionsView";
import { ResizableWorkspace } from "./components/ResizableWorkspace";
import { Sidebar } from "./components/Sidebar";
import { StartRunModal } from "./components/StartRunModal";
import { TraceView } from "./components/TraceView";
import { TrafficInspector } from "./components/TrafficInspector";
import { TrafficView } from "./components/TrafficView";
import { projectTaskTree } from "./graph";
import { useLanguage, type Locale, type TranslationKey } from "./language";
import type { AuthUser, TrafficExchange, ViewKey } from "./types";
import { graphLabel } from "./utils";
import { useRuntimeDashboard } from "./useRuntimeDashboard";

const GraphView = lazy(() => import("./components/GraphView").then((module) => ({ default: module.GraphView })));

const DEFAULT_RUNTIME = ".agent-runtime";

export default function App({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const { locale, t, toggleLocale, formatDate } = useLanguage();
  const initial = readInitialState();
  const [runtimeDir, setRuntimeDir] = useState(initial.runtimeDir);
  const [runtimeDraft, setRuntimeDraft] = useState(initial.runtimeDir);
  const [activeView, setActiveView] = useState<ViewKey>(initial.view);
  const [selectedTraceId, setSelectedTraceId] = useState<string>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [selectedExchangeId, setSelectedExchangeId] = useState<number>();
  const [selectedExchange, setSelectedExchange] = useState<TrafficExchange>();
  const [trafficRefreshToken, setTrafficRefreshToken] = useState(0);
  const [roleFilter, setRoleFilter] = useState("all");
  const [newestFirst, setNewestFirst] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [startRunOpen, setStartRunOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [pendingStartDir, setPendingStartDir] = useState<string>();
  const dashboard = useRuntimeDashboard(runtimeDir);
  const data = dashboard.data;

  useEffect(() => {
    if (!data?.traceItems.length) {
      setSelectedTraceId(undefined);
      return;
    }
    if (!selectedTraceId || !data.traceItems.some((item) => item.id === selectedTraceId)) {
      setSelectedTraceId(data.traceItems[0].id);
    }
  }, [data?.traceItems, selectedTraceId]);

  useEffect(() => {
    if (activeView === "trace" || activeView === "traffic" || activeView === "connections") setSelectedNodeId(undefined);
    if (activeView !== "traffic") {
      setSelectedExchangeId(undefined);
      setSelectedExchange(undefined);
    }
  }, [activeView]);

  const selectedTrace = data?.traceItems.find((item) => item.id === selectedTraceId);
  const runningNow = dashboard.activeRuns.some((run) => normalizeDir(run.runtimeDir) === normalizeDir(runtimeDir));
  // The server returns a canonical absolute path in data.runtimeDir, so compare
  // against the input form captured when the data was fetched instead.
  const dataMatchesDir = dashboard.loadedRuntimeDir !== undefined
    && normalizeDir(dashboard.loadedRuntimeDir) === normalizeDir(runtimeDir);
  // Runtime sidecar events (traffic proxy, lifecycle) arrive before the Planner
  // does anything; keep the initializing view until the first planner card exists.
  const hasPlannerTrace = dataMatchesDir && (data?.traceItems.some((item) => item.role === "planner") ?? false);
  const initializing = !hasPlannerTrace && !dashboard.error && (runningNow || pendingStartDir === runtimeDir);

  useEffect(() => {
    if (pendingStartDir && (pendingStartDir !== runtimeDir || hasPlannerTrace)) {
      setPendingStartDir(undefined);
    }
  }, [pendingStartDir, runtimeDir, hasPlannerTrace]);

  const sidebarSessions = useMemo(() => {
    const active = new Set(dashboard.activeRuns.map((run) => normalizeDir(run.runtimeDir)));
    if (!active.size) return dashboard.sessions;
    return dashboard.sessions.map((session) =>
      session.running || !active.has(normalizeDir(session.runtimeDir)) ? session : { ...session, running: true });
  }, [dashboard.activeRuns, dashboard.sessions]);
  const stopCurrentRun = async () => {
    setStopping(true);
    setActionError(undefined);
    try {
      await stopRun(runtimeDir);
      await dashboard.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStopping(false);
    }
  };
  const inspectorGraph = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    return activeView === "task" ? projectTaskTree(data.graph.nodes, data.graph.edges) : data.graph;
  }, [activeView, data]);
  const selectedNode = inspectorGraph.nodes.find((node) => node.id === selectedNodeId);
  const linkedNodeIds = selectedTrace?.graphNodeRefs || [];

  const setView = (view: ViewKey) => {
    setActiveView(view);
    setMobileSidebarOpen(false);
    updateUrl(runtimeDir, view);
  };
  const applyRuntime = (value = runtimeDraft) => {
    const next = value.trim() || DEFAULT_RUNTIME;
    setRuntimeDraft(next);
    setRuntimeDir(next);
    setSelectedTraceId(undefined);
    setSelectedNodeId(undefined);
    setSelectedExchangeId(undefined);
    setSelectedExchange(undefined);
    setMobileSidebarOpen(false);
    localStorage.setItem("luanniao-runtime-dir", next);
    updateUrl(next, activeView);
  };

  const sidebar = (
    <Sidebar
      activeView={activeView}
      runtimeDir={runtimeDir}
      sessions={sidebarSessions}
      agents={data?.overview.agents || {}}
      onViewChange={setView}
      onRuntimeChange={(value) => { setRuntimeDraft(value); applyRuntime(value); }}
      onClose={mobileSidebarOpen ? () => setMobileSidebarOpen(false) : undefined}
    />
  );
  const inspector = activeView === "traffic" ? (
    <TrafficInspector
      key={`${runtimeDir}:${selectedExchange?.id ?? "none"}`}
      runtimeDir={runtimeDir}
      exchange={selectedExchange}
      user={user}
      onSelectExchange={setSelectedExchangeId}
      onReplayed={(exchangeId) => {
        setSelectedExchangeId(exchangeId);
        setTrafficRefreshToken((value) => value + 1);
        setMobileInspectorOpen(true);
      }}
    />
  ) : activeView === "connections" ? (
    <div className="connections-inspector">
      <Typography.Title level={5}>{t("app.connectionsInspectorTitle")}</Typography.Title>
      <p>{t("app.connectionsInspectorDescription")}</p>
    </div>
  ) : (
    <Inspector
      view={activeView}
      runtimeDir={runtimeDir}
      trace={selectedTrace}
      node={selectedNode}
      edges={inspectorGraph.edges}
      artifacts={data?.artifacts.records || []}
      tasks={data?.overview.tasks.items || []}
      agents={data?.overview.agents || {}}
    />
  );

  const viewEyebrow = activeView === "trace" ? "LIVE TRACE" : activeView === "traffic" ? "WEB TRAFFIC" : activeView === "connections" ? "CONNECTIVITY" : "TRI-GRAPH";

  return (
    <>
      <ResizableWorkspace
        sidebar={sidebar}
        inspector={inspector}
        main={(
          <div className="app-main">
          <header className="topbar">
            <div className="topbar-title">
              <Tooltip title={t("nav.open")}><Button className="mobile-only" icon={<Menu size={18} />} onClick={() => setMobileSidebarOpen(true)} aria-label={t("nav.open")} /></Tooltip>
              <div>
                <span>{viewEyebrow}</span>
                <Typography.Title level={3}>{viewTitle(activeView, locale, t)}</Typography.Title>
              </div>
            </div>
            <div className="runtime-controls">
              <Input value={runtimeDraft} onChange={(event) => setRuntimeDraft(event.target.value)} onPressEnter={() => applyRuntime()} prefix={<Database size={15} />} aria-label={t("app.runtimeDirectory")} />
              <Button className="runtime-load-button" onClick={() => applyRuntime()}>{t("common.load")}</Button>
              <Tooltip title={t("app.startTask")}><Button icon={<Play size={16} />} onClick={() => setStartRunOpen(true)}>{t("app.startTask")}</Button></Tooltip>
              {runningNow ? (
                <Popconfirm
                  title={t("app.stopConfirm")}
                  description={t("app.stopDescription")}
                  okText={t("common.stop")}
                  cancelText={t("common.cancel")}
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void stopCurrentRun()}
                >
                  <Button danger loading={stopping} icon={<Square size={15} />}>{t("common.stop")}</Button>
                </Popconfirm>
              ) : null}
              <Tooltip title={t("app.refreshRuntime")}><Button type="primary" icon={<RefreshCw className={dashboard.refreshing ? "spin" : ""} size={16} />} onClick={() => void dashboard.refresh()} aria-label={t("app.refreshRuntime")} /></Tooltip>
              <label className="auto-refresh"><Switch size="small" checked={dashboard.autoRefresh} onChange={dashboard.setAutoRefresh} /><span>{t("app.autoRefresh")}</span></label>
              <Tooltip title={t("app.openInspector")}><Button className="inspector-trigger" icon={<PanelRight size={18} />} onClick={() => setMobileInspectorOpen(true)} aria-label={t("app.openInspector")} /></Tooltip>
              <Dropdown
                trigger={["click"]}
                menu={{
                  items: [
                    { key: "identity", disabled: true, label: <div className="user-menu-identity"><strong>{user.displayName}</strong><span>@{user.username} · {user.role === "admin" ? t("app.administrator") : t("app.analyst")}</span></div> },
                    { type: "divider" },
                    { key: "language", label: locale === "zh-CN" ? t("language.english") : t("language.chinese"), title: locale === "zh-CN" ? t("language.switchToEnglish") : t("language.switchToChinese") },
                    { type: "divider" },
                    { key: "logout", danger: true, icon: <LogOut size={15} />, label: t("app.logout") }
                  ],
                  onClick: ({ key }) => {
                    if (key === "language") toggleLocale();
                    if (key === "logout") void onLogout();
                  }
                }}
              >
                <Button className="user-menu-button" aria-label={t("app.userMenu")}>
                  <Avatar size={24}>{user.displayName.slice(0, 1).toUpperCase()}</Avatar>
                  <span>{user.displayName}</span>
                  <ChevronDown size={14} />
                </Button>
              </Dropdown>
            </div>
          </header>

          <main className="content-area">
            {dashboard.error ? <Alert closable type="error" showIcon message={dashboard.error} /> : null}
            {actionError ? <Alert closable type="error" showIcon message={actionError} onClose={() => setActionError(undefined)} /> : null}
            <section className="mission-band">
              <div className="mission-copy">
                <span>{t("app.currentGoal")}</span>
                <Typography.Title level={4}>{data?.overview.goal?.label || (initializing ? t("app.initializingGoal") : t("app.waitingRuntime"))}</Typography.Title>
                <p>{String(data?.overview.scope?.summary || data?.overview.scope?.label || t("app.scopeFallback"))}</p>
              </div>
              <div className="metric-strip">
                <Metric icon={<Activity size={16} />} label={t("metric.trace")} value={data?.overview.events.count || 0} />
                <Metric icon={<Share2 size={16} />} label={t("metric.nodes")} value={data?.overview.graph.nodeCount || 0} />
                <Metric icon={<GitEdgeIcon />} label={t("metric.edges")} value={data?.overview.graph.edgeCount || 0} />
                <Metric icon={<FileBox size={16} />} label={t("metric.artifacts")} value={data?.overview.artifacts.count || 0} />
              </div>
            </section>

            <section className="stage-heading">
              <div>
                <Typography.Title level={4}>{viewStageTitle(activeView, locale, t)}</Typography.Title>
                <p>{viewStageSubtitle(activeView, t)}</p>
              </div>
              <div className="stage-meta">
                {runningNow ? <Badge status="processing" text={t("app.running")} /> : null}
                <Tag>{data?.graph.source || "source: -"}</Tag><span>{data?.loadedAt ? t("app.updatedAt", { time: formatDate(data.loadedAt) }) : t("app.notLoaded")}</span>
              </div>
            </section>

            <section className="stage-body">
              {activeView === "connections" ? (
                <ConnectionsView runtimeDir={runtimeDir} user={user} />
              ) : activeView === "traffic" ? (
                <TrafficView
                  runtimeDir={runtimeDir}
                  selectedExchangeId={selectedExchangeId}
                  refreshToken={trafficRefreshToken}
                  onSelectExchange={setSelectedExchangeId}
                  onExchangeLoaded={setSelectedExchange}
                />
              ) : dashboard.loading && !data ? <Skeleton active paragraph={{ rows: 10 }} /> : initializing ? (
                <RunInitializing goal={dataMatchesDir ? data?.overview.goal?.label : undefined} />
              ) : activeView === "trace" ? (
                <TraceView
                  items={data?.traceItems || []}
                  selectedTraceId={selectedTraceId}
                  roleFilter={roleFilter}
                  newestFirst={newestFirst}
                  onRoleFilterChange={setRoleFilter}
                  onOrderChange={() => setNewestFirst((value) => !value)}
                  onSelectTrace={setSelectedTraceId}
                />
              ) : (
                <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
                  <GraphView
                    runtimeDir={runtimeDir}
                    kind={activeView}
                    nodes={data?.graph.nodes || []}
                    edges={data?.graph.edges || []}
                    selectedNodeId={selectedNodeId}
                    linkedNodeIds={linkedNodeIds}
                    onSelectNode={setSelectedNodeId}
                  />
                </Suspense>
              )}
            </section>
          </main>
          </div>
        )}
      />

      <Drawer placement="left" width={286} open={mobileSidebarOpen} onClose={() => setMobileSidebarOpen(false)} closable={false} styles={{ body: { padding: 0 } }}>{sidebar}</Drawer>
      <Drawer placement="right" width={380} open={mobileInspectorOpen} onClose={() => setMobileInspectorOpen(false)} title={t("app.inspectorDrawer")}>{inspector}</Drawer>
      <StartRunModal
        open={startRunOpen}
        onClose={() => setStartRunOpen(false)}
        onStarted={(dir) => {
          setStartRunOpen(false);
          setPendingStartDir(dir);
          applyRuntime(dir);
        }}
      />
    </>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return <div className="metric-item"><span>{icon}{label}</span><Statistic value={value} /></div>;
}

function RunInitializing({ goal }: { goal?: string }) {
  const { t } = useLanguage();
  return (
    <div className="run-initializing">
      <Spin size="large" />
      <Typography.Title level={4}>{t("app.initializingTitle")}</Typography.Title>
      <p>{goal || t("app.initializingDescription")}</p>
      <span className="run-initializing-hint">{t("app.initializingHint")}</span>
    </div>
  );
}

function GitEdgeIcon() {
  return <Share2 size={16} />;
}

type Translate = (key: TranslationKey, variables?: Record<string, string | number>) => string;

function viewTitle(view: ViewKey, locale: Locale, t: Translate): string {
  if (view === "trace") return t("app.traceTitle");
  if (view === "traffic") return "Web Traffic";
  if (view === "connections") return "Connections";
  return graphLabel(view, locale);
}

function viewStageTitle(view: ViewKey, locale: Locale, t: Translate): string {
  if (view === "trace") return t("app.traceStageTitle");
  if (view === "traffic") return t("app.trafficStageTitle");
  if (view === "connections") return t("app.connectionsStageTitle");
  return graphLabel(view, locale);
}

function viewStageSubtitle(view: ViewKey, t: Translate): string {
  if (view === "trace") return t("app.traceStageSubtitle");
  if (view === "traffic") return t("app.trafficStageSubtitle");
  if (view === "connections") return t("app.connectionsStageSubtitle");
  if (view === "reasoning") return t("graph.reasoningSubtitle");
  if (view === "operation") return t("graph.operationSubtitle");
  return t("graph.taskSubtitle");
}

function readInitialState(): { runtimeDir: string; view: ViewKey } {
  const params = new URLSearchParams(window.location.search);
  const runtimeDir = params.get("runtimeDir") || localStorage.getItem("luanniao-runtime-dir") || DEFAULT_RUNTIME;
  const candidate = params.get("view");
  const view = candidate && ["trace", "reasoning", "operation", "task", "traffic", "connections"].includes(candidate) ? candidate as ViewKey : "trace";
  return { runtimeDir, view };
}

function updateUrl(runtimeDir: string, view: ViewKey) {
  const url = new URL(window.location.href);
  url.searchParams.set("runtimeDir", runtimeDir);
  url.searchParams.set("view", view);
  window.history.replaceState({}, "", url);
}

function normalizeDir(value: string): string {
  return value.replace(/\/+$/, "") || ".agent-runtime";
}
