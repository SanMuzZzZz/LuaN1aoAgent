import { Alert, Button, Collapse, Empty, Segmented, Tag, Typography } from "antd";
import { ArrowDownUp, BrainCircuit, CheckCircle2, Clock3, PlayCircle, TerminalSquare, XCircle } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import type { Role, TraceItem } from "../types";
import { formatRelative, formatTime, roleLabel, shortRef } from "../utils";

interface TraceViewProps {
  items: TraceItem[];
  selectedTraceId?: string;
  roleFilter: string;
  newestFirst: boolean;
  onRoleFilterChange: (role: string) => void;
  onOrderChange: () => void;
  onSelectTrace: (traceId: string) => void;
}

const roleOptions = [
  { label: "全部", value: "all" },
  { label: "Planner", value: "planner" },
  { label: "Executor", value: "executor" },
  { label: "Observer", value: "observer" }
];

export function TraceView(props: TraceViewProps) {
  const filtered = props.items
    .filter((item) => item.role !== "runtime")
    .filter((item) => props.roleFilter === "all" || item.role === props.roleFilter)
    .sort((left, right) => {
      const diff = new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime();
      return props.newestFirst ? -diff : diff;
    });

  return (
    <div className="trace-view">
      <div className="trace-toolbar">
        <Segmented options={roleOptions} value={props.roleFilter} onChange={(value) => props.onRoleFilterChange(String(value))} />
        <Button icon={<ArrowDownUp size={16} />} onClick={props.onOrderChange}>
          {props.newestFirst ? "最新优先" : "时间顺序"}
        </Button>
      </div>
      <div className="trace-list-wrap">
        {filtered.length ? (
          <Virtuoso
            data={filtered}
            increaseViewportBy={500}
            itemContent={(_, item) => (
              <TraceCard
                item={item}
                selected={item.id === props.selectedTraceId}
                onSelect={() => props.onSelectTrace(item.id)}
              />
            )}
          />
        ) : <Empty description="当前筛选条件下没有 Trace 事件" />}
      </div>
    </div>
  );
}

export function TraceCard({ item, selected, onSelect }: { item: TraceItem; selected: boolean; onSelect: () => void }) {
  const details = [
    ["决策", item.decision],
    ["观察", item.tool ? undefined : item.observation],
    ["下一步", item.next],
    ["事件链", item.detail]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  return (
    <article
      className={`trace-card role-${roleToken(item.role)}${selected ? " selected" : ""}`}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(); }}
    >
      <div className="trace-card-head">
        <div>
          <div className="trace-role-line"><i />{roleLabel(item.role)} · {item.eventLabel || item.eventType}</div>
          <Typography.Title level={4}>{item.title}</Typography.Title>
        </div>
        <Tag>{item.stage}</Tag>
      </div>
      <div className="trace-preview">
        <div className="trace-preview-block thought">
          <span><BrainCircuit size={15} />{intentSourceLabel(item.intentSource)}</span>
          <p>{item.summary || "当前步骤没有可展示的判断摘要。"}</p>
        </div>
        <div className="trace-preview-block action">
          <span><PlayCircle size={15} />执行动作</span>
          <p>{item.action || "本步骤没有触发外部工具动作。"}</p>
        </div>
      </div>
      <div className="trace-card-foot">
        <div className="trace-refs">
          {item.taskId ? <Tag>{shortRef(item.taskId)}</Tag> : null}
          {item.evidenceRefs.length ? <Tag color="blue">Evidence {item.evidenceRefs.length}</Tag> : null}
          {item.artifactRefs.length ? <Tag color="cyan">Artifact {item.artifactRefs.length}</Tag> : null}
        </div>
        <time>{formatTime(item.timestamp)} · {formatRelative(item.timestamp)}</time>
      </div>
      <div onClick={(event) => event.stopPropagation()}>
        <Collapse
          className="trace-expand"
          size="small"
          items={[{
            key: "details",
            label: "展开执行细节",
            children: (
              <div className="trace-expanded-content">
                {details.length ? (
                  <div className="trace-detail-grid">
                    {details.map(([label, value]) => <div key={label}><span>{label}</span><p>{value}</p></div>)}
                  </div>
                ) : null}
                {item.tool ? <ToolRun item={item} /> : null}
                <Collapse
                  ghost
                  size="small"
                  items={[{
                    key: "raw",
                    label: item.eventType === "agent_action" || item.eventType === "tool_execution" ? "查看聚合事件" : "查看原始事件",
                    children: <pre className="json-block">{JSON.stringify(item.rawEvent, null, 2)}</pre>
                  }]}
                />
              </div>
            )
          }]}
        />
      </div>
    </article>
  );
}

function intentSourceLabel(source: TraceItem["intentSource"]): string {
  if (source === "recorded") return "Agent 想法";
  if (source === "structured") return "判断依据";
  return "行动目的";
}

function ToolRun({ item }: { item: TraceItem }) {
  const tool = item.tool!;
  return (
    <div className={`tool-run ${tool.isError ? "error" : tool.status === "running" ? "running" : "success"}`}>
      <div className="tool-run-title">
        <TerminalSquare size={16} />
        <strong>{tool.toolName}</strong>
        <span>{tool.isError ? <XCircle size={15} /> : tool.status === "running" ? <Clock3 size={15} /> : <CheckCircle2 size={15} />}{tool.status}</span>
      </div>
      {tool.command ? <pre>{tool.command}</pre> : null}
      <div className="tool-lifecycle">
        {tool.lifecycle.map((step, index) => <Tag key={`${step.timestamp}:${index}`}>{step.eventType.replaceAll("_", " ")}</Tag>)}
      </div>
      {tool.isError ? <Alert type="error" showIcon message={tool.resultPreview || "工具执行失败"} /> : (
        <pre className="tool-output">{tool.resultPreview || "暂无工具输出"}</pre>
      )}
    </div>
  );
}

function roleToken(role: Role): string {
  return String(role || "runtime").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}
