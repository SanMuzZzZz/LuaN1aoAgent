"""
知识服务模块 - 提供统一的语义检索接口和FastAPI服务
扫描knowledge_base目录下的所有文档
"""

import os
import asyncio
from typing import Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel

# 导入现有的RAG客户端用于writeup检索
try:
    from rag.rag_client import get_rag_client
except ImportError:
    # 如果相对导入失败,尝试添加项目根目录到路径
    import sys
    from pathlib import Path
    current_dir = Path(__file__).parent
    project_root = current_dir.parent
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    try:
        from rag.rag_client import get_rag_client
    except ImportError as e:
        print(f"⚠️ 无法导入 get_rag_client: {e}")
        print(f"当前 sys.path: {sys.path}")
        get_rag_client = None

# RAG客户端（统一知识库）
_rag_client = None
_rag_client_lock = asyncio.Lock()


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _initialize_knowledge_base_sync():
    """
    同步初始化RAG客户端的实际逻辑。
    此函数应在事件循环的executor中运行，以避免阻塞。
    """
    global _rag_client

    print("--- 正在检查并初始化统一知识库RAG客户端... ---")

    if get_rag_client is not None:
        try:
            _rag_client = get_rag_client(PROJECT_ROOT)
            _rag_client.build_index()
            print("✅ 统一知识库RAG客户端初始化完成。")

            # 索引已由_rag_client内部管理，无需额外全局变量

        except Exception as e:
            print(f"⚠️  RAG客户端初始化失败: {e}")
            _rag_client = None
    else:
        print("❌ 未找到get_rag_client函数，无法初始化RAG客户端。")


async def _initialize_knowledge_base():
    """
    初始化统一的RAG客户端 (异步安全)。
    """
    global _rag_client
    async with _rag_client_lock:
        if _rag_client is not None:
            return

        loop = asyncio.get_running_loop()
        # 在executor中运行同步的初始化代码，防止阻塞事件循环
        await loop.run_in_executor(None, _initialize_knowledge_base_sync)


async def retrieve_knowledge(query: str, top_k: int = 5) -> Dict[str, Any]:
    """
    从统一知识库中进行语义检索。
    扫描knowledge_base目录下的所有文档。
    直接使用RAGClient.query结果，保持其重排与去重逻辑。
    """
    global _rag_client

    # 确保已初始化
    if _rag_client is None:
        await _initialize_knowledge_base()

    if _rag_client is None or not _rag_client.is_available():
        return {"success": False, "error": "RAG客户端不可用。"}

    try:
        # 直接调用RAG客户端检索
        results = _rag_client.query(query, top_k)

        return {"success": True, "query": query, "total_results": len(results), "results": results}
    except Exception as e:
        return {"success": False, "error": f"检索知识时发生错误: {e}"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """服务生命周期管理。"""
    # 启动时初始化
    print("🚀 服务启动，开始初始化知识库...")
    try:
        await _initialize_knowledge_base()
    except Exception as e:
        print(f"⚠️ 初始化知识库时出错: {e}")
    
    yield  # 服务运行期间
    
    # 关闭时清理（可选）
    print("👋 知识服务正在关闭...")


# FastAPI应用
app = FastAPI(
    title="LuaN1ao Knowledge Service",
    version="3.0",
    lifespan=lifespan
)


class KnowledgeQuery(BaseModel):
    query: str
    top_k: int = 5


@app.post("/retrieve_knowledge")
async def api_retrieve_knowledge(query_params: KnowledgeQuery):
    """检索知识API端点。"""
    return await retrieve_knowledge(query_params.query, query_params.top_k)


@app.get("/health")
async def health_check():
    """健康检查端点。"""
    rag_status = "healthy" if _rag_client is not None and _rag_client.is_available() else "unavailable"

    return {
        "status": rag_status,
        "knowledge_base": {
            "status": rag_status,
            "total_chunks": _rag_client.index.ntotal if _rag_client and _rag_client.index else 0,
        },
    }


@app.get("/stats")
async def get_stats():
    """获取知识库统计信息。"""
    return {
        "knowledge_base": {
            "available": _rag_client is not None and _rag_client.is_available(),
            "total_chunks": _rag_client.index.ntotal if _rag_client and _rag_client.index else 0,
        }
    }


if __name__ == "__main__":
    import uvicorn
    import os

    port = int(os.getenv("KNOWLEDGE_SERVICE_PORT", "8081"))
    print(f"🚀 启动统一知识服务... (端口: {port})")
    uvicorn.run(app, host="127.0.0.1", port=port)
