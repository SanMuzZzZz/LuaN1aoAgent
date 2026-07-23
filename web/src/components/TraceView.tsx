import { Alert, Button, Collapse, Empty, Segmented, Tag, Typography } from "antd";
import { ArrowDownUp, BrainCircuit, CheckCircle2, Clock3, PlayCircle, TerminalSquare, XCircle } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import { useLanguage, type Locale } from "../language";
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

export function TraceView(props: TraceViewProps) {
  const { t } = useLanguage();
  const roleOptions = [
    { label: t("trace.all"), value: "all" },
    { label: "Planner", value: "planner" },
    { label: "Executor", value: "executor" },
    { label: "Observer", value: "observer" }
  ];
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
          {t(props.newestFirst ? "trace.newestFirst" : "trace.chronological")}
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
        ) : <Empty description={t("trace.empty")} />}
      </div>
    </div>
  );
}

export function TraceCard({ item, selected, onSelect }: { item: TraceItem; selected: boolean; onSelect: () => void }) {
  const { locale, t } = useLanguage();
  const display = (value?: string) => localizeTracePresentation(value, locale);
  const details = [
    [t("trace.decision"), item.decision],
    [t("trace.observation"), item.tool ? undefined : item.observation],
    [t("trace.next"), display(item.next)],
    [t("trace.eventChain"), item.detail]
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
          <div className="trace-role-line"><i />{roleLabel(item.role)} · {display(item.eventLabel) || item.eventType}</div>
          <Typography.Title level={4}>{display(item.title)}</Typography.Title>
        </div>
        <Tag>{display(item.stage)}</Tag>
      </div>
      <div className="trace-preview">
        <div className="trace-preview-block thought">
          <span><BrainCircuit size={15} />{t(item.intentSource === "recorded" ? "trace.recordedIntent" : item.intentSource === "structured" ? "trace.structuredIntent" : "trace.derivedIntent")}</span>
          <p>{item.intentSource === "derived" ? display(item.summary) : item.summary || t("trace.noSummary")}</p>
        </div>
        <div className="trace-preview-block action">
          <span><PlayCircle size={15} />{t("trace.action")}</span>
          <p>{display(item.action) || t("trace.noAction")}</p>
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
            label: t("trace.expandDetails"),
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
                    label: t(item.eventType === "agent_action" || item.eventType === "tool_execution" ? "trace.aggregatedEvent" : "trace.rawEvent"),
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

function ToolRun({ item }: { item: TraceItem }) {
  const { t } = useLanguage();
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
      {tool.isError ? <Alert type="error" showIcon message={tool.resultPreview || t("trace.toolFailed")} /> : (
        <pre className="tool-output">{tool.resultPreview || t("trace.noToolOutput")}</pre>
      )}
    </div>
  );
}

function localizeTracePresentation(value: string | undefined, locale: Locale): string | undefined {
  if (!value || locale === "zh-CN") return value;
  const exact: Record<string, string> = {
    "执行动作": "Execution action",
    "规划判断": "Planning decision",
    "监督判断": "Supervision decision",
    "证据投影": "Evidence projection",
    "证据归档": "Evidence archived",
    "任务结果": "Task result",
    "思考与行动": "Reasoning and action",
    "执行中": "Running",
    "动作失败": "Action failed",
    "Executor 读取任务资料": "Executor reads task material",
    "Executor 读取关联 Artifact": "Executor reads a related artifact",
    "Executor 执行验证": "Executor runs validation",
    "Executor 归档执行证据": "Executor archives execution evidence",
    "Executor 提交任务结果": "Executor submits the task result",
    "Executor 执行动作": "Executor executes an action",
    "Planner 请求用户输入": "Planner requests user input",
    "Planner 更新任务计划": "Planner updates the task plan",
    "Observer 提交监督判断": "Observer submits a supervision decision",
    "Observer 更新三图": "Observer updates the tri-graph",
    "工具仍在运行或等待最终事件。": "The tool is still running or awaiting its final event.",
    "规划决策已提交，等待 Controller 应用任务图变更。": "The planning decision was submitted; waiting for Controller to apply the task graph changes.",
    "监督判断已提交，等待 Controller 执行控制信号。": "The supervision decision was submitted; waiting for Controller to apply the control signal.",
    "图增量已提交，等待 Runtime 校验并合并。": "The graph delta was submitted; waiting for Runtime validation and merge.",
    "任务结果已提交，等待 Controller 与 Planner 更新任务状态。": "The task result was submitted; waiting for Controller and Planner to update task state.",
    "执行材料已归档，可供任务结果和后续步骤引用。": "Execution material was archived for task results and subsequent steps.",
    "工具调用已完成，等待 Executor 消化结果或推进任务。": "The tool call completed; waiting for Executor to process the result or advance the task.",
    "读取关联 Artifact，恢复此前执行产生的关键证据与上下文。": "Read the related artifact to restore evidence and context from earlier execution.",
    "执行受控 HTTP 验证，收集目标响应与直接证据。": "Run controlled HTTP validation and collect the target response and direct evidence.",
    "执行受控命令，验证当前任务目标并收集直接证据。": "Run a controlled command to validate the current objective and collect direct evidence.",
    "归档本轮关键证据与执行结果，供任务结论和后续步骤引用。": "Archive key evidence and results for the task conclusion and subsequent steps.",
    "汇总当前任务的验证结果、证据与后续建议，并提交任务状态。": "Summarize validation results, evidence, and recommendations, then submit task state.",
    "根据当前任务与图状态提交下一步规划决策。": "Submit the next planning decision based on current task and graph state.",
    "根据近期执行进展提交监督判断，决定 Executor 是否继续或收束。": "Submit a supervision decision based on recent progress to continue or conclude execution."
  };
  if (exact[value]) return exact[value];
  return value
    .replace(/^HTTP 验证 · /, "HTTP validation · ")
    .replace(/^执行验证命令(?: · )?/, "Validation command · ")
    .replace(/^读取资料 · /, "Read material · ")
    .replace(/^读取 Artifact · /, "Read artifact · ")
    .replace(/^归档 Artifact · /, "Archive artifact · ")
    .replace(/^提交任务结果 · /, "Submit task result · ")
    .replace(/^提交监督信号 · /, "Submit supervision signal · ")
    .replace(/^提交图增量 · (\d+) 节点 \/ (\d+) 关系$/, "Submit graph delta · $1 nodes / $2 relationships")
    .replace(/^对 (.+) 执行受控 HTTP 验证，收集响应与直接证据。$/, "Run controlled HTTP validation against $1 and collect the response and direct evidence.");
}

function roleToken(role: Role): string {
  return String(role || "runtime").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}
