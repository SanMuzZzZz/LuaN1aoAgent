# conf/config.py
# 配置文件：存放API密钥、模型参数等核心配置项
# 注意：请勿将真实API密钥提交到版本控制系统

import os
from dotenv import load_dotenv

# 从.env文件加载环境变量
load_dotenv()

# ============================================================================
# 核心场景配置 (Scenario Configuration)
# ============================================================================

# 运行场景模式
# "general": 通用模式，适用于实战渗透、内网渗透等复杂环境（默认）
# "ctf": CTF模式，针对CTF夺旗赛优化（会禁用部分大规模扫描工具，启用特定Prompt优化）
SCENARIO_MODE = os.getenv("SCENARIO_MODE", "general").lower()

# ============================================================================
# 输出配置 (Output Configuration)
# ============================================================================

# 控制台输出模式: "simple", "default", "debug"
# "simple": 精简输出,只展示核心信息
# "default": 标准输出,提供正常调试所需信息
# "debug": 详细输出,等同于 --verbose,提供所有调试信息
OUTPUT_MODE = os.getenv("OUTPUT_MODE", "default").lower()

# ============================================================================
# LLM API 配置
# ============================================================================

# 从环境变量读取配置，如果环境变量不存在则使用默认值
LLM_API_BASE_URL = os.getenv("LLM_API_BASE_URL", "https://api.openai.com/v1")
LLM_API_KEY = os.getenv("LLM_API_KEY")  # 请在.env文件中设置
LLM_FALLBACK_API_KEY = os.getenv("LLM_FALLBACK_API_KEY")  # 备选API密钥，用于处理429错误


# ============================================================================
# LLM模型配置
# ============================================================================

# 为不同角色/模块定义语言模型
# 核心思想：允许为每个关键模块（规划、执行、反思）使用不同的模型，以平衡成本、速度和能力
# 例如，Planner可以使用最强大的模型来确保计划质量，而Executor可以使用速度更快、成本更低的模型
LLM_MODELS = {
    "default": os.getenv("LLM_DEFAULT_MODEL", "gpt-4o"),
    "planner": os.getenv("LLM_PLANNER_MODEL", "gpt-4o"),
    "executor": os.getenv("LLM_EXECUTOR_MODEL", "gpt-4o"),
    "reflector": os.getenv("LLM_REFLECTOR_MODEL", "gpt-4o"),
    "expert_analysis": os.getenv("LLM_EXPERT_MODEL", "gpt-4o"),
}

# 为不同角色设置独立的LLM温度参数
# 较高的温度(如0.7)增加输出多样性，适合创造性任务
# 较低的温度(如0.2)增加输出确定性，适合需要精确性的任务
LLM_TEMPERATURES = {
    "default": 0.3,
    "planner": 0.5,  # 规划器需要一定创造性来生成多样化策略
    "executor": 0.3,  # 执行器需要稳定可靠的工具调用
    "reflector": 0.2,  # 反思器需要精确的分析和判断
    "expert_analysis": 0.7,  # 专家分析需要更多创造性思维
}

# ============================================================================
# LLM高级配置
# ============================================================================

# 是否启用OpenAI兼容接口的extra_body字段，用于传递供应商自定义参数（如思考模式thinking）
# 设置为True后，如果下方LLM_THINKING为非off，将在请求payload中注入{"extra_body": {"thinking": "hidden|visible"}}
LLM_EXTRA_BODY_ENABLED = os.getenv("LLM_EXTRA_BODY_ENABLED", "false").lower() == "true"

# 为不同角色配置是否开启“思考模式”（extra_body.thinking）
# 取值说明：
# - off: 不启用思考模式（不注入extra_body）
# - hidden: 启用但不在最终输出中显示思考过程（由具体供应商决定具体行为）
# - visible: 启用并在最终输出中返回思考过程（例如返回reasoning_content或思维链）
# 注意：该参数仅在OpenAI兼容API且供应商支持extra_body.thinking时生效
LLM_THINKING = {
    "default": os.getenv("LLM_DEFAULT_THINKING", "off"),
    "planner": os.getenv("LLM_PLANNER_THINKING", os.getenv("LLM_DEFAULT_THINKING", "off")),
    "executor": os.getenv("LLM_EXECUTOR_THINKING", os.getenv("LLM_DEFAULT_THINKING", "off")),
    "reflector": os.getenv("LLM_REFLECTOR_THINKING", os.getenv("LLM_DEFAULT_THINKING", "off")),
    "expert_analysis": os.getenv("LLM_EXPERT_THINKING", os.getenv("LLM_DEFAULT_THINKING", "off")),
}

# ============================================================================
# LLM提供商配置
# ============================================================================

# LLM Provider: "openai"或"anthropic"
# 支持使用不同的LLM提供商，可根据需求切换
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "openai")

# Anthropic API配置（如使用Claude模型）
ANTHROPIC_API_BASE_URL = os.getenv("ANTHROPIC_API_BASE_URL", "https://api.anthropic.com/v1/messages")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", LLM_API_KEY)  # 默认使用主API密钥
ANTHROPIC_FALLBACK_API_KEY = os.getenv("ANTHROPIC_FALLBACK_API_KEY", LLM_FALLBACK_API_KEY)
ANTHROPIC_VERSION = os.getenv("ANTHROPIC_VERSION", "2023-06-01")

# Anthropic模型映射
ANTHROPIC_MODELS = {
    "default": os.getenv("ANTHROPIC_DEFAULT_MODEL", "claude-3-5-sonnet-20240620"),
    "planner": os.getenv("ANTHROPIC_PLANNER_MODEL", "claude-3-5-sonnet-20240620"),
    "executor": os.getenv("ANTHROPIC_EXECUTOR_MODEL", "claude-3-5-sonnet-20240620"),
    "reflector": os.getenv("ANTHROPIC_REFLECTOR_MODEL", "claude-3-5-sonnet-20240620"),
    "expert_analysis": os.getenv("ANTHROPIC_EXPERT_MODEL", "claude-3-5-sonnet-20240620"),
}

# ============================================================================
# 执行器行为配置
# ============================================================================

# 执行器最大步数限制
EXECUTOR_MAX_STEPS = int(os.getenv("EXECUTOR_MAX_STEPS", "8"))

# 消息历史压缩阈值
EXECUTOR_MESSAGE_COMPRESS_THRESHOLD = int(os.getenv("EXECUTOR_MESSAGE_COMPRESS_THRESHOLD", "12"))

# Token数量压缩阈值
EXECUTOR_TOKEN_COMPRESS_THRESHOLD = int(os.getenv("EXECUTOR_TOKEN_COMPRESS_THRESHOLD", "80000"))

# 无新产出物的耐心值（连续多少步无产出则终止）
EXECUTOR_NO_ARTIFACTS_PATIENCE = int(os.getenv("EXECUTOR_NO_ARTIFACTS_PATIENCE", "10"))

# 失败阈值（连续失败多少次触发策略切换）
EXECUTOR_FAILURE_THRESHOLD = int(os.getenv("EXECUTOR_FAILURE_THRESHOLD", "3"))

# 上下文压缩时保留的最近消息数
EXECUTOR_RECENT_MESSAGES_KEEP = int(os.getenv("EXECUTOR_RECENT_MESSAGES_KEEP", "6"))

# 最小压缩消息阈值
EXECUTOR_MIN_COMPRESS_MESSAGES = int(os.getenv("EXECUTOR_MIN_COMPRESS_MESSAGES", "5"))

# 执行轮次压缩间隔
EXECUTOR_COMPRESS_INTERVAL = int(os.getenv("EXECUTOR_COMPRESS_INTERVAL", "5"))

# 执行轮次压缩时的消息数阈值
EXECUTOR_COMPRESS_INTERVAL_MSG_THRESHOLD = int(os.getenv("EXECUTOR_COMPRESS_INTERVAL_MSG_THRESHOLD", "8"))

# 工具调用超时时间（秒）
EXECUTOR_TOOL_TIMEOUT = int(os.getenv("EXECUTOR_TOOL_TIMEOUT", "120"))

# 执行器观察结果的最大长度（字符），超过此长度将被截断
EXECUTOR_MAX_OUTPUT_LENGTH = int(os.getenv("EXECUTOR_MAX_OUTPUT_LENGTH", "50000"))

# ============================================================================
# 上下文管理配置
# ============================================================================

# 规划历史保留窗口大小
PLANNER_HISTORY_WINDOW = int(os.getenv("PLANNER_HISTORY_WINDOW", "15"))

# 反思日志保留窗口大小
REFLECTOR_HISTORY_WINDOW = int(os.getenv("REFLECTOR_HISTORY_WINDOW", "15"))

# ============================================================================
# Web 服务配置
# ============================================================================

# Web UI 服务端口
WEB_PORT = int(os.getenv("WEB_PORT", "8000"))

# ============================================================================
# 知识服务配置
# ============================================================================

# 知识服务端口
KNOWLEDGE_SERVICE_PORT = int(os.getenv("KNOWLEDGE_SERVICE_PORT", "8081"))

# 知识服务 Host
KNOWLEDGE_SERVICE_HOST = os.getenv("KNOWLEDGE_SERVICE_HOST", "127.0.0.1")

# 知识服务 URL
KNOWLEDGE_SERVICE_URL = os.getenv("KNOWLEDGE_SERVICE_URL", f"http://{KNOWLEDGE_SERVICE_HOST}:{KNOWLEDGE_SERVICE_PORT}")