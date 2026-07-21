import { Badge, Collapse, Descriptions, Empty, Tag, Typography } from "antd";
import { taskProgressItems, type TaskProgressItem } from "../graph";
import type { AgentEvent, ArtifactRecord, GraphEdge, GraphNode, TaskSummary, TraceItem, ViewKey } from "../types";
import { formatTime, isRecent, roleLabel, shortRef, valueText } from "../utils";
import { looksLikeMarkdown, Markdown } from "./Markdown";

interface InspectorProps {
  view: ViewKey;
  trace?: TraceItem;
  node?: GraphNode;
  edges: GraphEdge[];
  artifacts: ArtifactRecord[];
  tasks: TaskSummary[];
  agents: Record<string, AgentEvent | undefined>;
}

export function Inspector(props: InspectorProps) {
  return (
    <div className="inspector-content">
      <div className="inspector-heading">
        <span>INSPECTOR</span>
        <Typography.Title level={4}>{props.view === "trace" ? "当前步骤" : "节点详情"}</Typography.Title>
      </div>
      {props.view === "trace" ? <TraceInspector trace={props.trace} artifacts={props.artifacts} /> : (
        <NodeInspector node={props.node} edges={props.edges} />
      )}
      <RuntimeOverview tasks={props.tasks} agents={props.agents} />
    </div>
  );
}

function TraceInspector({ trace, artifacts }: { trace?: TraceItem; artifacts: ArtifactRecord[] }) {
  if (!trace) return <Empty description="选择一条 Trace 查看详情" />;
  const artifactMap = new Map(artifacts.map((record) => [record.artifactRef, record]));
  return (
    <section className="inspector-primary">
      <Tag color="blue">{roleLabel(trace.role)}</Tag>
      <Typography.Title level={5}>{trace.title}</Typography.Title>
      {looksLikeMarkdown(trace.summary) ? <Markdown text={trace.summary} /> : <p>{trace.summary}</p>}
      <Descriptions size="small" column={1} colon={false} items={[
        { key: "intentSource", label: "摘要来源", children: trace.intentSource === "recorded" ? "Agent 公开输出" : trace.intentSource === "structured" ? "结构化理由" : "系统派生目的" },
        { key: "action", label: "动作", children: trace.action || "无外部动作" },
        { key: "stage", label: "阶段", children: trace.stage },
        { key: "event", label: "事件", children: trace.eventLabel || trace.eventType },
        { key: "task", label: "任务", children: shortRef(trace.taskId) },
        { key: "time", label: "时间", children: formatTime(trace.timestamp) }
      ]} />
      <RefSection title="Evidence" refs={trace.evidenceRefs} />
      <RefSection title="Graph refs" refs={trace.graphNodeRefs} />
      <div className="inspector-block">
        <strong>Artifacts</strong>
        {trace.artifactRefs.length ? trace.artifactRefs.map((ref) => {
          const artifact = artifactMap.get(ref);
          return <div className="artifact-row" key={ref}><span>{shortRef(ref, 32)}</span><small>{artifact?.kind || artifact?.mediaType || "artifact"}</small></div>;
        }) : <span className="muted-line">无关联 Artifact</span>}
      </div>
      <Collapse size="small" items={[{ key: "raw", label: trace.eventType === "agent_action" || trace.eventType === "tool_execution" ? "聚合事件" : "原始事件", children: <pre className="json-block">{JSON.stringify(trace.rawEvent, null, 2)}</pre> }]} />
    </section>
  );
}

function NodeInspector({ node, edges }: { node?: GraphNode; edges: GraphEdge[] }) {
  if (!node) return <Empty description="选择图中的节点查看属性与关系" />;
  const incoming = edges.filter((edge) => edge.to === node.id);
  const outgoing = edges.filter((edge) => edge.from === node.id);
  const hiddenProgressKeys = new Set(["milestones", "blockers", "milestoneCount", "blockerCount"]);
  const properties = Object.entries(node.properties || {})
    .filter(([key]) => !hiddenProgressKeys.has(key))
    .map(([key, value]) => ({ key, label: key, children: valueText(value) }));
  const milestones = node.type === "Task" ? taskProgressItems(node, "milestones") : [];
  const blockers = node.type === "Task" ? taskProgressItems(node, "blockers") : [];
  return (
    <section className="inspector-primary">
      <Tag color="geekblue">{node.type}</Tag>
      <Typography.Title level={5}>{node.label}</Typography.Title>
      <code className="node-id">{node.id}</code>
      {properties.length ? <Descriptions size="small" column={1} colon={false} items={properties.slice(0, 12)} /> : null}
      {node.type === "Task" ? <TaskProgressSection title={`里程碑 ${milestones.length}`} type="milestone" items={milestones} /> : null}
      {node.type === "Task" ? <TaskProgressSection title={`阻塞项 ${blockers.length}`} type="blocker" items={blockers} /> : null}
      <RefSection title="Evidence" refs={node.evidenceRefs} />
      <EdgeSection title={`入边 ${incoming.length}`} edges={incoming} direction="in" />
      <EdgeSection title={`出边 ${outgoing.length}`} edges={outgoing} direction="out" />
    </section>
  );
}

function TaskProgressSection({ title, type, items }: { title: string; type: "milestone" | "blocker"; items: TaskProgressItem[] }) {
  return (
    <div className="inspector-block task-progress-block">
      <strong>{title}</strong>
      {items.length ? <div className="task-progress-list">{items.map((item) => (
        <article className={`task-progress-item ${type}`} key={item.id}>
          <div className="task-progress-title">
            <span>{item.label}</span>
            {item.status ? <Tag color={type === "blocker" ? "error" : "processing"}>{item.status}</Tag> : null}
          </div>
          {item.reason && item.reason !== item.label ? <p>{item.reason}</p> : null}
          <small>{shortRef(item.id, 38)}{item.evidenceRefs.length ? ` · ${item.evidenceRefs.length} Evidence` : ""}</small>
        </article>
      ))}</div> : <span className="muted-line">暂无{type === "blocker" ? "阻塞" : "里程碑"}</span>}
    </div>
  );
}

function RefSection({ title, refs }: { title: string; refs: string[] }) {
  return (
    <div className="inspector-block">
      <strong>{title}</strong>
      <div className="ref-list">{refs.length ? refs.map((ref) => <Tag key={ref}>{shortRef(ref, 34)}</Tag>) : <span className="muted-line">无关联引用</span>}</div>
    </div>
  );
}

function EdgeSection({ title, edges, direction }: { title: string; edges: GraphEdge[]; direction: "in" | "out" }) {
  return (
    <div className="inspector-block">
      <strong>{title}</strong>
      {edges.length ? edges.slice(0, 20).map((edge, index) => (
        <div className="edge-inspector-row" key={edge.id || `${edge.from}:${edge.type}:${edge.to}:${index}`}>
          <Tag>{edge.type}</Tag><span>{shortRef(direction === "in" ? edge.from : edge.to, 30)}</span>
        </div>
      )) : <span className="muted-line">无关系</span>}
    </div>
  );
}

function RuntimeOverview({ tasks, agents }: { tasks: TaskSummary[]; agents: Record<string, AgentEvent | undefined> }) {
  return (
    <Collapse
      className="runtime-overview"
      defaultActiveKey={["tasks"]}
      items={[
        {
          key: "tasks",
          label: `任务队列 · ${tasks.length}`,
          children: tasks.length ? tasks.map((task) => (
            <div className="task-inspector-row" key={task.id}>
              <div><strong>{task.label}</strong><span>{shortRef(task.id, 30)}</span></div>
              <Tag color={task.status === "completed" ? "success" : task.status === "blocked" ? "error" : "processing"}>{task.status}</Tag>
            </div>
          )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务" />
        },
        {
          key: "agents",
          label: "Agent 状态",
          children: ["planner", "executor", "observer", "runtime"].map((role) => {
            const event = agents[role];
            return <div className="agent-inspector-row" key={role}><Badge status={isRecent(event?.timestamp) ? "processing" : "default"} /><strong>{roleLabel(role)}</strong><span>{event?.eventType || "idle"}</span></div>;
          })
        }
      ]}
    />
  );
}
