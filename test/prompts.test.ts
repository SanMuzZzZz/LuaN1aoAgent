import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTOR_SYSTEM_PROMPT,
  OBSERVER_SUPERVISOR_SYSTEM_PROMPT,
  OBSERVER_PROJECTOR_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  renderExecutorInput,
  renderExecutorResumeInput,
  renderPlannerInput
} from "../src/prompts.js";
import type { GraphSnapshot, PlannerDecisionView, TaskEnvelope } from "../src/types.js";

test("executor prompt uses bounded experimental method and runtime steering", () => {
  const taskEnvelope: TaskEnvelope = {
    taskId: "task:test",
    goal: "Find flag",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: ["authorized target only"],
    successCriteria: ["flag found"],
    budget: { maxTurns: 12 }
  };
  const emptyGraph: GraphSnapshot = {
    view: "operation",
    nodes: [],
    edges: [],
    summary: {}
  };

  const input = renderExecutorInput({
    rootGoal: "Obtain flag{uuid}; candidate location /challenge/flag.txt",
    taskEnvelope,
    operationGraphSlice: emptyGraph,
    reasoningGraphSlice: { ...emptyGraph, view: "reasoning" },
    sessionRefs: [],
    toolCatalog: ["read", "bash", "grep", "find", "ls", "artifact_read", "artifact_write"],
    executionBrief: "No previous execution events.",
    dependencyOutcomes: "task:recon status=completed\n  result: upload endpoint confirmed",
    runtimeBudgetStatus: "turns: 0/12; remaining: 12"
  });

  assert.doesNotMatch(EXECUTOR_SYSTEM_PROMPT, /budget_status/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /先输出一句不超过 80 个汉字的可公开行动理由/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /缩小当前竞争解释或直接推进成功条件/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /先锁定当前因果边界/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /探索实验用于尚无正向基线的未知边界/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /确认实验用于已有可复现基线的机制/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /页面本来就存在的说明文字/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /请求脚本自己打印的标签不能证明/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /只改变一个变量/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /正负对照/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /调用 vulnerability_search 检索历史漏洞/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /公网结果只生成待验证 Hypothesis/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /检索空结果是弱反证/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /只能标记为 inconclusive/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /原始响应写入 artifact/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /末尾用一句自然语言总结/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /<example name="discriminating-test">/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /<example name="causal-boundary-and-oracle">/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /<example name="fingerprint-to-vulnerability-research">/);
  assert.doesNotMatch(input, /budget_status/);
  assert.match(input, /<runtime_budget>/);
  assert.match(input, /turns: 0\/12; remaining: 12/);
  assert.match(input, /<dependency_outcomes>/);
  assert.match(input, /upload endpoint confirmed/);
  assert.match(input, /<root_goal>/);
  assert.match(input, /\/challenge\/flag\.txt/);
  assert.doesNotMatch(input, /evidenceNeeded|证据要求/);
  assert.ok(input.length < 12_000, `Executor prompt too large: ${input.length}`);

  const resumeInput = renderExecutorResumeInput({
    rootGoal: "Obtain flag{uuid}; candidate location /challenge/flag.txt",
    taskEnvelope: { ...taskEnvelope, budget: { maxTurns: 16 } },
    plannerHint: "Use the confirmed file-read capability to close the remaining goal gap.",
    operationGraphSlice: emptyGraph,
    reasoningGraphSlice: { ...emptyGraph, view: "reasoning" },
    sessionRefs: [],
    executionBrief: "Previous epoch confirmed file-read capability.",
    dependencyOutcomes: "task:recon status=completed\n  result: upload endpoint confirmed",
    runtimeBudgetStatus: "turns: 0/16; remaining: 16"
  });
  assert.match(resumeInput, /继续执行同一个 Task/);
  assert.match(resumeInput, /<planner_hint>/);
  assert.match(resumeInput, /<operation_graph format="json">/);
  assert.match(resumeInput, /<dependency_outcomes>/);
  assert.match(resumeInput, /confirmed file-read capability/);
  assert.match(resumeInput, /\/challenge\/flag\.txt/);
  assert.doesNotMatch(resumeInput, /evidenceNeeded|证据要求/);
});

test("planner prompt teaches evidence-aware planning without an intermediate contract", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /priority 数字越小优先级越高，1 是最高优先级/);
  assert.match(PLANNER_SYSTEM_PROMPT, /每次 invocation 合计最多检索 3 次/);
  assert.match(PLANNER_SYSTEM_PROMPT, /completed 只表示该 Task 自己的 successCriteria 全部满足/);
  assert.match(PLANNER_SYSTEM_PROMPT, /partial 或 completed/);
  assert.match(PLANNER_SYSTEM_PROMPT, /不要为了调度后继 Task 删除真实依赖/);
  assert.match(PLANNER_SYSTEM_PROMPT, /所有 status=open 且 depends_on 已满足的 Task/);
  assert.match(PLANNER_SYSTEM_PROMPT, /archived 只用于停止仍为 open 的过期或重叠 Task/);
  assert.match(PLANNER_SYSTEM_PROMPT, /相互冲突的解释/);
  assert.match(PLANNER_SYSTEM_PROMPT, /能够消除关键不确定性的目标/);
  assert.match(PLANNER_SYSTEM_PROMPT, /续接任务应明确只解决该边界/);
  assert.match(PLANNER_SYSTEM_PROMPT, /Task 边界由你根据目标、成功条件和因果阶段判断/);
  assert.match(PLANNER_SYSTEM_PROMPT, /创建 dependent Task/);
  assert.match(PLANNER_SYSTEM_PROMPT, /通过 dependsOnTaskRefs 继承前驱阶段结果，不复用前驱 Session/);
  assert.match(PLANNER_SYSTEM_PROMPT, /不得反转依赖/);
  assert.match(PLANNER_SYSTEM_PROMPT, /版本由 Runtime 自动绑定并进行原子冲突检测/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="conflicting-observations">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="confirmed-capability">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="capability-chain-split">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /初始图只有 Goal\/Scope.*默认只创建一个入口认知 Task/s);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="initial-fanout">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="evidence-backed-parallelism">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /因为共享 Root Goal 就强制串行这些已经独立的分支/);
  assert.match(PLANNER_SYSTEM_PROMPT, /历史漏洞与目标适用性/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="known-vulnerability-research">/);
  assert.doesNotMatch(PLANNER_SYSTEM_PROMPT, /Runtime 会复用原 Executor Session/);
  assert.doesNotMatch(PLANNER_SYSTEM_PROMPT, /<example name="same-task-resume">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /decision 只能是 apply_commands/);
  assert.doesNotMatch(PLANNER_SYSTEM_PROMPT, /need_user_input/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /只有全部 successCriteria 满足时提交 completed/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /成功条件满足后立即调用 task_result_submit/);
});

test("planner prompt preserves the latest active TaskResult beyond the old 160 character boundary", () => {
  const keyCapability = "admin_token=internal_admin_token_2024";
  const resultSummary = `${"已验证常规入口但尚未完成最终目标。".repeat(14)}${keyCapability}；内部服务已确认可达。`;
  assert.ok(resultSummary.indexOf(keyCapability) > 160);
  const view: PlannerDecisionView = {
    view: "planner_decision",
    rootRefs: { goalRef: "goal:root", scopeRef: "scope:root" },
    taskLedger: [{
      taskId: "task:internal-api",
      status: "partial",
      goal: "Use the confirmed internal access path",
      resultSummary,
      retryable: true,
      attempt: 1,
      priority: 1,
      dependsOnTaskRefs: []
    }],
    reasoningDigest: [],
    operationDigest: [],
    blockers: [],
    graphSummary: { nodeCount: 1, edgeCount: 0, taskStatusCounts: { partial: 1 } },
    runtimeTail: [{
      taskId: "task:internal-api",
      committedSeq: 0,
      desiredSeq: 42,
      digest: `o9:task_outcome:ok outcome=${resultSummary}`
    }],
    retrievalHints: {
      tools: ["graph_query", "graph_trace"],
      note: "Read more only when needed"
    }
  };

  const input = renderPlannerInput({
    userGoal: "Recover the authorized target artifact",
    scopeSummary: "Authorized target only",
    plannerDecisionView: view
  });

  assert.match(input, /admin_token=internal_admin_token_2024/);
  assert.match(input, /"goalRef":"goal:root"/);
  assert.match(input, /"scopeRef":"scope:root"/);
  assert.ok(input.length < 8_000, `Planner prompt too large: ${input.length}`);
});

test("projector prompt requests semantic changes instead of one node per observation", () => {
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /语义变化集/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /多个 observation 支持同一事实时合并/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /已有节点已表达该事实时更新 existing 别名/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /禁止写入或连接 Task、Milestone、Blocker、Goal、Scope/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Evidence 只描述 observation 直接支持的事实/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /错误投影：Evidence 声称“确认后端调用 request\.json\.get\('url'\)”/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /直接 GET 返回 404 不能证明文件在所有访问方式下不存在/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /确认实验没有可复现基线/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /不得据此创建“该机制无效”/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /executor_interpretation 是 Executor/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /不能单独作为 Evidence/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /<example name="semantic-merge">/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /检查近期实验是否真正减少不确定性/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /同时改变多个独立条件后统一失败/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /新的 URL、payload、字段名、工具输出或不同 stdout 指纹本身不等于进展/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /页面静态说明、全局关键词、请求脚本自己打印的标签不能证明/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /只评价当前因果边界最近窗口的进展/);
});
