import { useEffect, useState, type ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

interface ResizableWorkspaceProps {
  sidebar: ReactNode;
  main: ReactNode;
  inspector: ReactNode;
}

export function ResizableWorkspace({ sidebar, main, inspector }: ResizableWorkspaceProps) {
  const mobile = useMediaQuery("(max-width: 820px)");
  const compact = useMediaQuery("(max-width: 1180px)");
  const wideLayout = useDefaultLayout({
    id: "luanniao-workspace-wide",
    storage: window.localStorage,
    panelIds: ["sidebar", "main", "inspector"],
    onlySaveAfterUserInteractions: true
  });
  const compactLayout = useDefaultLayout({
    id: "luanniao-workspace-compact",
    storage: window.localStorage,
    panelIds: ["sidebar", "main"],
    onlySaveAfterUserInteractions: true
  });

  if (mobile) return <div className="app-shell mobile-workspace">{main}</div>;

  if (compact) {
    return (
      <Group
        className="app-shell"
        id="workspace-compact"
        orientation="horizontal"
        defaultLayout={compactLayout.defaultLayout}
        onLayoutChanged={compactLayout.onLayoutChanged}
        resizeTargetMinimumSize={{ fine: 8, coarse: 24 }}
      >
        <Panel id="sidebar" defaultSize={224} minSize={184} maxSize={360} groupResizeBehavior="preserve-pixel-size">
          <aside className="desktop-sidebar">{sidebar}</aside>
        </Panel>
        <ResizeHandle label="调整导航栏宽度" />
        <Panel id="main" minSize={520}>{main}</Panel>
      </Group>
    );
  }

  return (
    <Group
      className="app-shell"
      id="workspace-wide"
      orientation="horizontal"
      defaultLayout={wideLayout.defaultLayout}
      onLayoutChanged={wideLayout.onLayoutChanged}
      resizeTargetMinimumSize={{ fine: 8, coarse: 24 }}
    >
      <Panel id="sidebar" defaultSize={224} minSize={184} maxSize={360} groupResizeBehavior="preserve-pixel-size">
        <aside className="desktop-sidebar">{sidebar}</aside>
      </Panel>
      <ResizeHandle label="调整导航栏宽度" />
      <Panel id="main" minSize={560}>{main}</Panel>
      <ResizeHandle label="调整详情栏宽度" />
      <Panel id="inspector" defaultSize={340} minSize={280} maxSize={520} groupResizeBehavior="preserve-pixel-size">
        <aside className="desktop-inspector">{inspector}</aside>
      </Panel>
    </Group>
  );
}

function ResizeHandle({ label }: { label: string }) {
  return <Separator className="panel-resize-handle" aria-label={label} title={`${label}，双击恢复默认宽度`}><span /></Separator>;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const update = () => setMatches(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, [query]);
  return matches;
}
