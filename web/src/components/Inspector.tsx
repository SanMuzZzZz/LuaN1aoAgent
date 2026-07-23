import { useEffect, useState } from "react";
import { Alert, Badge, Collapse, Descriptions, Empty, Modal, Spin, Tag, Typography } from "antd";
import { fetchArtifact } from "../api";
import { taskProgressItems, type TaskProgressItem } from "../graph";
import { useLanguage } from "../language";
import type { AgentEvent, ArtifactContent, ArtifactRecord, GraphEdge, GraphNode, TaskSummary, TraceItem, ViewKey } from "../types";
import { formatTime, isRecent, roleLabel, shortRef, valueText } from "../utils";
import { looksLikeMarkdown, Markdown } from "./Markdown";

interface InspectorProps {
  view: ViewKey;
  runtimeDir: string;
  trace?: TraceItem;
  node?: GraphNode;
  edges: GraphEdge[];
  artifacts: ArtifactRecord[];
  tasks: TaskSummary[];
  agents: Record<string, AgentEvent | undefined>;
}

export function Inspector(props: InspectorProps) {
  const { t } = useLanguage();
  return (
    <div className="inspector-content">
      <div className="inspector-heading">
        <span>INSPECTOR</span>
        <Typography.Title level={4}>{t(props.view === "trace" ? "inspector.currentStep" : "inspector.nodeDetails")}</Typography.Title>
      </div>
      {props.view === "trace" ? <TraceInspector trace={props.trace} artifacts={props.artifacts} runtimeDir={props.runtimeDir} /> : (
        <NodeInspector node={props.node} edges={props.edges} />
      )}
      <RuntimeOverview tasks={props.tasks} agents={props.agents} />
    </div>
  );
}

function TraceInspector({ trace, artifacts, runtimeDir }: { trace?: TraceItem; artifacts: ArtifactRecord[]; runtimeDir: string }) {
  const { t, formatBytes } = useLanguage();
  const [viewingArtifact, setViewingArtifact] = useState<string>();
  if (!trace) return <Empty description={t("inspector.selectTrace")} />;
  const artifactMap = new Map(artifacts.map((record) => [record.artifactRef, record]));
  return (
    <section className="inspector-primary">
      <Tag color="blue">{roleLabel(trace.role)}</Tag>
      <Typography.Title level={5}>{trace.title}</Typography.Title>
      {looksLikeMarkdown(trace.summary) ? <Markdown text={trace.summary} /> : <p>{trace.summary}</p>}
      <Descriptions size="small" column={1} colon={false} items={[
        { key: "intentSource", label: t("inspector.summarySource"), children: t(trace.intentSource === "recorded" ? "inspector.publicOutput" : trace.intentSource === "structured" ? "inspector.structuredReason" : "inspector.derivedPurpose") },
        { key: "action", label: t("inspector.action"), children: trace.action || t("inspector.noExternalAction") },
        { key: "stage", label: t("inspector.stage"), children: trace.stage },
        { key: "event", label: t("inspector.event"), children: trace.eventLabel || trace.eventType },
        { key: "task", label: t("inspector.task"), children: shortRef(trace.taskId) },
        { key: "time", label: t("inspector.time"), children: formatTime(trace.timestamp) }
      ]} />
      <RefSection title="Evidence" refs={trace.evidenceRefs} />
      <RefSection title="Graph refs" refs={trace.graphNodeRefs} />
      {trace.commandDetails?.length ? (
        <div className="inspector-block">
          <strong>{t("inspector.commandDetails")}</strong>
          <div className="command-detail-list">{trace.commandDetails.map((line, index) => (
            <div className="command-detail-row" key={index}>{line}</div>
          ))}</div>
        </div>
      ) : null}
      <div className="inspector-block">
        <strong>Artifacts</strong>
        {trace.artifactRefs.length ? trace.artifactRefs.map((ref) => {
          const artifact = artifactMap.get(ref);
          return (
            <button className="artifact-row artifact-row-button" key={ref} type="button" onClick={() => setViewingArtifact(ref)}>
              <span>{shortRef(ref, 32)}</span>
              <small>{artifact?.kind || artifact?.mediaType || "artifact"}{artifact?.byteLength ? ` · ${formatBytes(artifact.byteLength)}` : ""}</small>
            </button>
          );
        }) : <span className="muted-line">{t("inspector.noArtifact")}</span>}
      </div>
      <Collapse size="small" items={[{ key: "raw", label: t(trace.eventType === "agent_action" || trace.eventType === "tool_execution" ? "inspector.aggregatedEvent" : "inspector.rawEvent"), children: <pre className="json-block">{JSON.stringify(trace.rawEvent, null, 2)}</pre> }]} />
      <ArtifactViewer
        runtimeDir={runtimeDir}
        artifactRef={viewingArtifact}
        fallback={viewingArtifact ? artifactMap.get(viewingArtifact) : undefined}
        onClose={() => setViewingArtifact(undefined)}
      />
    </section>
  );
}

function ArtifactViewer({ runtimeDir, artifactRef, fallback, onClose }: {
  runtimeDir: string;
  artifactRef?: string;
  fallback?: ArtifactRecord;
  onClose: () => void;
}) {
  const { t, formatBytes } = useLanguage();
  const [content, setContent] = useState<ArtifactContent>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!artifactRef) return;
    const controller = new AbortController();
    setContent(undefined);
    setError(undefined);
    setLoading(true);
    fetchArtifact(runtimeDir, artifactRef, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setContent(result); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [runtimeDir, artifactRef]);

  const isImage = (content?.mediaType ?? fallback?.mediaType ?? "").startsWith("image/");
  return (
    <Modal
      title={`Artifact ${shortRef(artifactRef, 30)}`}
      open={Boolean(artifactRef)}
      onCancel={onClose}
      footer={null}
      width={760}
      destroyOnHidden
    >
      {loading ? <div className="artifact-loading"><Spin /> {t("inspector.loadingContent")}</div> : null}
      {error ? (
        <>
          <Alert type="warning" showIcon message={t("inspector.loadContentFailed", { error })} />
          {fallback?.preview ? <pre className="json-block artifact-content">{fallback.preview}</pre> : null}
        </>
      ) : null}
      {content ? (
        <>
          <div className="artifact-meta">
            <Tag>{content.kind || content.mediaType || "artifact"}</Tag>
            <span>{formatBytes(content.byteLength ?? 0)}{content.truncated ? t("inspector.truncatedContent") : ""}</span>
          </div>
          {isImage && content.encoding === "base64" ? (
            <img className="artifact-image" src={`data:${content.mediaType};base64,${content.content}`} alt={content.artifactRef} />
          ) : (
            <pre className="json-block artifact-content">{content.content}</pre>
          )}
        </>
      ) : null}
    </Modal>
  );
}

function NodeInspector({ node, edges }: { node?: GraphNode; edges: GraphEdge[] }) {
  const { t } = useLanguage();
  if (!node) return <Empty description={t("inspector.selectNode")} />;
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
      {node.type === "Task" ? <TaskProgressSection title={t("inspector.milestones", { value: milestones.length })} type="milestone" items={milestones} /> : null}
      {node.type === "Task" ? <TaskProgressSection title={t("inspector.blockers", { value: blockers.length })} type="blocker" items={blockers} /> : null}
      <RefSection title={t("inspector.evidence")} refs={node.evidenceRefs} />
      <EdgeSection title={t("inspector.incoming", { value: incoming.length })} edges={incoming} direction="in" />
      <EdgeSection title={t("inspector.outgoing", { value: outgoing.length })} edges={outgoing} direction="out" />
    </section>
  );
}

function TaskProgressSection({ title, type, items }: { title: string; type: "milestone" | "blocker"; items: TaskProgressItem[] }) {
  const { t } = useLanguage();
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
          <small>{shortRef(item.id, 38)}{item.evidenceRefs.length ? ` · ${t("inspector.evidenceCount", { value: item.evidenceRefs.length })}` : ""}</small>
        </article>
      ))}</div> : <span className="muted-line">{t(type === "blocker" ? "inspector.noBlockers" : "inspector.noMilestones")}</span>}
    </div>
  );
}

function RefSection({ title, refs }: { title: string; refs: string[] }) {
  const { t } = useLanguage();
  return (
    <div className="inspector-block">
      <strong>{title}</strong>
      <div className="ref-list">{refs.length ? refs.map((ref) => <Tag key={ref}>{shortRef(ref, 34)}</Tag>) : <span className="muted-line">{t("inspector.noRefs")}</span>}</div>
    </div>
  );
}

function EdgeSection({ title, edges, direction }: { title: string; edges: GraphEdge[]; direction: "in" | "out" }) {
  const { t } = useLanguage();
  return (
    <div className="inspector-block">
      <strong>{title}</strong>
      {edges.length ? edges.slice(0, 20).map((edge, index) => {
        const status = typeof edge.properties.status === "string" ? edge.properties.status : undefined;
        const details = ["tunnelId", "routeId", "transport", "localHost", "localPort", "remoteHost", "remotePort", "via", "lastSeenAt", "expiresAt"]
          .filter((key) => edge.properties[key] !== undefined)
          .map((key) => `${key}=${valueText(edge.properties[key])}`)
          .join(" · ");
        return (
          <div className="edge-inspector-row" key={edge.id || `${edge.from}:${edge.type}:${edge.to}:${index}`}>
            <Tag>{edge.type}</Tag>{status ? <Tag>{status}</Tag> : null}<span>{shortRef(direction === "in" ? edge.from : edge.to, 30)}</span>
            {details ? <small>{details}</small> : null}
          </div>
        );
      }) : <span className="muted-line">{t("inspector.noRelations")}</span>}
    </div>
  );
}

function RuntimeOverview({ tasks, agents }: { tasks: TaskSummary[]; agents: Record<string, AgentEvent | undefined> }) {
  const { t } = useLanguage();
  return (
    <Collapse
      className="runtime-overview"
      defaultActiveKey={["tasks"]}
      items={[
        {
          key: "tasks",
          label: t("inspector.taskQueue", { value: tasks.length }),
          children: tasks.length ? tasks.map((task) => (
            <div className="task-inspector-row" key={task.id}>
              <div><strong>{task.label}</strong><span>{shortRef(task.id, 30)}</span></div>
              <Tag color={task.status === "completed" ? "success" : task.status === "blocked" ? "error" : "processing"}>{task.status}</Tag>
            </div>
          )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("inspector.noTasks")} />
        },
        {
          key: "agents",
          label: t("sidebar.agentStatus"),
          children: ["planner", "executor", "observer", "runtime"].map((role) => {
            const event = agents[role];
            return <div className="agent-inspector-row" key={role}><Badge status={isRecent(event?.timestamp) ? "processing" : "default"} /><strong>{roleLabel(role)}</strong><span>{event?.eventType || "idle"}</span></div>;
          })
        }
      ]}
    />
  );
}
