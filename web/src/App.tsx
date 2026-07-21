import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Alert, Avatar, Badge, Button, ConfigProvider, Drawer, Dropdown, Input, Popconfirm, Skeleton, Spin, Statistic, Switch, Tag, Tooltip, Typography } from "antd";
import { Activity, ChevronDown, Database, FileBox, LogOut, Menu, PanelRight, Play, RefreshCw, Share2, Square } from "lucide-react";
import { stopRun } from "./api";
import { Inspector } from "./components/Inspector";
import { ResizableWorkspace } from "./components/ResizableWorkspace";
import { Sidebar } from "./components/Sidebar";
import { StartRunModal } from "./components/StartRunModal";
import { TraceView } from "./components/TraceView";
import { projectTaskTree } from "./graph";
import type { AuthUser, GraphKind, ViewKey } from "./types";
import { GRAPH_LABELS, graphSubtitle, formatTime } from "./utils";
import { useRuntimeDashboard } from "./useRuntimeDashboard";

const GraphView = lazy(() => import("./components/GraphView").then((module) => ({ default: module.GraphView })));

const DEFAULT_RUNTIME = ".agent-runtime";

export default function App({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const initial = readInitialState();
  const [runtimeDir, setRuntimeDir] = useState(initial.runtimeDir);
  const [runtimeDraft, setRuntimeDraft] = useState(initial.runtimeDir);
  const [activeView, setActiveView] = useState<ViewKey>(initial.view);
  const [selectedTraceId, setSelectedTraceId] = useState<string>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
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
    if (activeView === "trace") setSelectedNodeId(undefined);
  }, [activeView]);

  const selectedTrace = data?.traceItems.find((item) => item.id === selectedTraceId);
  const runningNow = dashboard.activeRuns.some((run) => normalizeDir(run.runtimeDir) === normalizeDir(runtimeDir));
  const dataMatchesDir = data ? normalizeDir(String(data.runtimeDir)) === normalizeDir(runtimeDir) : false;
  const hasEvents = dataMatchesDir && (data?.overview.events.count ?? 0) > 0;
  const initializing = !hasEvents && !dashboard.error && (runningNow || pendingStartDir === runtimeDir);

  useEffect(() => {
    if (pendingStartDir && (pendingStartDir !== runtimeDir || hasEvents)) {
      setPendingStartDir(undefined);
    }
  }, [pendingStartDir, runtimeDir, hasEvents]);

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
  const inspector = (
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

  return (
    <ConfigProvider theme={appTheme}>
      <ResizableWorkspace
        sidebar={sidebar}
        inspector={inspector}
        main={(
          <div className="app-main">
          <header className="topbar">
            <div className="topbar-title">
              <Tooltip title="打开导航"><Button className="mobile-only" icon={<Menu size={18} />} onClick={() => setMobileSidebarOpen(true)} aria-label="打开导航" /></Tooltip>
              <div>
                <span>{activeView === "trace" ? "LIVE TRACE" : "TRI-GRAPH"}</span>
                <Typography.Title level={3}>{activeView === "trace" ? "Agent 运行轨迹" : GRAPH_LABELS[activeView as GraphKind]}</Typography.Title>
              </div>
            </div>
            <div className="runtime-controls">
              <Input value={runtimeDraft} onChange={(event) => setRuntimeDraft(event.target.value)} onPressEnter={() => applyRuntime()} prefix={<Database size={15} />} aria-label="Runtime 目录" />
              <Button className="runtime-load-button" onClick={() => applyRuntime()}>载入</Button>
              <Tooltip title="启动新任务"><Button icon={<Play size={16} />} onClick={() => setStartRunOpen(true)}>启动任务</Button></Tooltip>
              {runningNow ? (
                <Popconfirm
                  title="停止当前任务？"
                  description="将优雅中断该 run，已产出的数据会保留。"
                  okText="停止"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void stopCurrentRun()}
                >
                  <Button danger loading={stopping} icon={<Square size={15} />}>停止</Button>
                </Popconfirm>
              ) : null}
              <Tooltip title="刷新运行态"><Button type="primary" icon={<RefreshCw className={dashboard.refreshing ? "spin" : ""} size={16} />} onClick={() => void dashboard.refresh()} aria-label="刷新运行态" /></Tooltip>
              <label className="auto-refresh"><Switch size="small" checked={dashboard.autoRefresh} onChange={dashboard.setAutoRefresh} /><span>自动刷新</span></label>
              <Tooltip title="打开详情"><Button className="inspector-trigger" icon={<PanelRight size={18} />} onClick={() => setMobileInspectorOpen(true)} aria-label="打开详情" /></Tooltip>
              <Dropdown
                trigger={["click"]}
                menu={{
                  items: [
                    { key: "identity", disabled: true, label: <div className="user-menu-identity"><strong>{user.displayName}</strong><span>@{user.username} · {user.role === "admin" ? "管理员" : "分析员"}</span></div> },
                    { type: "divider" },
                    { key: "logout", danger: true, icon: <LogOut size={15} />, label: "退出登录" }
                  ],
                  onClick: ({ key }) => { if (key === "logout") void onLogout(); }
                }}
              >
                <Button className="user-menu-button" aria-label="用户菜单">
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
                <span>当前目标</span>
                <Typography.Title level={4}>{data?.overview.goal?.label || (initializing ? "任务启动中…" : "等待运行态数据")}</Typography.Title>
                <p>{String(data?.overview.scope?.summary || data?.overview.scope?.label || "加载 Runtime 后展示目标、范围与当前执行状态。")}</p>
              </div>
              <div className="metric-strip">
                <Metric icon={<Activity size={16} />} label="Trace" value={data?.overview.events.count || 0} />
                <Metric icon={<Share2 size={16} />} label="Nodes" value={data?.overview.graph.nodeCount || 0} />
                <Metric icon={<GitEdgeIcon />} label="Edges" value={data?.overview.graph.edgeCount || 0} />
                <Metric icon={<FileBox size={16} />} label="Artifacts" value={data?.overview.artifacts.count || 0} />
              </div>
            </section>

            <section className="stage-heading">
              <div>
                <Typography.Title level={4}>{activeView === "trace" ? "Agent 正在判断什么、执行什么、观察到什么" : GRAPH_LABELS[activeView as GraphKind]}</Typography.Title>
                <p>{activeView === "trace" ? "选择任意事件，在右侧查看证据、Artifact、图引用与原始载荷。" : graphSubtitle(activeView as GraphKind)}</p>
              </div>
              <div className="stage-meta">
                {runningNow ? <Badge status="processing" text="运行中" /> : null}
                <Tag>{data?.graph.source || "source: -"}</Tag><span>{data?.loadedAt ? `更新于 ${formatTime(data.loadedAt)}` : "尚未加载"}</span>
              </div>
            </section>

            <section className="stage-body">
              {dashboard.loading && !data ? <Skeleton active paragraph={{ rows: 10 }} /> : initializing ? (
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
      <Drawer placement="right" width={380} open={mobileInspectorOpen} onClose={() => setMobileInspectorOpen(false)} title="详情检查器">{inspector}</Drawer>
      <StartRunModal
        open={startRunOpen}
        onClose={() => setStartRunOpen(false)}
        onStarted={(dir) => {
          setStartRunOpen(false);
          setPendingStartDir(dir);
          applyRuntime(dir);
        }}
      />
    </ConfigProvider>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return <div className="metric-item"><span>{icon}{label}</span><Statistic value={value} /></div>;
}

function RunInitializing({ goal }: { goal?: string }) {
  return (
    <div className="run-initializing">
      <Spin size="large" />
      <Typography.Title level={4}>任务已启动，正在初始化</Typography.Title>
      <p>{goal || "Planner 正在进行首次规划，通常需要 30~90 秒。"}</p>
      <span className="run-initializing-hint">产生执行事件后会自动出现在这里；页面每 5 秒自动刷新，无需手动操作。若长时间无事件，请检查 LLM 服务是否可用。</span>
    </div>
  );
}

function GitEdgeIcon() {
  return <Share2 size={16} />;
}

function readInitialState(): { runtimeDir: string; view: ViewKey } {
  const params = new URLSearchParams(window.location.search);
  const runtimeDir = params.get("runtimeDir") || localStorage.getItem("luanniao-runtime-dir") || DEFAULT_RUNTIME;
  const candidate = params.get("view");
  const view = candidate && ["trace", "reasoning", "operation", "task"].includes(candidate) ? candidate as ViewKey : "trace";
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

export const appTheme = {
  token: {
    colorPrimary: "#2563eb",
    colorInfo: "#2563eb",
    colorBgLayout: "#f5f7fb",
    colorBgContainer: "#ffffff",
    colorText: "#172033",
    colorTextSecondary: "#657187",
    colorBorder: "#dfe5ee",
    borderRadius: 8,
    fontFamily: '"Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  },
  components: {
    Button: { controlHeight: 34 },
    Input: { controlHeight: 34 },
    Menu: { itemBorderRadius: 5, itemHeight: 42, itemMarginInline: 10 }
  }
};
