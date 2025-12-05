import os
import sys
import json
import hashlib
import math
import re
from typing import Dict, List, Tuple, Any
import numpy as np

# 导入分块器
from markdown_chunker import MarkdownChunker

"""
RAG Knowledge Base Preparer (增量向量化持久化 - FAISS)

功能:
- 扫描 `knowledge_base` 目录下的所有 Markdown (.md) 和文本 (.txt) 文档
- 生成文本向量（优先使用本地 Sentence-Transformers；离线时自动回退到哈希嵌入）
- 将向量持久化到 FAISS 索引 (IndexIDMap2 + IndexFlatIP) 及配套存储
- 增量更新: 仅对新增或修改过的文档进行重新向量化；删除不存在的条目

持久化目录: `<project_root>/rag/faiss_db`
索引文件: `<project_root>/rag/faiss_db/kb.faiss`
文档存储: `<project_root>/rag/faiss_db/kb_store.json`
清单文件: `<project_root>/rag/faiss_db/faiss_manifest.json` 记录已索引文档的哈希与mtime

运行: 在 `auto_pentest` conda 环境下执行
  conda run -n auto_pentest python rag/rag_kdprepare.py

依赖: faiss-cpu, numpy, rich；可选 sentence-transformers（离线使用本地模型路径）
  conda install -n auto_pentest -y -c conda-forge faiss-cpu numpy rich
  conda run -n auto_pentest pip install sentence-transformers
"""

try:
    import faiss
except Exception:
    faiss = None

# Note: We'll handle the import in the function itself due to module path issues


def project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env_variables() -> None:
    """使用 python-dotenv 加载 .env 环境变量。"""
    try:
        from dotenv import load_dotenv, find_dotenv

        load_dotenv(find_dotenv(), override=False)
    except ImportError:
        # 如果未安装 python-dotenv，静默失败
        pass


def kb_root_dir(root: str) -> str:
    return os.path.join(root, "knowledge_base")


def persist_dir(root: str) -> str:
    return os.path.join(root, "rag", "faiss_db")


def manifest_path(root: str) -> str:
    return os.path.join(root, "rag", "faiss_db", "faiss_manifest.json")


def index_path(root: str) -> str:
    return os.path.join(root, "rag", "faiss_db", "kb.faiss")


def store_path(root: str) -> str:
    return os.path.join(root, "rag", "faiss_db", "kb_store.json")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest(path: str) -> Dict[str, Any]:
    if not os.path.isfile(path):
        return {"documents": {}, "chunks": {}}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            # 向后兼容：如果旧格式，转换为新格式
            if "documents" not in data:
                return {"documents": data, "chunks": {}}
            return data
    except Exception:
        return {"documents": {}, "chunks": {}}


def save_manifest(path: str, data: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def list_kb_files(root: str) -> List[Tuple[str, str]]:
    docs: List[Tuple[str, str]] = []
    base_dir = kb_root_dir(root)
    if not os.path.isdir(base_dir):
        return docs
    for dirpath, dirnames, filenames in os.walk(base_dir):
        for filename in filenames:
            if filename.endswith(".md") or filename.endswith(".txt"):
                full = os.path.join(dirpath, filename)
                doc_id = os.path.relpath(full, root)
                docs.append((doc_id, full))
    return docs


def ensure_dependencies():
    if faiss is None:
        print(
            "[ERROR] faiss 未安装。请在 auto_pentest 环境中执行:\n  conda install -n auto_pentest -y -c conda-forge faiss-cpu"
        )
        sys.exit(1)


class OfflineHasherEmbedder:
    """
    离线哈希嵌入：根据 token 的 sha256 映射到固定维度并归一化。
    这是在无法下载 Sentence-Transformers 模型时的回退方案。
    """

    def __init__(self, dim: int = 384):
        self.dim = dim

    def encode(self, texts: List[str]) -> List[List[float]]:
        return [self._hash_embed(t) for t in texts]

    def _hash_embed(self, text: str) -> List[float]:
        vec = [0.0] * self.dim
        for token in re.findall(r"\b\w+\b", text.lower()):
            d = hashlib.sha256(token.encode("utf-8")).digest()
            idx = int.from_bytes(d[0:4], "little") % self.dim
            sign = 1.0 if (d[4] & 1) else -1.0
            vec[idx] += sign
        norm = math.sqrt(sum(v * v for v in vec))
        if norm > 0:
            vec = [v / norm for v in vec]
        return vec


def create_embedder(model_dir: str = None) -> object:
    """
    返回一个具备 encode(texts) -> List[List[float]] 的对象。
    优先使用 model_manager 提供的全局模型；否则使用 OfflineHasherEmbedder。
    """
    try:
        import sys
        import os

        # 确保 rag 模块在路径中
        rag_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rag")
        if rag_dir not in sys.path:
            sys.path.append(rag_dir)

        from model_manager import get_embedding_model

        model = get_embedding_model()
        if model is not None:
            return model
    except Exception as e:
        print(f"[WARN] 无法加载全局SentenceTransformer模型，使用离线哈希嵌入器: {e}")
    return OfflineHasherEmbedder(dim=384)


def _id64_for_doc(doc_id: str) -> int:
    """为文档生成64位ID"""
    d = hashlib.sha256(doc_id.encode("utf-8")).digest()
    # 限制为 63-bit 有符号安全范围，避免 SWIG 转换到 C long 时溢出
    # 映射保持稳定：对相同 doc_id 始终得到相同值
    val = int.from_bytes(d[:8], "little", signed=False)
    val &= (1 << 63) - 1  # 映射到 [0, 2^63-1]
    if val == 0:
        val = 1  # 避免 0 作为特殊ID
    return val


def _id64_for_chunk(chunk_id: str) -> int:
    """为分块生成64位ID"""
    d = hashlib.sha256(chunk_id.encode("utf-8")).digest()
    val = int.from_bytes(d[:8], "little", signed=False)
    val &= (1 << 63) - 1
    if val == 0:
        val = 1
    return val


def _normalize(vecs: List[List[float]]) -> np.ndarray:
    if not vecs:
        # 处理空向量列表的情况
        return np.array([], dtype=np.float32).reshape(0, 384)
    arr = np.array(vecs, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return arr / norms


def _parse_force_controls() -> Tuple[bool, List[str]]:
    """
    解析强制重建控制：
    - 命令行：`--force-all` 或 `--force-doc=<pattern>`（可多次）
    - 环境变量：`RAG_FORCE_ALL` in {1,true,yes,on}；`RAG_FORCE_DOCS` 逗号分隔模式

    pattern 为子串匹配，作用于 doc_id 与 full_path。
    返回: (force_all, force_doc_patterns)
    """
    args = sys.argv[1:]
    force_all = False
    force_docs: List[str] = []

    # 命令行参数
    for i, arg in enumerate(args):
        if arg == "--force-all":
            force_all = True
        elif arg.startswith("--force-doc="):
            val = arg.split("=", 1)[1].strip()
            if val:
                force_docs.append(val)
        elif arg == "--force-doc" and (i + 1) < len(args):
            val = args[i + 1].strip()
            if val and not val.startswith("--"):
                force_docs.append(val)

    # 环境变量
    env_force_all = os.getenv("RAG_FORCE_ALL", "").lower().strip()
    if env_force_all in {"1", "true", "yes", "on"}:
        force_all = True
    env_force_docs = os.getenv("RAG_FORCE_DOCS", "")
    if env_force_docs.strip():
        for p in env_force_docs.split(","):
            p = p.strip()
            if p:
                force_docs.append(p)

    # 去重
    force_docs = list(dict.fromkeys(force_docs))
    return force_all, force_docs


def _is_force_target(doc_id: str, full_path: str, patterns: List[str]) -> bool:
    """判断文档是否匹配强制重建模式。子串大小写不敏感匹配 doc_id 或 full_path。"""
    if not patterns:
        return False
    did = (doc_id or "").lower()
    fpath = (full_path or "").lower()
    for pat in patterns:
        p = pat.lower()
        if (p in did) or (p in fpath):
            return True
    return False


def main():
    # 确保在读取前加载 .env（不覆盖已存在的导出变量）
    load_env_variables()
    print("RAG_MAX_CHUNK_SIZE =", os.getenv("RAG_MAX_CHUNK_SIZE"))
    print("RAG_MIN_CHUNK_SIZE =", os.getenv("RAG_MIN_CHUNK_SIZE"))
    print("RAG_SNIPPET_LEN =", os.getenv("RAG_SNIPPET_LEN"))
    root = project_root()
    ensure_dependencies()

    # 解析强制重建控制
    force_all, force_doc_patterns = _parse_force_controls()

    # 加载清单（新格式包含documents和chunks）
    manifest = load_manifest(manifest_path(root))

    # 获取当前文档
    current_docs = list_kb_files(root)
    current_ids = set(doc_id for doc_id, _ in current_docs)

    # 识别需要删除的文档
    previous_doc_ids = set(manifest.get("documents", {}).keys())
    to_delete_docs = list(previous_doc_ids - current_ids)

    # 识别需要更新或新增的文档
    to_upsert_docs = []
    for doc_id, full_path in current_docs:
        try:
            mtime = os.path.getmtime(full_path)
            size = os.path.getsize(full_path)
            digest = sha256_file(full_path)
        except Exception:
            print(f"[WARN] 读取文件失败，跳过: {full_path}")
            continue

        doc_manifest = manifest.get("documents", {}).get(doc_id)
        # 1) 若强制重建，忽略哈希匹配，直接加入待处理
        if force_all or _is_force_target(doc_id, full_path, force_doc_patterns):
            try:
                with open(full_path, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                meta = {"path": full_path, "mtime": mtime, "size": size, "hash": digest, "force": True}
                to_upsert_docs.append((doc_id, content, meta))
            except Exception as e:
                print(f"[WARN] 读取文件内容失败，跳过: {full_path}, 错误: {e}")
            continue

        # 2) 常规新增或更新（哈希变化）
        if not doc_manifest or doc_manifest.get("hash") != digest:
            # 新增或更新
            try:
                with open(full_path, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                meta = {"path": full_path, "mtime": mtime, "size": size, "hash": digest}
                to_upsert_docs.append((doc_id, content, meta))
            except Exception as e:
                print(f"[WARN] 读取文件内容失败，跳过: {full_path}, 错误: {e}")

    # 初始化分块器（支持通过环境变量调优）
    try:
        env_min = int(os.getenv("RAG_MIN_CHUNK_SIZE", "100"))
    except Exception:
        env_min = 100
    try:
        env_max = int(os.getenv("RAG_MAX_CHUNK_SIZE", "1000"))
    except Exception:
        env_max = 1000
    # 合理边界与关系约束
    env_min = max(20, min(env_min, 5000))
    env_max = max(env_min + 50, min(env_max, 20000))

    chunker = MarkdownChunker(min_chunk_size=env_min, max_chunk_size=env_max)

    # 初始化 FAISS 持久化目录与索引
    db_path = persist_dir(root)
    os.makedirs(db_path, exist_ok=True)

    # 优先使用本地模型目录
    local_model_dir = os.path.join(root, "rag", "models", "all-MiniLM-L6-v2")
    embedder = create_embedder(local_model_dir)

    # 加载/初始化 FAISS 索引 (使用内积以支持余弦相似度)
    index_fp = index_path(root)
    if os.path.isfile(index_fp):
        index = faiss.read_index(index_fp)
        print(f"[INFO] 加载现有索引，现有向量数: {index.ntotal}")
    else:
        base_index = faiss.IndexFlatIP(384)
        index = faiss.IndexIDMap2(base_index)
        print("[INFO] 创建新的空索引")

    # 加载/初始化 文档存储
    store_fp = store_path(root)
    if os.path.isfile(store_fp):
        try:
            with open(store_fp, "r", encoding="utf-8") as f:
                doc_store = json.load(f)
        except Exception:
            doc_store = {}
    else:
        doc_store = {}

    # 删除已不存在的文档及其所有分块
    if to_delete_docs:
        print(f"[INFO] 需要删除 {len(to_delete_docs)} 个文档及其所有分块")
        for doc_id in to_delete_docs:
            try:
                # 从清单中获取该文档的所有分块
                chunks_to_delete = []
                for chunk_id, chunk_info in manifest.get("chunks", {}).items():
                    if chunk_info.get("doc_id") == doc_id:
                        chunks_to_delete.append(chunk_id)

                # 从索引中删除所有分块
                for chunk_id in chunks_to_delete:
                    chunk_id64 = _id64_for_chunk(chunk_id)
                    try:
                        index.remove_ids(np.array([chunk_id64], dtype=np.int64))
                    except (RuntimeError, KeyError) as e:
                        # 分块可能不存在于索引中，继续处理其他分块
                        pass

                    # 从文档存储中移除
                    str_chunk_id = str(chunk_id64)
                    if str_chunk_id in doc_store:
                        del doc_store[str_chunk_id]

                    # 从清单的chunks中移除
                    if chunk_id in manifest.get("chunks", {}):
                        del manifest["chunks"][chunk_id]

                # 从清单的documents中移除文档
                if doc_id in manifest.get("documents", {}):
                    del manifest["documents"][doc_id]

            except Exception as e:
                print(f"[WARN] 删除文档失败: {doc_id}, 错误: {e}")

    # 处理需要更新或新增的文档
    if to_upsert_docs:
        print(f"[INFO] 需要处理 {len(to_upsert_docs)} 个文档")

        # 批量处理文档
        for doc_id, content, meta in to_upsert_docs:
            try:
                # 对文档进行分块
                chunks = chunker.chunk_document(doc_id, content)
                print(f"[INFO] 文档 {doc_id} 被分为 {len(chunks)} 个分块")

                # 为每个分块生成嵌入向量
                chunk_texts = [chunk.content for chunk in chunks]
                try:
                    if isinstance(embedder, OfflineHasherEmbedder):
                        embeds = embedder.encode(chunk_texts)
                    else:
                        embeds = embedder.encode(chunk_texts)
                        embeds = [list(map(float, v)) for v in embeds]
                except Exception as e:
                    print(f"[WARN] 分块嵌入失败: {e}, 使用离线哈希嵌入器重试")
                    offline_embedder = OfflineHasherEmbedder(dim=384)
                    embeds = offline_embedder.encode(chunk_texts)

                # 归一化向量用于余弦相似度（内积）
                embeds_arr = _normalize(embeds)

                # 删除该文档的旧分块（如果存在）
                old_chunks_to_delete = []
                for chunk_id, chunk_info in manifest.get("chunks", {}).items():
                    if chunk_info.get("doc_id") == doc_id:
                        old_chunks_to_delete.append(chunk_id)

                for chunk_id in old_chunks_to_delete:
                    chunk_id64 = _id64_for_chunk(chunk_id)
                    try:
                        index.remove_ids(np.array([chunk_id64], dtype=np.int64))
                    except (RuntimeError, KeyError) as e:
                        # 旧分块可能已被删除，忽略错误继续处理
                        pass

                    str_chunk_id = str(chunk_id64)
                    if str_chunk_id in doc_store:
                        del doc_store[str_chunk_id]

                    if chunk_id in manifest.get("chunks", {}):
                        del manifest["chunks"][chunk_id]

                # 添加新分块到索引和存储
                add_ids = []
                for i, chunk in enumerate(chunks):
                    chunk_id = chunk.id
                    chunk_id64 = _id64_for_chunk(chunk_id)

                    # 添加到索引
                    add_ids.append(chunk_id64)

                    # 添加到文档存储
                    str_chunk_id = str(chunk_id64)
                    doc_store[str_chunk_id] = {
                        "chunk_id": chunk_id,
                        "doc_id": doc_id,
                        "text": chunk.content,
                        "meta": {
                            "type": chunk.chunk_type,
                            "level": chunk.level,
                            "position": chunk.position,
                            "doc_meta": meta,
                        },
                    }

                    # 添加到清单的chunks
                    if "chunks" not in manifest:
                        manifest["chunks"] = {}
                    manifest["chunks"][chunk_id] = {
                        "doc_id": doc_id,
                        "type": chunk.chunk_type,
                        "level": chunk.level,
                        "position": chunk.position,
                        "hash": hashlib.sha256(chunk.content.encode("utf-8")).hexdigest(),
                    }

                # 批量添加分块向量到索引
                try:
                    index.add_with_ids(embeds_arr, np.array(add_ids, dtype=np.int64))
                except Exception as e:
                    print(f"[ERROR] 批量添加分块向量失败: {e}")
                    # 尝试逐个添加
                    for k, emb in enumerate(embeds_arr):
                        try:
                            single_id = np.array([add_ids[k]], dtype=np.int64)
                            single_emb = np.array([emb], dtype=np.float32)
                            index.add_with_ids(single_emb, single_id)
                        except Exception as e2:
                            print(f"[ERROR] 添加单个分块向量失败: {add_ids[k]}, 错误: {e2}")

                # 更新清单的documents
                if "documents" not in manifest:
                    manifest["documents"] = {}
                manifest["documents"][doc_id] = meta

            except Exception as e:
                print(f"[ERROR] 处理文档失败: {doc_id}, 错误: {e}")

    # 保存索引与存储
    try:
        faiss.write_index(index, index_fp)
        with open(store_fp, "w", encoding="utf-8") as f:
            json.dump(doc_store, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[ERROR] 保存索引或存储失败: {e}")
        return

    # 保存清单
    save_manifest(manifest_path(root), manifest)

    total_chunks = len(manifest.get("chunks", {}))
    print(
        f"[DONE] 增量处理完成。处理文档: {len(to_upsert_docs)}，删除文档: {len(to_delete_docs)}，总分块数: {total_chunks}。持久库: {db_path}"
    )


if __name__ == "__main__":
    main()
