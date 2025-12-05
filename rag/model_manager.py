"""
统一的模型管理模块
提供全局共享的SentenceTransformer模型实例
"""

import os
import threading
from typing import Optional

try:
    from sentence_transformers import SentenceTransformer
except ImportError:
    SentenceTransformer = None

# 全局模型实例
_global_model: Optional[SentenceTransformer] = None
_model_lock = threading.Lock()


def get_embedding_model(project_root: Optional[str] = None) -> Optional[SentenceTransformer]:
    """
    获取全局共享的句向量模型实例（线程安全）。

    Args:
        project_root: 项目根目录路径

    Returns:
        SentenceTransformer实例，失败返回None
    """
    global _global_model

    if _global_model is not None:
        return _global_model

    with _model_lock:
        # 双重检查锁定
        if _global_model is not None:
            return _global_model

        if SentenceTransformer is None:
            print("⚠️  sentence-transformers 未安装")
            return None

        try:
            if project_root is None:
                # 尝试从当前文件位置推断项目根目录
                project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

            # 1. 尝试加载本地模型
            local_model_path = os.path.join(project_root, "rag", "models", "all-MiniLM-L6-v2")
            model_config_path = os.path.join(local_model_path, "config.json")

            if os.path.exists(model_config_path):
                try:
                    _global_model = SentenceTransformer(local_model_path)
                    print(f"✅ 使用本地模型: {local_model_path}")
                    return _global_model
                except Exception as e:
                    print(f"⚠️  加载本地模型失败: {e}")

            # 2. 尝试从HuggingFace缓存加载
            try:
                print("--- 从HuggingFace缓存/在线加载模型'all-MiniLM-L6-v2' ---")
                _global_model = SentenceTransformer("all-MiniLM-L6-v2", local_files_only=True)
                print("✅ 模型加载成功")
                return _global_model
            except Exception as e:
                print(f"❌ 模型加载失败: {e}")
                return None

        except Exception as e:
            print(f"❌ 获取嵌入模型时发生错误: {e}")
            return None


def get_model_dim(model: Optional[SentenceTransformer] = None, default_dim: int = 384) -> int:
    """
    获取模型的嵌入维度。

    Args:
        model: SentenceTransformer实例
        default_dim: 默认维度

    Returns:
        嵌入向量维度
    """
    if model is None:
        model = _global_model

    if model is None:
        return default_dim

    try:
        return int(getattr(model, "get_sentence_embedding_dimension", lambda: default_dim)())
    except Exception:
        return default_dim



