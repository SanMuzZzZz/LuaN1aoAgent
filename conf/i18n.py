# conf/i18n.py
"""
Console output internationalization support.
Provides translated strings for executor.py, agent.py and other modules.

Usage:
    from conf.i18n import t
    console.print(Panel(t("halt_signal_detected"), style="bold yellow"))
"""
import os
from conf.config import PROMPT_LANGUAGE

_STRINGS = {
    "zh": {
        # === executor.py ===
        "halt_signal_detected": "🚩 检测到终止信号！任务已由其他组件完成或终止。",
        "context_compression_trigger": "🧠 触发智能压缩: {reason}",
        "compression_empty": "⚠️ 压缩摘要为空，保持原始消息历史",
        "compression_unnecessary": "⚠️ 无需压缩：历史消息不足或已是最优状态",
        "compression_failed": "❌ 上下文压缩失败: {error}",
        "llm_thought_title": "LLM思考 (结构化)",
        "subtask_step": "子任务{subtask_id} - 探索第{step}步",
        "action_result_truncated": "⚠️ 动作 {step_id} 结果过长已截断",
        "action_result_truncated_title": "警告",
        "executor_correction_title": "🤖 Executor: 请求修正",
        "subtask_complete": "LLM声明子任务 {subtask_id} 已完成。",
        "halt_signal_read_failed": "读取终止信号文件失败或格式无效，继续执行。",
        "halt_signal_read_failed_title": "警告",
        "max_steps_reached": "达到最大执行步数 {steps}，子任务结束。",
        "max_retries_reached": "达到最大重试次数。放弃执行。错误: {error}",
        "error_title": "错误",

        # === agent.py ===
        "task_init_title": "任务初始化",
        "task_init_body": "Task: {task_name}\nTask ID: {task_id}\nGoal: {goal}",
        "startup_info_title": "启动信息",
        "planner_title": "📋 Planner 输出",
        "reflector_title": "🔍 Reflector 输出",
        "subtask_start": "开始执行子任务: {task_id}",
        "subtask_complete_agent": "子任务 {task_id} 执行完成",
        "all_tasks_complete": "所有子任务已完成",
        "goal_achieved": "🎯 目标已达成！",
        "cycle_summary": "周期 {cycle} 完成",
        "resource_limit_title": "资源限制",
        "token_limit_reached": "已达到全局 Token 使用上限",
        "cycle_limit_reached": "已达到全局最大周期数",
        "hitl_plan_title": "📋 计划审批",
        "hitl_approve_prompt": "是否批准此计划？(y/n): ",
        "hitl_approved": "✅ 计划已批准",
        "hitl_rejected": "❌ 计划已拒绝",
        "signal_shutdown": "收到终止信号 ({signal})，正在优雅退出...",
    },
    "en": {
        # === executor.py ===
        "halt_signal_detected": "🚩 Halt signal detected! Task completed or terminated by another component.",
        "context_compression_trigger": "🧠 Intelligent compression triggered: {reason}",
        "compression_empty": "⚠️ Compression summary is empty, keeping original message history",
        "compression_unnecessary": "⚠️ Compression unnecessary: insufficient history or already optimal",
        "compression_failed": "❌ Context compression failed: {error}",
        "llm_thought_title": "LLM Thought (Structured)",
        "subtask_step": "Subtask {subtask_id} - Exploration Step {step}",
        "action_result_truncated": "⚠️ Action {step_id} result too long, truncated",
        "action_result_truncated_title": "Warning",
        "executor_correction_title": "🤖 Executor: Requesting Correction",
        "subtask_complete": "LLM declares subtask {subtask_id} complete.",
        "halt_signal_read_failed": "Failed to read halt signal file or invalid format, continuing execution.",
        "halt_signal_read_failed_title": "Warning",
        "max_steps_reached": "Reached max execution steps ({steps}), subtask ending.",
        "max_retries_reached": "Max retries reached. Giving up. Error: {error}",
        "error_title": "Error",

        # === agent.py ===
        "task_init_title": "Task Initialization",
        "task_init_body": "Task: {task_name}\nTask ID: {task_id}\nGoal: {goal}",
        "startup_info_title": "Startup Info",
        "planner_title": "📋 Planner Output",
        "reflector_title": "🔍 Reflector Output",
        "subtask_start": "Starting subtask: {task_id}",
        "subtask_complete_agent": "Subtask {task_id} completed",
        "all_tasks_complete": "All subtasks completed",
        "goal_achieved": "🎯 Goal achieved!",
        "cycle_summary": "Cycle {cycle} completed",
        "resource_limit_title": "Resource Limit",
        "token_limit_reached": "Global token usage limit reached",
        "cycle_limit_reached": "Global max cycle limit reached",
        "hitl_plan_title": "📋 Plan Approval",
        "hitl_approve_prompt": "Approve this plan? (y/n): ",
        "hitl_approved": "✅ Plan approved",
        "hitl_rejected": "❌ Plan rejected",
        "signal_shutdown": "Received termination signal ({signal}), gracefully shutting down...",
    },
}


def t(key: str, **kwargs) -> str:
    """
    Get translated string by key.
    
    Args:
        key: translation string key
        **kwargs: format parameters
        
    Returns:
        Translated and formatted string. Falls back to English if key not found in current language.
    """
    lang = PROMPT_LANGUAGE if PROMPT_LANGUAGE in _STRINGS else "zh"
    strings = _STRINGS[lang]
    
    template = strings.get(key)
    if template is None:
        # Fallback to English, then to key itself
        template = _STRINGS["en"].get(key, key)
    
    if kwargs:
        try:
            return template.format(**kwargs)
        except (KeyError, IndexError):
            return template
    return template
