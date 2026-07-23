import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Empty, Menu, Tooltip } from "antd";
import { Activity, BrainCircuit, Cable, ChevronRight, Folder, FolderOpen, GitBranch, ListTree, Network, PanelLeftClose } from "lucide-react";
import { useLanguage } from "../language";
import { buildSessionTree, sessionRelativePath, type SessionFolderNode } from "../sessions";
import type { AgentEvent, RuntimeSession, ViewKey } from "../types";
import { formatRelative, isRecent, roleLabel, shortRef } from "../utils";

interface SidebarProps {
  activeView: ViewKey;
  runtimeDir: string;
  sessions: RuntimeSession[];
  agents: Record<string, AgentEvent | undefined>;
  onViewChange: (view: ViewKey) => void;
  onRuntimeChange: (runtimeDir: string) => void;
  onClose?: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { t, formatRelative } = useLanguage();
  const sessionTree = useMemo(() => buildSessionTree(props.sessions), [props.sessions]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const viewItems = [
    { key: "trace", icon: <Activity size={17} />, label: t("nav.trace") },
    { key: "traffic", icon: <Network size={17} />, label: t("nav.traffic") },
    { key: "connections", icon: <Cable size={17} />, label: t("nav.connections") },
    { key: "reasoning", icon: <BrainCircuit size={17} />, label: t("nav.reasoning") },
    { key: "operation", icon: <GitBranch size={17} />, label: t("nav.operation") },
    { key: "task", icon: <ListTree size={17} />, label: t("nav.task") }
  ];

  useEffect(() => {
    const activeSession = props.sessions.find((session) => normalize(session.runtimeDir) === normalize(props.runtimeDir));
    const activeRelativePath = activeSession ? sessionRelativePath(activeSession) : "";
    const activeFolder = activeRelativePath.includes("/") ? activeRelativePath.split("/").slice(0, -1).join("/") : activeRelativePath ? "__standalone__" : undefined;
    setExpandedFolders((current) => {
      if (!activeFolder && current.size) return current;
      const next = new Set(current);
      if (activeFolder) {
        const parts = activeFolder.split("/");
        for (let index = 1; index <= parts.length; index += 1) next.add(parts.slice(0, index).join("/"));
      } else if (!next.size && sessionTree.folders[0]) {
        next.add(sessionTree.folders[0].path);
      }
      return next;
    });
  }, [props.runtimeDir, props.sessions, sessionTree.folders]);

  const toggleFolder = (path: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="sidebar-content">
      <div className="sidebar-brand">
        <div className="brand-mark">鸾</div>
        <div className="brand-copy"><strong>{t("auth.brand")}</strong><span>Agent Workbench</span></div>
        {props.onClose ? <Tooltip title={t("nav.close")}><Button type="text" icon={<PanelLeftClose size={18} />} onClick={props.onClose} aria-label={t("nav.close")} /></Tooltip> : null}
      </div>
      <Menu className="view-menu" mode="inline" selectedKeys={[props.activeView]} items={viewItems} onClick={({ key }) => props.onViewChange(key as ViewKey)} />
      <section className="sidebar-section session-section">
        <div className="sidebar-section-title"><span>{t("sidebar.sessions")}</span><Badge count={props.sessions.length} showZero color="#2563eb" /></div>
        <div className="session-scroll">
          {props.sessions.length ? <>
            {sessionTree.rootSessions.map((session) => <SessionButton key={session.runtimeDir} session={session} {...props} />)}
            {sessionTree.standalone ? <SessionFolder folder={sessionTree.standalone} depth={0} expandedFolders={expandedFolders} onToggle={toggleFolder} sidebarProps={props} /> : null}
            {sessionTree.folders.map((folder) => <SessionFolder key={folder.path} folder={folder} depth={0} expandedFolders={expandedFolders} onToggle={toggleFolder} sidebarProps={props} />)}
          </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("sidebar.noSessions")} />}
        </div>
      </section>
      <section className="sidebar-section agent-section">
        <div className="sidebar-section-title"><span>{t("sidebar.agentStatus")}</span></div>
        {["planner", "executor", "observer", "runtime"].map((role) => {
          const event = props.agents[role];
          const active = isRecent(event?.timestamp);
          return <div className="agent-status" key={role}>
            <Badge status={active ? "processing" : event ? "default" : "warning"} />
            <div><strong>{roleLabel(role)}</strong><span>{event ? shortRef(event.summary || event.eventType, 26) : t("sidebar.noEvents")}</span></div>
            <time>{active ? t("common.active") : formatRelative(event?.timestamp)}</time>
          </div>;
        })}
      </section>
    </div>
  );
}

function SessionFolder({ folder, depth, expandedFolders, onToggle, sidebarProps }: {
  folder: SessionFolderNode;
  depth: number;
  expandedFolders: Set<string>;
  onToggle: (path: string) => void;
  sidebarProps: SidebarProps;
}) {
  const { t } = useLanguage();
  const expanded = expandedFolders.has(folder.path);
  return <div className="session-folder">
    <button className="session-folder-toggle" type="button" onClick={() => onToggle(folder.path)} style={{ paddingLeft: 6 + depth * 12 }} aria-expanded={expanded}>
      <ChevronRight className={expanded ? "expanded" : ""} size={14} />
      {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
      <span>{folder.path === "__standalone__" ? t("sidebar.standalone") : folder.name}</span><small>{folder.sessionCount}</small>
    </button>
    {expanded ? <div className="session-folder-children" style={{ paddingLeft: 8 + depth * 10 }}>
      {folder.sessions.map((session) => <SessionButton key={session.runtimeDir} session={session} {...sidebarProps} />)}
      {folder.folders.map((child) => <SessionFolder key={child.path} folder={child} depth={depth + 1} expandedFolders={expandedFolders} onToggle={onToggle} sidebarProps={sidebarProps} />)}
    </div> : null}
  </div>;
}

function SessionButton({ session, runtimeDir, onRuntimeChange }: SidebarProps & { session: RuntimeSession }) {
  const { t, formatRelative } = useLanguage();
  const active = normalize(session.runtimeDir) === normalize(runtimeDir);
  return <button className={`session-button${active ? " active" : ""}`} type="button" onClick={() => onRuntimeChange(session.runtimeDir)}>
    <span className="session-name">{session.running ? <Badge status="processing" /> : null}{session.name}</span>
    <strong>{session.goal || session.latestTask || t("sidebar.noGoal")}</strong>
    <span className="session-meta">{t("sidebar.tasksTrace", { tasks: session.taskCount, events: session.eventCount, time: formatRelative(session.updatedAt) })}</span>
  </button>;
}

function normalize(value: string): string {
  return value.replace(/\/+$/, "") || ".agent-runtime";
}
