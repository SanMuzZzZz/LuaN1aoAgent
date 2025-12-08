#!/usr/bin/env python3
"""持久化 MCP 客户端实现

导出：
- initialize_sessions(): 初始化异步会话
- call_mcp_tool_async(): 异步调用工具
- close_async_sessions(): 关闭异步会话
- get_all_tools_detailed_async(): 异步获取所有工具详情
"""

import json
import asyncio
import os
from typing import Any, Dict, Optional, List

# 兼容环境：如果未安装 mcp 库，降级为占位实现并返回友好错误
try:
    from mcp import ClientSession
    from mcp.client.stdio import stdio_client, StdioServerParameters
except Exception:
    ClientSession = None
    stdio_client = None
    StdioServerParameters = None


class PersistentSession:
    """维护单个服务器的持久化异步 ClientSession，对外暴露异步调用接口"""

    def __init__(self, name: str, server_config: Dict[str, Any]):
        self.name = name
        self.config = server_config
        self._lock = asyncio.Lock()
        self._session: Optional[ClientSession] = None
        self._task = None
        self._ready_event = asyncio.Event()
        self._stop_event = asyncio.Event()

    async def _run_session(self):
        """在后台任务中运行会话上下文"""
        # if ClientSession is None or stdio_client is None: # Removed redundant check
        #     return

        cmd = self.config.get("command")
        args = self.config.get("args", [])
        env = {**os.environ, **self.config.get("env", {})}
        
        try:
            async with stdio_client(StdioServerParameters(command=cmd, args=args, env=env)) as (read, write):
                async with ClientSession(read, write) as session:
                    self._session = session
                    await self._session.initialize()
                    self._ready_event.set()
                    
                    # 等待停止信号
                    await self._stop_event.wait()
        except Exception as e:
            print(f"MCP session {self.name} error: {e}")
        finally:
            self._session = None
            self._ready_event.clear()

    async def _connect(self):
        if self._session is not None:
            return
            
        if ClientSession is None or stdio_client is None:
            raise RuntimeError("MCP Python SDK 未安装。请在 auto_pentest 环境中执行: pip install mcp")
            
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run_session())
        
        # 等待会话就绪或任务失败
        wait_task = asyncio.create_task(self._ready_event.wait())
        done, pending = await asyncio.wait(
            [wait_task, self._task], 
            return_when=asyncio.FIRST_COMPLETED
        )
        
        if self._task in done:
            # 任务提前结束（出错）
            if not wait_task.done():
                wait_task.cancel()
            try:
                self._task.result() # 抛出异常
            except Exception as e:
                raise RuntimeError(f"Failed to start MCP session {self.name}: {e}")
        else:
            # 就绪
            pass

    async def ensure_connected(self):
        async with self._lock:
            if self._session is None:
                await self._connect()

    async def close(self):
        """关闭会话"""
        if self._stop_event:
            self._stop_event.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
            self._task = None
        self._session = None

    async def list_tools(self):
        try:
            await self.ensure_connected()
            tools_result = await self._session.list_tools()
            if hasattr(tools_result, "tools") and tools_result.tools:
                return [tool.name for tool in tools_result.tools]
            return []
        except Exception:
            return []

    async def get_tools_detailed(self):
        try:
            await self.ensure_connected()
            tools_result = await self._session.list_tools()
            tools_info = []
            if hasattr(tools_result, "tools") and tools_result.tools:
                for tool in tools_result.tools:
                    tool_info = {
                        "name": tool.name,
                        "description": getattr(tool, "description", ""),
                        "inputSchema": getattr(tool, "inputSchema", {}),
                    }
                    tools_info.append(tool_info)
            return tools_info
        except Exception:
            return []

    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]):
        try:
            await self.ensure_connected()
            result = await self._session.call_tool(tool_name, arguments=arguments)
            if result.content and len(result.content) > 0:
                content = result.content[0]
                if hasattr(content, "text"):
                    return content.text
                else:
                    return str(content)
            return ""
        except Exception as e:
            return json.dumps({"success": False, "error": f"MCP调用失败或SDK缺失: {str(e)}"}, ensure_ascii=False)


# 全局原生异步会话存储
_async_sessions: Dict[str, PersistentSession] = {}
_sessions_initialized = False


async def initialize_sessions():
    """初始化所有在mcp.json中配置的异步会话。"""
    global _sessions_initialized
    if _sessions_initialized:
        return

    config = {}
    if os.path.exists("mcp.json"):
        with open("mcp.json", "r") as f:
            config = json.load(f)

    for name, cfg in config.get("mcpServers", {}).items():
        if cfg.get("type") == "stdio":
            _async_sessions[name] = PersistentSession(name, cfg)

    _sessions_initialized = True


async def reload_sessions():
    """重新加载所有MCP会话。"""
    global _sessions_initialized
    await close_async_sessions()
    _async_sessions.clear()
    _sessions_initialized = False
    await initialize_sessions()


async def call_mcp_tool_async(tool: str, params: Optional[Dict] = None, server_name: Optional[str] = None) -> str:
    """异步调用MCP工具。"""
    await initialize_sessions()

    if params is None:
        params = {}

    # 如果未指定服务器，则查找工具所在的服务器
    if server_name is None:
        for s_name, session in _async_sessions.items():
            try:
                tools = await session.list_tools()
                if tool in tools:
                    server_name = s_name
                    break
            except Exception:
                continue
        
        if server_name is None:
            available_servers = list(_async_sessions.keys())
            error_payload = {
                "success": False,
                "error": f"工具 {tool} 未在任何MCP服务器中找到",
                "available_servers": available_servers,
                "hint": "请检查工具名称是否正确，以及相应的MCP服务器是否正常运行",
            }
            return json.dumps(error_payload, ensure_ascii=False)

    if server_name not in _async_sessions:
        error_payload = {"success": False, "error": f"MCP服务器 {server_name} 未配置或不支持"}
        return json.dumps(error_payload, ensure_ascii=False)

    try:
        session = _async_sessions[server_name]
        return await session.call_tool(tool, params)
    except Exception as e:
        error_payload = {"success": False, "error": f"MCP调用失败: {str(e)}"}
        return json.dumps(error_payload, ensure_ascii=False)


async def get_all_tools_detailed_async() -> Dict[str, Any]:
    """异步获取所有服务器的工具详情。"""
    await initialize_sessions()
    all_tools = {}
    
    for name, session in _async_sessions.items():
        try:
            tools = await session.get_tools_detailed()
            all_tools[name] = tools
        except Exception as e:
            all_tools[name] = {"error": str(e)}
            
    return all_tools


async def close_async_sessions():
    """关闭所有异步会话。"""
    for session in _async_sessions.values():
        await session.close()
