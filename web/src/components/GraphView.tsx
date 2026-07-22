import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Input, Select, Tag, Tooltip } from "antd";
import cytoscape, { type Core, type EdgeSingular, type ElementDefinition, type LayoutOptions, type Position, type StylesheetJson } from "cytoscape";
import elk from "cytoscape-elk";
import { Focus, ListFilter, Minus, Plus, RefreshCw, Search, X } from "lucide-react";
import { edgePresentation, elkLayout, filterGraph, graphSignature, nodeDisplayLabel, nodePalette, taskProgressSummary } from "../graph";
import type { GraphEdge, GraphKind, GraphNode } from "../types";
import { shortRef } from "../utils";

cytoscape.use(elk);

const positionCache = new Map<string, Record<string, Position>>();

interface GraphViewProps {
  runtimeDir: string;
  kind: GraphKind;
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId?: string;
  linkedNodeIds: string[];
  onSelectNode: (nodeId?: string) => void;
}

export function GraphView(props: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | undefined>(undefined);
  const onSelectNodeRef = useRef(props.onSelectNode);
  const [query, setQuery] = useState("");
  const [nodeTypes, setNodeTypes] = useState<string[]>([]);
  const [edgeTypes, setEdgeTypes] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [layoutNonce, setLayoutNonce] = useState(0);

  useEffect(() => { onSelectNodeRef.current = props.onSelectNode; }, [props.onSelectNode]);

  useEffect(() => {
    setQuery("");
    setNodeTypes([]);
    setEdgeTypes([]);
  }, [props.kind, props.runtimeDir]);

  const allKindNodes = useMemo(
    () => props.nodes.filter((node) => node.graphKind === props.kind),
    [props.kind, props.nodes]
  );
  const visibleGraph = useMemo(
    () => filterGraph(props.nodes, props.edges, props.kind, query, nodeTypes, edgeTypes),
    [edgeTypes, nodeTypes, props.edges, props.kind, props.nodes, query]
  );
  const signature = useMemo(
    () => `${graphSignature(props.runtimeDir, props.kind, visibleGraph)}|${layoutNonce}`,
    [layoutNonce, props.kind, props.runtimeDir, visibleGraph]
  );
  const nodeTypeOptions = useMemo(
    () => [...new Set(allKindNodes
      .filter((node) => props.kind !== "task" || ["Scope", "Goal", "Task"].includes(node.type))
      .map((node) => node.type))].sort().map((value) => ({ value, label: value })),
    [allKindNodes, props.kind]
  );
  const visibleIds = useMemo(() => new Set(visibleGraph.nodes.map((node) => node.id)), [visibleGraph.nodes]);
  const edgeTypeOptions = useMemo(
    () => [...new Set(props.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)).map((edge) => edge.type))]
      .sort().map((value) => ({ value, label: value })),
    [props.edges, visibleIds]
  );

  useEffect(() => {
    if (!containerRef.current) return undefined;
    cyRef.current?.destroy();
    if (!visibleGraph.nodes.length) return undefined;

    const elements: ElementDefinition[] = [
      ...visibleGraph.nodes.map((node) => {
        const palette = nodePalette(node.type);
        return {
          group: "nodes" as const,
          data: {
            id: node.id,
            label: nodeDisplayLabel(node, props.kind),
            fullLabel: node.label,
            type: node.type,
            color: palette.color,
            background: palette.background
          },
          classes: ""
        };
      }),
      ...visibleGraph.edges.map((edge, index) => {
        const presentation = edgePresentation(edge);
        return {
          group: "edges" as const,
          data: {
            id: edge.id || `edge:${edge.from}:${edge.type}:${edge.to}:${index}`,
            source: edge.from,
            target: edge.to,
            label: edge.type,
            type: edge.type,
            statusColor: presentation.color,
            lineStyle: presentation.lineStyle,
            statusOpacity: presentation.opacity
          }
        };
      })
    ];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: graphStyles(visibleGraph.nodes.length, props.kind),
      minZoom: 0.08,
      maxZoom: 3.2,
      boxSelectionEnabled: false,
      selectionType: "single"
    });
    cyRef.current = cy;

    cy.on("tap", "node", (event) => onSelectNodeRef.current(event.target.id()));
    cy.on("tap", (event) => {
      if (event.target === cy) onSelectNodeRef.current(undefined);
    });
    cy.on("zoom", () => {
      const nextZoom = cy.zoom();
      setZoom(nextZoom);
      updateLabelVisibility(cy, visibleGraph.nodes.length, nextZoom);
    });

    const cached = positionCache.get(signature);
    const hasAllPositions = cached && visibleGraph.nodes.every((node) => cached[node.id]);
    if (hasAllPositions && cached) {
      cy.layout({ name: "preset", positions: cached, fit: true, padding: 42 }).run();
    } else {
      const layout = cy.layout(elkLayout(props.kind, visibleGraph.nodes.length) as unknown as LayoutOptions);
      layout.on("layoutstop", () => {
        const positions: Record<string, Position> = {};
        cy.nodes().forEach((node) => { positions[node.id()] = node.position(); });
        positionCache.set(signature, positions);
        cy.fit(undefined, 42);
        setZoom(cy.zoom());
      });
      layout.run();
    }

    return () => {
      cy.destroy();
      if (cyRef.current === cy) cyRef.current = undefined;
    };
  }, [signature]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass("trace-linked");
    props.linkedNodeIds.forEach((nodeId) => cy.getElementById(nodeId).addClass("trace-linked"));
  }, [props.linkedNodeIds, signature]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass("is-selected is-neighbor is-dimmed is-active-edge");
    if (!props.selectedNodeId) return;
    const selected = cy.getElementById(props.selectedNodeId);
    if (!selected.length) return;
    const neighborhood = selected.closedNeighborhood();
    cy.elements().difference(neighborhood).addClass("is-dimmed");
    selected.addClass("is-selected");
    selected.neighborhood("node").addClass("is-neighbor");
    selected.connectedEdges().addClass("is-active-edge");
  }, [props.selectedNodeId, signature]);

  const zoomBy = (factor: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({ level: Math.max(0.08, Math.min(3.2, cy.zoom() * factor)), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };

  const fit = () => cyRef.current?.fit(undefined, 42);
  const relayout = () => {
    positionCache.delete(signature);
    setLayoutNonce((value) => value + 1);
  };

  return (
    <div className="graph-workspace">
      <div className="graph-toolbar">
        <Input
          allowClear
          prefix={<Search size={15} />}
          placeholder="搜索节点名称、ID 或类型"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select
          mode="multiple"
          maxTagCount="responsive"
          allowClear
          placeholder="节点类型"
          suffixIcon={<ListFilter size={15} />}
          value={nodeTypes}
          options={nodeTypeOptions}
          onChange={setNodeTypes}
        />
        <Select
          mode="multiple"
          maxTagCount="responsive"
          allowClear
          placeholder="关系类型"
          value={edgeTypes}
          options={edgeTypeOptions}
          onChange={setEdgeTypes}
        />
        <div className="graph-toolbar-actions">
          <Tooltip title="缩小"><Button icon={<Minus size={16} />} onClick={() => zoomBy(1 / 1.18)} aria-label="缩小" /></Tooltip>
          <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
          <Tooltip title="放大"><Button icon={<Plus size={16} />} onClick={() => zoomBy(1.18)} aria-label="放大" /></Tooltip>
          <Tooltip title="适配画布"><Button icon={<Focus size={16} />} onClick={fit} aria-label="适配画布" /></Tooltip>
          <Tooltip title="重新布局"><Button icon={<RefreshCw size={16} />} onClick={relayout} aria-label="重新布局" /></Tooltip>
          <Tooltip title="清除选择"><Button icon={<X size={16} />} onClick={() => props.onSelectNode(undefined)} aria-label="清除选择" /></Tooltip>
        </div>
      </div>

      <div className="graph-body">
        <aside className="graph-node-index" aria-label="图节点列表">
          <div className="graph-index-head">
            <strong>节点</strong>
            <span>{visibleGraph.nodes.length}</span>
          </div>
          <div className="graph-index-list">
            {visibleGraph.nodes.length ? visibleGraph.nodes.slice(0, 300).map((node) => {
              const palette = nodePalette(node.type);
              const progress = props.kind === "task" ? taskProgressSummary(node) : undefined;
              return (
                <button
                  className={node.id === props.selectedNodeId ? "active" : ""}
                  key={node.id}
                  type="button"
                  onClick={() => props.onSelectNode(node.id)}
                >
                  <i style={{ background: palette.color }} />
                  <span>
                    <strong>{node.label}</strong>
                    <small>{node.type} · {shortRef(node.id, 28)}</small>
                    {progress ? <em>{progress}</em> : null}
                  </span>
                </button>
              );
            }) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配节点" />}
          </div>
        </aside>
        <div className="graph-canvas-wrap">
          {visibleGraph.nodes.length ? <div ref={containerRef} className="graph-canvas" /> : (
            <Empty description="当前筛选条件下没有可展示的节点" />
          )}
          <div className="graph-legend">
            {[...new Set(visibleGraph.nodes.map((node) => node.type))].slice(0, 8).map((type) => {
              const palette = nodePalette(type);
              return <Tag key={type} color={palette.background} style={{ color: palette.color, borderColor: palette.color }}>{type}</Tag>;
            })}
          </div>
          <div className="graph-counts">{visibleGraph.nodes.length} 节点 · {visibleGraph.edges.length} {props.kind === "task" ? "树关系" : "关系"}</div>
        </div>
      </div>
    </div>
  );
}

function updateLabelVisibility(cy: Core, nodeCount: number, zoom: number) {
  if (nodeCount <= 300) return;
  cy.nodes().style("label", zoom < 0.58 ? "" : "data(label)");
}

function graphStyles(nodeCount: number, kind: GraphKind): StylesheetJson {
  const taskTree = kind === "task";
  return [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        width: nodeCount > 300 ? 138 : taskTree ? 230 : 172,
        height: nodeCount > 300 ? 52 : taskTree ? 96 : 68,
        "background-color": "data(background)",
        "border-color": "data(color)",
        "border-width": 2,
        label: "data(label)",
        color: "#172033",
        "font-size": nodeCount > 300 ? 10 : taskTree ? 11 : 12,
        "font-weight": 600,
        "text-wrap": "wrap",
        "text-max-width": `${nodeCount > 300 ? 122 : taskTree ? 204 : 154}px`,
        "text-valign": "center",
        "text-halign": "center",
        "overlay-opacity": 0
      }
    },
    {
      selector: "node.trace-linked",
      style: { "border-width": 4, "underlay-color": "#93c5fd", "underlay-opacity": 0.38, "underlay-padding": 7 }
    },
    {
      selector: "node.is-selected",
      style: { "border-width": 4, "border-color": "#1d4ed8", "underlay-color": "#60a5fa", "underlay-opacity": 0.5, "underlay-padding": 10 }
    },
    {
      selector: "node.is-neighbor",
      style: { "border-width": 3 }
    },
    {
      selector: ".is-dimmed",
      style: { opacity: 0.14, "text-opacity": 0.14 }
    },
    {
      selector: "edge",
      style: {
        width: 1.4,
        "line-color": "data(statusColor)",
        "target-arrow-color": "data(statusColor)",
        "line-style": (element) => element.data("lineStyle"),
        "target-arrow-shape": "triangle",
        "curve-style": "taxi",
        "taxi-direction": "auto",
        "taxi-turn": 22,
        "arrow-scale": 0.8,
        opacity: (element: EdgeSingular) => element.data("statusOpacity"),
        "overlay-opacity": 0
      }
    },
    {
      selector: "edge.is-active-edge",
      style: {
        width: 2.8,
        label: "data(label)",
        color: "#1e3a8a",
        "font-size": 10,
        "font-weight": 600,
        "text-background-color": "#ffffff",
        "text-background-opacity": 0.9,
        "text-background-padding": "3px",
        "text-rotation": "autorotate",
        opacity: (element: EdgeSingular) => element.data("statusOpacity")
      }
    }
  ];
}
