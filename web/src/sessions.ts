import type { RuntimeSession } from "./types";

export interface SessionFolderNode {
  path: string;
  name: string;
  sessions: RuntimeSession[];
  folders: SessionFolderNode[];
  sessionCount: number;
  updatedAt?: string;
}

export interface SessionTreeModel {
  rootSessions: RuntimeSession[];
  standalone?: SessionFolderNode;
  folders: SessionFolderNode[];
}

interface MutableFolder {
  path: string;
  name: string;
  sessions: RuntimeSession[];
  folders: Map<string, MutableFolder>;
}

export function buildSessionTree(sessions: RuntimeSession[]): SessionTreeModel {
  const rootSessions = sessions.filter((session) => session.isRoot).sort(compareSession);
  const standaloneSessions: RuntimeSession[] = [];
  const rootFolders = new Map<string, MutableFolder>();

  for (const session of sessions) {
    if (session.isRoot) continue;
    const parts = sessionRelativePath(session).split("/").filter(Boolean);
    if (parts.length <= 1) {
      standaloneSessions.push(session);
      continue;
    }
    let folders = rootFolders;
    let currentPath = "";
    for (const part of parts.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let folder = folders.get(part);
      if (!folder) {
        folder = { path: currentPath, name: part, sessions: [], folders: new Map() };
        folders.set(part, folder);
      }
      folders = folder.folders;
      if (currentPath === parts.slice(0, -1).join("/")) folder.sessions.push(session);
    }
  }

  const folders = [...rootFolders.values()].map(finalizeFolder).sort(compareFolder);
  const standalone = standaloneSessions.length
    ? finalizeFolder({ path: "__standalone__", name: "__standalone__", sessions: standaloneSessions, folders: new Map() })
    : undefined;
  return { rootSessions, standalone, folders };
}

export function sessionRelativePath(session: RuntimeSession): string {
  if (session.relativePath !== undefined) return normalize(session.relativePath);
  const runtimeDir = normalize(session.runtimeDir);
  const marker = ".agent-runtime/";
  const markerIndex = runtimeDir.indexOf(marker);
  return markerIndex >= 0 ? runtimeDir.slice(markerIndex + marker.length) : runtimeDir;
}

function finalizeFolder(folder: MutableFolder): SessionFolderNode {
  const folders = [...folder.folders.values()].map(finalizeFolder).sort(compareFolder);
  const sessions = [...folder.sessions].sort(compareSession);
  const timestamps = [
    ...sessions.map((session) => timeValue(session.updatedAt)),
    ...folders.map((child) => timeValue(child.updatedAt))
  ];
  const updatedAtMs = timestamps.length ? Math.max(...timestamps) : 0;
  return {
    path: folder.path,
    name: folder.name,
    sessions,
    folders,
    sessionCount: sessions.length + folders.reduce((sum, child) => sum + child.sessionCount, 0),
    updatedAt: updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : undefined
  };
}

function compareSession(left: RuntimeSession, right: RuntimeSession): number {
  return timeValue(right.updatedAt) - timeValue(left.updatedAt) || left.name.localeCompare(right.name);
}

function compareFolder(left: SessionFolderNode, right: SessionFolderNode): number {
  return timeValue(right.updatedAt) - timeValue(left.updatedAt) || left.name.localeCompare(right.name);
}

function timeValue(value?: string): number {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}
