# -*- coding: utf-8 -*-
"""
MCP服务主框架 - 基于FastMCP实现的安全工具集成层.

本模块提供了统一的MCP (Model Control Protocol) 服务接口,
封装了各类安全测试工具,供上层Agent调用。

主要功能:
    - HTTP/HTTPS请求工具
    - Shell命令执行工具
    - 元认知工具(思考、假设、反思、专家分析)
    - 任务终止控制

设计原则:
    - 通用性: 支持多种渗透测试场景
    - 可扩展: 便于添加新工具
    - 错误处理: 完善的异常捕获和错误报告
"""

import asyncio
import json
import subprocess
import time
import logging
from typing import Dict, Any, List
import sys
import os
from collections import deque
import httpx
import requests

# Add project root to sys.path to allow imports from conf
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

try:
    from conf.config import SCENARIO_MODE, KNOWLEDGE_SERVICE_URL
except ImportError:
    # Fallback defaults if config cannot be loaded
    SCENARIO_MODE = "general"
    KNOWLEDGE_SERVICE_URL = "http://127.0.0.1:8081"

# 导入 MCP 相关库，增加错误处理
try:
    import mcp.server
    # 尝试导入 FastMCP，如果 mcp.server 中没有，可能在 fastmcp 包中
    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError:
        try:
            from fastmcp import FastMCP
        except ImportError:
            FastMCP = None
            
    from mcp.server.lowlevel import Server
except ImportError as e:
    # 如果导入失败，创建一个伪造的 mcp_server_module 以避免立即崩溃，
    # 但在运行时会报错。
    logging.error(f"Critical Import Error: Failed to import 'mcp'. Please run 'pip install mcp'. Details: {e}")
    mcp_server_module = None
    FastMCP = None
    Server = None

# 设置环境变量，抑制不必要的输出和警告
os.environ.setdefault("FASTMCP_NO_BANNER", "1")
os.environ.setdefault("FASTMCP_LOG_LEVEL", "WARNING")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")  # 禁用 CUDA
import warnings

warnings.filterwarnings("ignore", category=UserWarning, module="torch.cuda")
warnings.filterwarnings("ignore", category=FutureWarning)

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(), logging.FileHandler(os.path.join(os.path.dirname(__file__), "../logs/mcp_service.log"))],
)
logger = logging.getLogger(__name__)

# 配置特定库的日志级别以减少冗余输出
logging.getLogger('mcp.server.lowlevel.server').setLevel(logging.WARNING)
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpx.AsyncClient').setLevel(logging.WARNING) # 针对 httpx AsyncClient 的更具体配置


# 兼容 fastmcp.FastMCP 或 mcp.server.Server
MCPServerClass = None

if FastMCP:
    MCPServerClass = FastMCP
elif Server:
    MCPServerClass = Server
else:
    # Fallback or error if neither is found
    if mcp_server_module and hasattr(mcp_server_module, "FastMCP"):
        MCPServerClass = getattr(mcp_server_module, "FastMCP")
    elif mcp_server_module and hasattr(mcp_server_module, "Server"):
        MCPServerClass = getattr(mcp_server_module, "Server")

if MCPServerClass is None:
    raise ImportError("无法找到可用的 MCP Server 类 (FastMCP 或 Server)。请确保安装了 'mcp' 或 'fastmcp'。")

# 初始化 MCP 服务实例
mcp = MCPServerClass("LuaN1ao-mcp")

# Shared session context for all tools in this service
_httpx_client = httpx.AsyncClient(verify=False)  # 忽略SSL证书验证


_THINK_HISTORY_LIMIT = 50
_think_history: deque[Dict[str, Any]] = deque(maxlen=_THINK_HISTORY_LIMIT)


@mcp.tool()
def think(
    analysis: str,
    problem: str,
    reasoning_steps: List[str],
    conclusion: str,
) -> str:
    """
    结构化思考与推理工具 (元认知工具)。用于深度分析问题，或在陷入僵局时明确识别知识缺口。

    :param analysis: 对当前情况或上下文的简要分析。
    :param problem: 你正在试图解决的具体问题或需要做出的决策。
    :param reasoning_steps: 一个字符串列表，详细列出你的推理过程。
    :param conclusion: 基于以上推理得出的最终结论或下一步行动的摘要。
    """
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    entry = {
        "type": "structured_thought",
        "timestamp": timestamp,
        "analysis": analysis,
        "problem": problem,
        "reasoning_steps": reasoning_steps,
        "conclusion": conclusion,
    }

    # 思考历史记录现在可以存储更结构化的数据
    _think_history.append(entry)

    payload = {
        "result": "ok",
        "message": "结构化思考过程已记录。",
        "recorded_thought": entry,
    }

    return json.dumps(payload, ensure_ascii=False, indent=2)


# 延迟初始化全局组件，避免启动时加载
_llm_client = None


def get_llm_client():
    """获取全局 LLM 客户端实例（延迟加载）"""
    global _llm_client
    if _llm_client is None:
        try:
            from llm.llm_client import LLMClient
        except ImportError as e:
            # 如果相对导入失败,尝试绝对导入
            import sys
            from pathlib import Path
            project_root = Path(__file__).parent.parent
            if str(project_root) not in sys.path:
                sys.path.insert(0, str(project_root))
            try:
                from llm.llm_client import LLMClient
            except ImportError:
                raise ImportError(
                    f"无法导入 LLMClient: {e}. "
                    f"请检查项目结构和 PYTHONPATH 配置。"
                    f"当前 sys.path: {sys.path}"
                )
        
        _llm_client = LLMClient()
    return _llm_client


# 全局任务ID，由agent在启动时设置
# CURRENT_TASK_ID = None (已移除，改用参数传递)


@mcp.tool()
def complete_mission(reason: str, evidence: str, task_id: str) -> str:
    """
    任务完成信号工具(高优先级).

    当且仅当你100%确定顶层任务目标已完全达成时调用此工具。
    此工具将立即成功地终止整个任务和所有其他并行的子任务。

    使用场景示例:
        - 获取了目标系统的shell访问权限
        - 提取到了目标数据库的敏感信息
        - 找到了目标凭证或证据
        - 成功验证了关键漏洞的存在性

    Args:
        reason: 任务完成的详细理由说明
        evidence: 关键证据（如shell命令输出、数据库内容、API响应等）
        task_id: 当前任务的唯一ID

    Returns:
        str: 确认任务完成信号已发出的JSON字符串

    Raises:
        无: 所有异常均被捕获并以JSON格式返回错误信息
    """
    try:
        ev = evidence.strip() if isinstance(evidence, str) else ""

        # 创建终止信号文件
        halt_file_path = f"/tmp/{task_id}.halt"
        with open(halt_file_path, "w", encoding="utf-8") as f:
            json.dump({"reason": reason, "evidence": ev}, f, ensure_ascii=False, indent=2)

        return json.dumps(
            {"success": True, "message": "任务完成信号已发送。终止文件中已记录理由和证据。"}, ensure_ascii=False
        )

    except (OSError, IOError) as e:
        logger.error(f"文件写入错误: {e}")
        return json.dumps({"success": False, "error": f"无法写入终止文件: {e}"}, ensure_ascii=False)
    except Exception as e:
        logger.exception("发送终止信号时发生未预期的错误")
        return json.dumps({"success": False, "error": f"发送终止信号失败: {e}"}, ensure_ascii=False)


@mcp.tool()
def formulate_hypotheses(hypotheses: List[Dict[str, Any]]) -> str:
    """
    提出假设工具 (元认知工具)。用于在陷入僵局时，系统性地提出新的攻击可能性。
    使用时机和范例请参考主提示词中的“指导原则”部分。

    :param hypotheses: 一个假设对象的列表。每个对象**必须**是一个包含 'description'(str) 和 'confidence'(float, 0.0-1.0) 键的字典。
    :return: 一个确认假设已记录的JSON字符串。
    """
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # Log the hypotheses for traceability
    hypotheses_record = {"type": "hypothesis_formulation", "timestamp": timestamp, "hypotheses": hypotheses}

    # The real value is forcing the LLM to perform this structured thinking step.
    return json.dumps(
        {
            "success": True,
            "status": "Hypotheses recorded. Now, select your highest-confidence hypothesis and design an action to test it.",
            "hypotheses_record": hypotheses_record,
        },
        ensure_ascii=False,
        indent=2,
    )


@mcp.tool()
def reflect_on_failure(failed_action: Dict[str, Any], error_message: str) -> str:
    """
    失败反思工具 (元认知工具)。用于在动作失败后进行结构化的根因分析。
    使用时机和范例请参考主提示词中的“指导原则”部分。

    :param failed_action: 执行失败的整个action对象，包含'tool'和'params'。
    :param error_message: 工具返回的明确错误信息。
    :return: 一个确认反思已记录的JSON字符串。
    """

    # 这个工具的核心价值在于引导LLM进行结构化思考，而不是执行复杂的后端逻辑。
    # 它强制LLM将失败作为一个明确的事件来处理。

    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    reflection_record = {
        "type": "failure_reflection",
        "timestamp": timestamp,
        "failed_action": failed_action,
        "error_message": error_message,
    }

    # 可以在这里将记录保存到日志或专门的失败分析文件中
    logger.info(f"失败反思已记录: {reflection_record}")

    return json.dumps(
        {
            "success": True,
            "status": "Reflection recorded. Now, you must analyze the failure in your 'thought' process and propose a corrected action.",
            "reflection_record": reflection_record,
        },
        ensure_ascii=False,
        indent=2,
    )


@mcp.tool()
async def expert_analysis(question: str, context_data: str = "") -> str:
    """
    专家分析工具 (元认知工具)。用于请求独立的、深度的问题分析。
    使用时机和范例请参考主提示词中的“指导原则”部分。
    触发条件：当知识库（RAG）已进行至少两轮不同关键词/源类型检索仍无法获得有效知识，或问题涉及未知格式/算法、复杂正则过滤、黑盒协议逆向等高难度领域。
    调用建议：在 `context_data` 中附上失败的检索词、源类型、关键证据（错误信息、源码片段、日志、请求/响应样本）与当前假设状态，以便专家快速定位。

    :param question: 你需要专家回答的具体问题。这个问题应该尽可能清晰、具体。可以使用伪代码来描述你希望专家分析的算法或逻辑。
    :param context_data: (可选) 解决问题所需的所有相关数据，例如代码片段、token字符串、错误信息等。
    :return: 一个包含专家级分析和建议的详细报告。
    """
    try:
        # 专门为专家分析设计的、独立的系统提示词
        expert_system_prompt = (
            "你是一位世界级的网络安全研究员、逆向工程师和Python专家。"
            "你精通分析复杂数据结构、加密算法和序列化格式（如pickle）。"
            "一位初级智能体向你升级了一个难题。你的任务是提供详细、循序渐进且具有教学意义的分析。"
            "你的回答必须清晰、精确且可直接操作。首先简要陈述你对问题的宏观理解，"
            "然后提供解决该问题的详细分步计划。最后总结关键要点。"
        )

        # 构造发送给“专家”模型的消息
        expert_messages = [
            {"role": "system", "content": expert_system_prompt},
            {
                "role": "user",
                "content": f"Here is the problem and the relevant data:\n\n**Problem/Question:**\n{question}\n\n**Contextual Data:**\n```\n{context_data}\n```",
            },
        ]

        # 使用全局的 llm_client 实例进行调用
        llm = get_llm_client()
        # 对专家分析不强制JSON模式，避免某些提供商在JSON模式下返回错误
        content, call_metrics = await llm.send_message(expert_messages, role="expert_analysis", expect_json=False)

        model_used = llm.models.get("expert_analysis") or llm.models.get("default")

        return json.dumps(
            {
                "success": True,
                "provider": llm.provider,
                "model": model_used,
                "report": content,
                "metrics": call_metrics or {},
            },
            ensure_ascii=False,
            indent=2,
        )

    except ImportError as e:
        logger.error(f"LLM客户端导入失败: {e}")
        return json.dumps(
            {
                "success": False,
                "error_type": "CONFIGURATION",
                "error": f"LLM客户端配置错误: {str(e)}",
                "fix_suggestion": "请检查LLM客户端配置和依赖",
            },
            ensure_ascii=False,
            indent=2,
        )
    except ConnectionError as e:
        logger.error(f"LLM服务连接失败: {e}")
        return json.dumps(
            {
                "success": False,
                "error_type": "CONNECTION",
                "error": f"无法连接到LLM服务: {str(e)}",
                "fix_suggestion": "请检查网络连接和LLM服务状态",
            },
            ensure_ascii=False,
            indent=2,
        )
    except Exception as e:
        logger.exception("专家分析工具执行失败")
        return json.dumps(
            {
                "success": False,
                "error_type": "RUNTIME",
                "error": f"专家分析失败: {str(e)}",
                "fix_suggestion": "请检查输入参数和系统配置",
            },
            ensure_ascii=False,
            indent=2,
        )


@mcp.tool()
async def retrieve_knowledge(
    query: str, top_k: int = 5, service_url: str = None
) -> str:
    """
    从集中式知识库服务中进行语义检索。

    扫描 knowledge_base 目录下的所有文档。
    包括：
    - 攻击技术和绕过方法
    - 漏洞利用手册
    等

    **使用场景**：
    - 需要查找特定攻击技术时（如"SQL注入绕过WAF"）
    - 遇到陌生漏洞需要参考案例时
    - 需要了解某个工具的使用方法时
    - 寻找类似问题的解决方案时

    **最佳实践**：
    - 使用具体的技术术语作为查询词（如"LFI path traversal"而非"文件漏洞"）

    Args:
        query: 查询问题或关键字，例如 "如何绕过SQL注入的WAF过滤" 或 "SSRF漏洞利用方法"
        top_k: 希望检索出的最相关知识条目数量（1-10，推荐5）
        service_url: 知识服务URL（可选，默认从环境变量 KNOWLEDGE_SERVICE_URL 读取，或回退到 localhost）

    Returns:
        包含检索结果的JSON字符串，格式：
        {
            "success": bool,
            "query": str,
            "total_results": int,
            "results": [
                {
                    "id": str,
                    "snippet": str,  # 相关内容片段
                    "score": float,  # 相似度分数（0-1，越高越相关）
                },
                ...
            ]
        }

    示例：
        # 查找SQL注入相关技术
        result = await retrieve_knowledge("SQL injection WAF bypass", top_k=3)
    """
    # 动态确定服务 URL
    if not service_url:
        service_url = KNOWLEDGE_SERVICE_URL

    try:
        response = await _httpx_client.post(
            f"{service_url}/retrieve_knowledge", json={"query": query, "top_k": top_k}, timeout=30
        )
        response.raise_for_status()
        return json.dumps(response.json(), ensure_ascii=False, indent=2)
    except httpx.RequestError as e:
        return json.dumps(
            {
                "success": False,
                "error": f"无法连接到知识库服务 ({service_url}): {e}",
                "suggestion": "请确保知识服务已启动（agent.py 会自动启动）",
            },
            ensure_ascii=False,
            indent=2,
        )
    except Exception as e:
        return json.dumps({"success": False, "error": f"检索知识时发生错误: {e}"}, ensure_ascii=False, indent=2)


@mcp.tool()
def shell_exec(command: str) -> str:
    """
    Shell命令执行接口。实时将输出打印到终端。
    禁止执行mcp服务中已提供的工具，如dirsearch等
    :param command: 要执行的shell命令（如"ls -al"）
    :return: 命令输出结果
    """
    output_lines = []
    try:
        process = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        # Real-time output
        for line in iter(process.stdout.readline, ""):
            output_lines.append(line)

        process.stdout.close()
        return_code = process.wait()

        full_output = "".join(output_lines)

        if return_code != 0:
            error_message = f"Command '{command}' returned non-zero exit status {return_code}."
            error_type = "RUNTIME"
            fix_suggestion = "Check the command's arguments and permissions."
            if "not found" in full_output or "No such file or directory" in full_output:
                error_type = "MISSING_TOOL"
                fix_suggestion = "The command or tool does not exist. Choose an alternative from the available tools."
            elif "Only 1 -p option allowed" in full_output:
                error_type = "SYNTAX"
                fix_suggestion = "Incorrect command syntax. Review the tool's help or manual for correct usage."

            return json.dumps(
                {
                    "success": False,
                    "output": full_output,
                    "error_type": error_type,
                    "message": error_message,
                    "fix_suggestion": fix_suggestion,
                }
            )

        return json.dumps({"success": True, "output": full_output, "error": ""})

    except FileNotFoundError as e:
        logger.warning(f"命令未找到: {e.filename}")
        return json.dumps(
            {
                "success": False,
                "output": "",
                "error_type": "MISSING_TOOL",
                "message": f"Command not found: {e.filename}. The tool does not appear to be installed or is not in the system's PATH.",
                "fix_suggestion": "Verify the tool is installed and its path is correct. If not, use an alternative available tool.",
            }
        )
    except subprocess.TimeoutExpired as e:
        logger.error(f"命令执行超时: {e}")
        return json.dumps(
            {
                "success": False,
                "output": "".join(output_lines) if output_lines else "",
                "error_type": "TIMEOUT",
                "message": f"Command execution timed out: {str(e)}",
                "fix_suggestion": "The command took too long to execute. Consider increasing timeout or optimizing the command.",
            }
        )
    except Exception as e:
        # 增强错误输出，确保agent感知具体失败原因
        logger.exception(f"shell_exec执行失败: {e}")
        detailed_error = f"{type(e).__name__}: {str(e)}"
        if not output_lines:
            detailed_error += "; No output captured before exception."
        return json.dumps(
            {
                "success": False,
                "output": "".join(output_lines) if output_lines else "",
                "error_type": "RUNTIME",
                "message": detailed_error,
                "fix_suggestion": "An unexpected error occurred during command execution. Check arguments, permissions, and environment.",
            }
        )


@mcp.tool()
def python_exec(script: str) -> str:
    """
    Python脚本执行接口。这是一个强大的通用代码执行工具。
    **警告：请勿使用此工具直接发送HTTP请求！** 对于所有网络请求，请务必使用 `http_request` 工具。
    **⚠️请注意需要显式设置之前工具、会话获取的cookie、session**
    **用于任何系统性、重复性测试（Fuzzing、爆破、盲注利用）的强制工具。** 当你需要迭代、循环或执行复杂逻辑时，必须使用此工具。它能让你编写脚本来批量发送HTTP请求、处理复杂数据或生成动态Payload。**禁止使用多个`http_request`来模拟循环。**
    此工具主要用于：
    - 批量fuzz、请求等等
    - 对 `http_request` 返回的复杂数据（如JSON, HTML）进行深度解析和信息提取（例如使用正则表达式）。
    - 对数据进行编码、解码、哈希或格式转换。
    - 实现 `http_request` 无法完成的、需要复杂计算或状态维持的自定义payload生成逻辑。
    - 执行文件操作或复杂的本地计算。
    :param script: 要执行的Python代码字符串。确保代码是自包含的，并通过 `print()` 输出结果。
    :return: 执行输出结果
    """
    import io

    old_stdout = sys.stdout
    old_stderr = sys.stderr
    sys.stdout = io.StringIO()
    sys.stderr = io.StringIO()
    try:
        # 1. Extract cookies from the shared httpx client
        session_cookies = _httpx_client.cookies

        # 2. Prepare the sandbox environment
        sandbox_session = requests.Session()
        sandbox_session.cookies.update(session_cookies)  # Inject cookies

        global_scope = {
            "requests": requests,
            "session": sandbox_session,  # Inject the session object
            "json": json,
        }

        # Add a syntax check before execution
        compile(script, "<string>", "exec")
        exec(script, global_scope)  # Execute with the injected scope
        output = sys.stdout.getvalue()
        error = sys.stderr.getvalue()
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        # 确保输出中的Unicode字符被正确解码
        return json.dumps({"success": True, "output": output, "error": error}, ensure_ascii=False)
    except SyntaxError as e:
        logger.error(f"Python语法错误: {e}")
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        return json.dumps(
            {
                "success": False,
                "error_type": "SYNTAX",
                "message": f"Python Syntax Error: {e}",
                "fix_suggestion": "Review the Python code for syntax errors before executing.",
            },
            ensure_ascii=False
        )
    except ImportError as e:
        logger.error(f"Python导入错误: {e}")
        output = sys.stdout.getvalue()
        error = sys.stderr.getvalue()
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        return json.dumps(
            {
                "success": False,
                "output": output,
                "error": error,
                "error_type": "IMPORT",
                "message": f"Import Error: {e}",
                "fix_suggestion": "Check that all required modules are available in the sandbox environment.",
            },
            ensure_ascii=False
        )
    except Exception as e:
        # 增强错误输出，确保agent感知具体失败原因
        logger.exception("python_exec执行失败")
        output = sys.stdout.getvalue()
        error = sys.stderr.getvalue()
        detailed_error = f"{type(e).__name__}: {str(e)}"
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        return json.dumps(
            {
                "success": False,
                "output": output,
                "error": error,
                "error_type": "RUNTIME",
                "message": detailed_error,
                "fix_suggestion": "An unexpected error occurred during Python code execution. Check syntax, imports, and environment.",
            },
            ensure_ascii=False
        )


@mcp.tool()
def dirsearch_scan(url: str, extensions: str = "php,html,js,txt", extra_args: str = "") -> str:
    """
    Dirsearch Web目录扫描。实时将输出打印到终端。
    :param url: 目标URL
    :param extensions: 扫描文件扩展名（如"php,html,js,txt"）
    :param extra_args: 其他Dirsearch参数
    :return: 扫描结果
    """
    cmd = ["dirsearch", "-u", url, "-e", extensions, "-q"]
    if extra_args:
        cmd += extra_args.split()

    output_lines = []
    try:
        process = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace"
        )

        for line in iter(process.stdout.readline, ""):
            output_lines.append(line)

        process.stdout.close()
        return_code = process.wait()
        full_output = "".join(output_lines)

        if return_code != 0:
            return json.dumps(
                {
                    "success": False,
                    "output": full_output,
                    "error": f"Command '{' '.join(cmd)}' returned non-zero exit status {return_code}.",
                }
            )

        return json.dumps({"success": True, "output": full_output, "error": ""})

    except FileNotFoundError as e:
        logger.warning(f"dirsearch工具未找到: {e}")
        return json.dumps(
            {
                "success": False,
                "output": "",
                "error_type": "MISSING_TOOL",
                "message": f"Dirsearch tool not found: {e.filename}",
                "fix_suggestion": "Install dirsearch or use alternative directory scanning methods.",
            }
        )
    except subprocess.TimeoutExpired as e:
        logger.error(f"dirsearch执行超时: {e}")
        return json.dumps(
            {
                "success": False,
                "output": "".join(output_lines) if output_lines else "",
                "error_type": "TIMEOUT",
                "message": f"Dirsearch execution timed out: {str(e)}",
                "fix_suggestion": "The scan took too long. Consider reducing scope or increasing timeout.",
            }
        )
    except Exception as e:
        logger.exception("dirsearch_scan执行失败")
        return json.dumps(
            {
                "success": False,
                "output": "".join(output_lines) if output_lines else "",
                "error_type": "RUNTIME",
                "message": f"Dirsearch execution failed: {str(e)}",
                "fix_suggestion": "Check tool availability, arguments, and target accessibility.",
            }
        )


def _coerce_bool(value, default=False):
    """将多种输入格式转换为布尔值。"""

    if value is None:
        return default

    if isinstance(value, bool):
        return value

    if isinstance(value, (int, float)):
        return bool(value)

    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "y", "on"}:
            return True
        if lowered in {"false", "0", "no", "n", "off"}:
            return False

    return default


@mcp.tool()
async def http_request(
    url: str,
    method: str = "GET",
    headers: dict = None,
    data: str | dict = None,
    timeout: int = 10,
    allow_redirects: bool | str | int | None = True,
    raw_mode: bool = False,
) -> str:
    """
    (首选)专业且健壮的HTTP请求工具，用于网络探测和安全测试。
    这是执行所有类型HTTP请求（GET, POST, PUT等）的首选方法，因为它提供了详细的请求/响应信息和自动化的会话管理。
    **重要：此工具使用一个持久化的会话，自动管理Cookie。**
    基础HTTP请求工具，**用于单次、探索性的请求**。**对于任何重复性、系统性的测试（如Fuzzing、盲注、爆破），你必须使用`python_exec`工具。**

    Args:
        url: 目标URL
        method: HTTP方法 (GET, POST, PUT, DELETE等)
        headers: HTTP头，以键值对形式提供。**重要：如果需要发送特定的HTTP头部（例如 `X-Requested-With`, `Cookie`, `Authorization`），必须在此参数中明确提供。**
        data: 请求体。可以是URL编码的字符串，也可以是表单数据的字典。
              **Content-Type 处理说明**：
              - 如果 `headers` 中已包含 `Content-Type`，则优先使用。
              - 如果 `data` 是字典且 `Content-Type` 未指定，将自动设置为 `application/x-www-form-urlencoded`。
              - 如果 `data` 是字符串且 `Content-Type` 未指定，将自动设置为 `application/x-www-form-urlencoded`。
              - 如果 `data` 是字典且 `Content-Type` 为 `application/json`，则 `data` 将被序列化为 JSON 字符串。
        timeout: 请求超时时间（秒）
        allow_redirects: 是否自动跟踪重定向。接受布尔值或对应的字符串（如"true", "false"）。默认为True。

    Returns:
        一个包含HTTP响应详细信息的JSON字符串。

    重要参数说明：
    - raw_mode: 当为 True 且 method 为 POST/PUT/PATCH 时，禁用自动表单编码，直接按原样发送请求体。
      用于安全测试场景（如 XSS 需要原始尖括号）避免因 URL/Form 编码导致 payload 失效。
    """
    try:
        start_time = time.time()

        # 准备请求参数
        follow_redirects = _coerce_bool(allow_redirects, default=True)

        request_params = {
            "url": url,
            "method": method.upper(),
            "timeout": timeout,
            "follow_redirects": follow_redirects,
        }

        # 准备headers
        request_headers = headers.copy() if headers else {}

        # 添加请求体数据
        prepared_body_preview = None
        encoding_mode = "none"
        if data and method.upper() in ["POST", "PUT", "PATCH"]:
            user_content_type = next((v for k, v in request_headers.items() if k.lower() == "content-type"), "").lower()

            if raw_mode:
                # 原始模式：不做任何URL/Form编码，按原文发送
                if isinstance(data, dict):
                    # 直接拼接为 key=value&key2=value2，不做 urlencode
                    try:
                        prepared_body = "&".join([f"{str(k)}={str(v)}" for k, v in data.items()])
                    except Exception:
                        prepared_body = str(data)
                else:
                    prepared_body = str(data)

                request_params["content"] = prepared_body.encode("utf-8")
                prepared_body_preview = prepared_body[:500]
                encoding_mode = "raw"
                if not user_content_type:
                    request_headers["Content-Type"] = "application/x-www-form-urlencoded"
            else:
                # 标准模式：遵循 Content-Type 进行编码
                if isinstance(data, dict):
                    # If data is a dict and Content-Type is application/json, send as JSON
                    if "application/json" in user_content_type:
                        request_params["json"] = data
                        prepared_body_preview = json.dumps(data)[:500]
                        encoding_mode = "json"
                    else:
                        # If data is a dict, httpx will urlencode it automatically
                        request_params["data"] = data
                        # 仅预览，不改变httpx实际编码
                        try:
                            from urllib.parse import urlencode as _urlencode

                            prepared_body_preview = _urlencode(data)[:500]
                        except Exception:
                            prepared_body_preview = str(data)[:500]
                        encoding_mode = "form_urlencoded"
                        if not user_content_type:
                            request_headers["Content-Type"] = "application/x-www-form-urlencoded"

                elif isinstance(data, str):
                    # If data is a string, pass it directly. The user is responsible for correct encoding.
                    request_params["data"] = data
                    prepared_body_preview = data[:500]
                    if "application/json" in user_content_type:
                        # If Content-Type is application/json but data is string, ensure it's valid JSON
                        try:
                            json.loads(data)
                            encoding_mode = "json"
                        except json.JSONDecodeError:
                            # 非合法JSON仍按字符串发送
                            encoding_mode = "string_with_json_content_type"
                    elif not user_content_type:
                        # Assume urlencoded if not specified, as it's the most common case for string POST data.
                        request_headers["Content-Type"] = "application/x-www-form-urlencoded"
                        encoding_mode = "form_urlencoded_string"

        request_params["headers"] = request_headers

        # 发送请求
        response = await _httpx_client.request(**request_params)

        # 计算响应时间
        response_time = round((time.time() - start_time) * 1000, 2)

        # 构造结果
        redirect_chain = [
            {"status_code": r.status_code, "reason": r.reason_phrase, "url": str(r.url), "headers": dict(r.headers)}
            for r in response.history
        ]

        result = {
            "request": {
                "url": str(response.request.url),  # httpx的URL对象需要转str
                "method": response.request.method,
                "headers": dict(response.request.headers),
                "data": data if isinstance(data, str) else json.dumps(data) if data else None,
                "raw_mode": raw_mode,
                "prepared_body_preview": prepared_body_preview,
                "encoding_mode": encoding_mode,
            },
            "response": {
                "status_code": response.status_code,
                "reason": response.reason_phrase,
                "headers": dict(response.headers),
                "content": response.text[:999999],  # 限制内容长度
                "content_length": len(response.text),
                "encoding": response.encoding,
                "url": str(response.url),  # 最终URL（可能重定向后的）
                "response_time_ms": response_time,
            },
            "metadata": {
                "redirects": len(response.history),
                "final_url": str(response.url),
                "elapsed_seconds": response.elapsed.total_seconds(),
                "cookies": dict(response.cookies),  # httpx可以直接获取响应的cookies
                "follow_redirects": follow_redirects,
                "redirect_chain": redirect_chain,
            },
        }

        return json.dumps(result, ensure_ascii=False, indent=2)

    except httpx.ConnectError as e:
        logger.error(f"HTTP连接错误: {url} - {e}")
        error_result = {"error": "Connection Error", "message": str(e), "url": url, "type": "connection_error"}
        return json.dumps(error_result, ensure_ascii=False, indent=2)

    except httpx.TimeoutException as e:
        logger.error(f"HTTP请求超时: {url} - {e}")
        error_result = {
            "error": "Timeout Error",
            "message": str(e),
            "url": url,
            "timeout": timeout,
            "type": "timeout_error",
        }
        return json.dumps(error_result, ensure_ascii=False, indent=2)

    except httpx.RequestError as e:
        logger.error(f"HTTP请求错误: {url} - {e}")
        error_result = {"error": "Request Error", "message": str(e), "url": url, "type": "request_error"}
        return json.dumps(error_result, ensure_ascii=False, indent=2)

    except Exception as e:
        logger.exception(f"HTTP请求发生未预期的错误: {url}")
        error_result = {"error": "Unexpected Error", "message": str(e), "url": url, "type": "unexpected_error"}
        return json.dumps(error_result, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    mcp.run()
