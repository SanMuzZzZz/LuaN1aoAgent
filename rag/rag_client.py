import os
import hashlib
import math
import re
from typing import List, Dict, Any, Optional, Set
import numpy as np

# 使用 FAISS 持久化向量库，避免每次启动重新向量化
try:
    import faiss
except Exception:
    faiss = None

try:
    from rag.model_manager import get_embedding_model, get_model_dim
except Exception:
    get_embedding_model = None
    get_model_dim = None

# 使用 python-dotenv 加载环境变量（如果已安装）
try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass


class HybridQueryEmbedder:
    """
    查询嵌入器：优先使用 SentenceTransformer（若可用），否则回退为哈希嵌入。
    """

    def __init__(self, base_dir: str, dim: int = 384):
        # 使用全局共享的模型实例
        self.model = get_embedding_model(base_dir) if get_embedding_model else None
        self.dim = get_model_dim(self.model, dim) if get_model_dim else dim

    def encode(self, texts: List[str]) -> List[List[float]]:
        if self.model is not None:
            try:
                vecs = self.model.encode(texts, convert_to_numpy=False)
                return [list(map(float, v)) for v in vecs]
            except Exception:
                pass
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


class RAGClient:
    """
    RAG 客户端，使用持久化 FAISS 向量库检索写作库片段。

    设计目标：
    - 不在运行时重新向量化；向量化由 `rag_kdprepare.py` 负责增量更新。
    - 通过 FAISS 检索相似片段，返回 `{id, score, snippet}` 列表。
    - 依赖缺失时优雅降级（返回空结果）。
    """

    def __init__(self, base_dir: str):
        self.base_dir = base_dir
        self.index = None
        self.doc_store: Dict[str, Any] = {}
        self.query_embedder = HybridQueryEmbedder(base_dir=base_dir)
        # 词项统计（用于通用词法检索与重排加权）
        self._idf: Dict[str, float] = {}
        self._doc_len: Dict[str, int] = {}
        self._avg_doc_len: float = 0.0

    def is_available(self) -> bool:
        return faiss is not None

    def build_index(self) -> None:
        """加载 FAISS 持久索引与文档存储（不做向量化）。"""
        if not self.is_available():
            return
        db_path = os.path.join(self.base_dir, "rag", "faiss_db")
        index_fp = os.path.join(db_path, "kb.faiss")
        store_fp = os.path.join(db_path, "kb_store.json")
        if not os.path.isdir(db_path):
            return
        try:
            if os.path.isfile(index_fp):
                self.index = faiss.read_index(index_fp)
            else:
                self.index = None
            if os.path.isfile(store_fp):
                import json

                with open(store_fp, "r", encoding="utf-8") as f:
                    self.doc_store = json.load(f)
            else:
                self.doc_store = {}
        except Exception:
            self.index = None
            self.doc_store = {}

        # 构建 doc_id -> 有序分块映射，用于检索阶段进行邻居合并
        # 结构: self._doc_chunks[doc_id] = [ {"id": chunk_id, "text": text, "meta": meta}, ... ]
        self._doc_chunks: Dict[str, List[Dict[str, Any]]] = {}
        try:
            for _, entry in self.doc_store.items():
                if not isinstance(entry, dict):
                    continue
                doc_id = entry.get("doc_id")
                text = entry.get("text", "")
                meta = entry.get("meta", {})
                chunk_id = entry.get("chunk_id")
                if not doc_id or chunk_id is None:
                    continue
                pos = meta.get("position", 0)
                lst = self._doc_chunks.setdefault(doc_id, [])
                lst.append({"id": chunk_id, "text": text, "meta": meta, "position": pos})
            # 按 position 排序，确保邻居关系正确
            for doc_id, lst in self._doc_chunks.items():
                lst.sort(key=lambda x: x.get("position", 0))
        except Exception:
            # 异常时保持降级，不影响基本检索
            self._doc_chunks = {}

        # 构建 IDF 与分块长度统计（BM25 风格，通用提升词法检索准确率）
        try:
            df_map: Dict[str, int] = {}
            total_len = 0
            N = 0
            for key, entry in self.doc_store.items():
                if not isinstance(entry, dict):
                    continue
                text = entry.get("text", "")
                chunk_id = str(entry.get("chunk_id", key))
                tokens = self._tokenize(text)
                dl = len(tokens)
                self._doc_len[chunk_id] = dl
                total_len += dl
                N += 1
                # 使用分块级去重后的词项更新 DF
                uniq = set(tokens)
                for t in uniq:
                    df_map[t] = df_map.get(t, 0) + 1
            idf: Dict[str, float] = {}
            for t, df in df_map.items():
                # BM25 常用 IDF：log((N - df + 0.5)/(df + 0.5) + 1)
                try:
                    val = math.log(((N - df + 0.5) / (df + 0.5)) + 1.0)
                    # 保护性下限，避免极端值导致不稳定
                    idf[t] = max(0.0, float(val))
                except Exception:
                    idf[t] = 0.0
            self._idf = idf
            self._avg_doc_len = (float(total_len) / float(N)) if N > 0 else 0.0
        except Exception:
            # 统计失败时保持为空，后续逻辑将优雅降级
            self._idf = {}
            self._doc_len = {}
            self._avg_doc_len = 0.0

    def query(self, text: str, top_k: int = 10) -> List[Dict[str, Any]]:
        """基于 FAISS 检索相似文档片段。支持分块级别的检索。"""
        if not self.is_available() or self.index is None or not self.doc_store:
            return []
        try:
            q_vecs = self.query_embedder.encode([text])
            # 归一化后使用内积作为余弦相似度
            q_arr = np.array(q_vecs, dtype=np.float32)
            norms = np.linalg.norm(q_arr, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            q_arr = q_arr / norms
            # 检索更多结果用于后续的重排和去重
            dists, idxs = self.index.search(q_arr, top_k * 3)
        except Exception:
            return []

        results: List[Dict[str, Any]] = []
        # idxs 是 int64 的ID，与 doc_store 的键对应（字符串化）
        for j, id64 in enumerate(idxs[0]):
            key = str(int(id64))
            entry = self.doc_store.get(key)
            if not entry:
                continue

            # 处理分块数据
            chunk_id = entry.get("chunk_id", key)
            doc_id = entry.get("doc_id", key)
            content = entry.get("text", "")
            meta = entry.get("meta", {})
            score = float(dists[0][j]) if dists is not None else 0.0
            # 生成统一的片段，支持邻居分块合并
            desired_len = self._get_snippet_len()
            snippet = self._make_context_snippet(
                doc_id, meta.get("position", 0), desired_len=desired_len, query_text=text
            )
            if not snippet:
                snippet = self._truncate_on_sentence_boundary(content, desired_len)
            # 片段规范化：去重重复标题/重复行，压缩空行
            try:
                snippet = self._normalize_snippet(snippet)
            except Exception:
                pass

            results.append(
                {
                    "id": chunk_id,  # 使用分块ID
                    "doc_id": doc_id,  # 保留文档ID
                    "score": score,
                    "snippet": snippet,
                    "meta": meta,
                    "chunk_type": meta.get("type", "text"),
                    "chunk_level": meta.get("level", 0),
                }
            )

        # 词法召回回退：扫描 doc_store，补充关键词高匹配的分块
        try:
            lex_candidates = self._lexical_candidates(text, limit=top_k * 2)
            seen_ids = set(str(r.get("id")) for r in results)
            for cand in lex_candidates:
                cid = str(cand.get("id"))
                if cid not in seen_ids:
                    results.append(cand)
                    seen_ids.add(cid)
        except Exception:
            pass

        # 应用轻量级重排和多样性保障（结合查询词做微弱词法加权）
        return self._rerank_and_deduplicate(results, top_k, query_text=text)

    # 评分权重配置常量
    SCORE_WEIGHT_HEADER = 1.2  # 标题内容权重提升系数
    SCORE_WEIGHT_LEXICAL_MAX = 0.25  # 词法匹配最大加权
    SCORE_WEIGHT_LEXICAL_FACTOR = 0.03  # 词法匹配加权因子
    SCORE_WEIGHT_SYMBOL_MAX = 0.3  # 符号检测最大加权
    SCORE_WEIGHT_SYMBOL_FACTOR = 0.08  # 符号检测加权因子
    SCORE_TECHNICAL_RULE_MIN = 1.85  # 技术规则模式最低分数
    DOC_QUOTA_DEFAULT = 2  # 同一文档最多出现次数

    def _rerank_and_deduplicate(
        self, results: List[Dict[str, Any]], top_k: int, query_text: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """轻量级重排和去重，确保结果多样性和质量"""
        if not results:
            return []
        terms = self._extract_query_terms(query_text) if query_text else []

        # 1. 按分数排序
        sorted_results = sorted(results, key=lambda x: x["score"], reverse=True)

        # 2. 文档级别的去重（动态配额），quota_default为允许同一个文档出现的次数
        doc_counts: Dict[str, int] = {}
        deduplicated: List[Dict[str, Any]] = []
        quota_default = self.DOC_QUOTA_DEFAULT
        for result in sorted_results:
            doc_id = result.get("doc_id", "")
            cnt = doc_counts.get(doc_id, 0)
            quota = quota_default
            if cnt < quota:
                doc_counts[doc_id] = cnt + 1
                deduplicated.append(result)
            if len(deduplicated) >= top_k * 2:  # 收集足够的结果用于最终选择
                break

        # 3. 优先选择标题和重要内容
        final_results = []
        for result in deduplicated:
            chunk_type = result.get("chunk_type", "text")
            chunk_level = result.get("chunk_level", 0)

            # 标题内容优先级更高（与分块器命名对齐：header/heading/title）
            if chunk_type in ["header", "heading", "title"] and chunk_level <= 2:
                result["score"] *= self.SCORE_WEIGHT_HEADER

            # 词法匹配加权与符号覆盖加权：优先使用分块原文进行匹配（更稳定），回退到片段
            if terms:
                chunk_text = self._get_chunk_text(result.get("doc_id", ""), result.get("meta", {}).get("position", 0))
                s = (chunk_text or result.get("snippet") or "").lower()
                # 使用 IDF 加权的匹配命中，提升通用检索准确率
                hits_weighted = 0.0
                for t in terms:
                    if len(t) < 2:
                        continue
                    try:
                        occ = len(re.findall(re.escape(t), s))
                    except Exception:
                        occ = 0
                    idf_t = self._idf.get(t, 0.0)
                    hits_weighted += idf_t * float(occ)
                if hits_weighted > 0.0:
                    # 适度加权，防止词法权重压过语义相似度
                    result["score"] *= 1.0 + min(
                        self.SCORE_WEIGHT_LEXICAL_MAX, self.SCORE_WEIGHT_LEXICAL_FACTOR * hits_weighted
                    )

                # 通用符号检测与加权
                try:
                    symbol_categories = self._detect_symbol_categories(s)
                    if symbol_categories:
                        # 基于检测到的符号类别数量进行适度加权
                        result["score"] *= 1.0 + min(
                            self.SCORE_WEIGHT_SYMBOL_MAX, self.SCORE_WEIGHT_SYMBOL_FACTOR * len(symbol_categories)
                        )

                        # 检测技术规则模式并进行优化
                        if self._is_technical_rule_pattern(s, query_text):
                            result["score"] = max(result.get("score", 0.0), self.SCORE_TECHNICAL_RULE_MIN)
                            self._optimize_long_snippets(result, query_text)

                except Exception:
                    pass

            final_results.append(result)

        # 4. 最终按调整后的分数排序并截断
        final_results.sort(key=lambda x: x["score"], reverse=True)
        return final_results[:top_k]

    def _detect_symbol_categories(self, text: str) -> Set[str]:
        """简化符号类别检测，使用标准库替代复杂规则。"""
        categories = set()
        s = (text or "").lower()

        try:
            # 使用新的简化符号工具
            from .symbol_utils import SymbolUtils

            detected_categories = SymbolUtils.detect_categories(s)

            # 映射到内部类别标识
            category_mapping = {
                "parentheses": "paren",
                "angle_brackets": "angle",
                "quotes": "quote",  # 合并单双引号为quote
                "backticks": "backtick",
                "acute_accents": "acute",
            }

            for category in detected_categories:
                if category in category_mapping:
                    categories.add(category_mapping[category])

        except ImportError:
            # 回退到基本符号检测
            import unicodedata

            for char in s:
                # 使用Unicode分类检测符号
                if unicodedata.category(char).startswith("P"):
                    if char in "()（）":
                        categories.add("paren")
                    elif char in "<>＜＞":
                        categories.add("angle")
                    elif char in "'\"＇＂":
                        categories.add("quote")
                    elif char in "`":
                        categories.add("backtick")
                    elif char in "´":
                        categories.add("acute")

        # 技术关键词检测（通用化）
        tech_keywords = {
            "script": ["javascript", "typescript", "python", "ruby", "perl", "php", "bash", "shell"],
            "web": ["html", "css", "http", "https", "url", "domain"],
            "security": ["xss", "sql", "csrf", "csrfrf", "rce", "lfi", "rfi", "ssrf"],
        }

        for category, keywords in tech_keywords.items():
            for keyword in keywords:
                if re.search(rf"\b{re.escape(keyword)}\b", s, re.IGNORECASE):
                    categories.add(category)
                    break

        return categories

    def _is_technical_rule_pattern(self, text: str, query_text: Optional[str] = None) -> bool:
        """检测技术规则模式，避免硬编码特定中文关键词。"""
        s = (text or "").lower()

        # 通用规则模式检测
        rule_indicators = [
            # 过滤和安全相关
            r"filter|filtering|sanitize|sanitization|escape|escaping",
            r"blacklist|whitelist|blocklist|allowlist",
            r"validation|validate|check|verify",
            r"pattern|regex|regular.expression",
            r"rule|policy|guideline|recommendation",
            # 编码相关
            r"encode|encoding|decode|decoding",
            r"urlencode|urldecode|base64|hex",
            # 注入相关
            r"injection|inject|execute|execution",
            r"sql|nosql|command|code",
            # 跨站相关
            r"xss|cross.site|scripting",
            r"csrf|cross.site.request.forgery",
        ]

        # 检测文本中的规则指示器
        rule_count = 0
        for pattern in rule_indicators:
            if re.search(pattern, s, re.IGNORECASE):
                rule_count += 1

        # 检测符号组合（通用化）
        symbol_categories = self._detect_symbol_categories(s)
        symbol_count = len(symbol_categories)

        # 通用规则模式：规则指示器 + 符号组合
        return rule_count >= 2 and symbol_count >= 2

    def _optimize_long_snippets(self, result: Dict[str, Any], query_text: Optional[str] = None) -> None:
        """优化过长片段的显示，通用化实现。"""
        try:
            desired_len = self._get_snippet_len()
            current_snippet = result.get("snippet", "")
            if len(current_snippet) > desired_len * 1.5:
                anchored = self._keyword_anchored_slice(current_snippet, query_text, desired_len)
                if anchored:
                    # 片段规范化
                    try:
                        result["snippet"] = self._normalize_snippet(anchored)
                    except Exception:
                        result["snippet"] = anchored
        except Exception:
            pass

    # 片段生成配置常量
    SNIPPET_WINDOW_FACTOR = 0.75  # 关键词锚定窗口因子（相对于期望长度）
    SNIPPET_WINDOW_MIN = 200  # 最小窗口大小（字符）
    SEMANTIC_EXPAND_FACTOR = 1.5  # 语义锚定扩展因子

    # BM25 词法检索参数
    BM25_K1 = 1.2  # 词频饱和度参数
    BM25_B = 0.75  # 文档长度归一化参数
    BM25_SCORE_SCALE = 0.25  # BM25分数缩放因子
    BM25_SCORE_MAX = 0.9  # BM25分数上限

    def _get_snippet_len(self) -> int:
        """从环境变量读取片段目标长度，默认 800。"""
        try:
            v = int(os.getenv("RAG_SNIPPET_LEN", "800"))
            return max(200, min(5000, v))
        except Exception:
            return 800

    def _make_context_snippet(
        self,
        doc_id: str,
        position: int,
        desired_len: int = 2000,
        neighbor_window: int = 4,
        query_text: Optional[str] = None,
    ) -> str:
        """
        基于当前分块位置，向两侧合并邻居分块以构造更丰富的片段。
        - neighbor_window: 每侧最多合并的分块数量（默认4，即合并左右各4个）
        - desired_len: 目标长度，超过则进行句子边界截断
        """
        # 若没有文档映射，回退到原始片段生成
        lst = self._doc_chunks.get(doc_id)
        if not lst:
            # 找不到邻居信息时退回到单块片段
            # 需要定位该分块文本，最好直接返回 entry 文本，但这里没有 entry；
            # 因为调用处已有 content，可传入备用。但为保持签名，回退为空。
            return ""

        # 找到当前索引
        idx = None
        for i, item in enumerate(lst):
            if item.get("position", 0) == position:
                idx = i
                break
        if idx is None:
            # 如果 position 无法匹配，尝试就近索引
            idx = min(max(0, position), len(lst) - 1)

        # 若有查询词，依据命中情况在文档内重选最佳分块索引
        if query_text:
            try:
                terms = self._extract_query_terms(query_text)
                idx = self._best_chunk_index_by_terms(lst, terms, idx)
            except Exception:
                pass

        # 采集左右邻居
        start = max(0, idx - neighbor_window)
        end = min(len(lst), idx + neighbor_window + 1)
        parts = [p.get("text", "") for p in lst[start:end]]
        combined = "\n\n".join([t.strip() for t in parts if t])

        # 若合并后仍过短，尝试扩大窗口，直到用尽
        expand = neighbor_window + 1
        while len(combined) < desired_len and (start > 0 or end < len(lst)):
            new_start = max(0, idx - expand)
            new_end = min(len(lst), idx + expand + 1)
            parts = [p.get("text", "") for p in lst[new_start:new_end]]
            combined = "\n\n".join([t.strip() for t in parts if t])
            start, end = new_start, new_end
            expand += 1

        # 如果提供了查询文本，优先进行锚定裁剪：关键词→语义回退
        # 但仅在合并内容过长时才进行锚定裁剪，避免过度优化
        if query_text and len(combined) > desired_len * 1.5:
            anchored = self._keyword_anchored_slice(combined, query_text, desired_len)
            if not anchored:
                anchored = self._semantic_anchor_slice(combined, query_text, desired_len)
            if anchored:
                return anchored
            # 文档级回退：在整篇文档文本中进行关键词或语义锚定
            try:
                full_doc = "\n\n".join([p.get("text", "") for p in lst])
                anchored_all = self._keyword_anchored_slice(full_doc, query_text, desired_len)
                if not anchored_all:
                    anchored_all = self._semantic_anchor_slice(full_doc, query_text, desired_len)
                if anchored_all:
                    return anchored_all
            except Exception:
                pass

        # 截断到期望长度（优先句子边界）
        return self._truncate_on_sentence_boundary(combined, desired_len)

    def _get_chunk_text(self, doc_id: str, position: int) -> str:
        """根据 doc_id 与分块位置返回分块原文。"""
        lst = self._doc_chunks.get(doc_id)
        if not lst:
            return ""
        for item in lst:
            if item.get("position", 0) == position:
                return item.get("text", "")
        return ""

    @staticmethod
    def _truncate_on_sentence_boundary(content: str, max_len: int) -> str:
        c = (content or "").strip()
        if len(c) <= max_len:
            return c
        sentences = re.split(r"(?<=[.!?。！？])\s+", c)
        snippet = ""
        for sentence in sentences:
            if len(snippet) + len(sentence) + 1 <= max_len - 3:
                if snippet:
                    snippet += " "
                snippet += sentence
            else:
                break
        if snippet and len(snippet) >= max_len * 0.6:
            return snippet + "..."
        return c[:max_len] + "..."

    def _normalize_snippet(self, snippet: str) -> str:
        """规范化检索片段：
        - 保留代码块原样（``` ... ```）
        - 对非代码片段执行：
          1) 连续重复行去重（忽略首尾空格）
          2) 重复标题去重（相同 Markdown 标题行）
          3) 压缩多余空行（最多保留一个空行）
        """
        if not snippet:
            return snippet
        try:
            parts = re.split(r"(```[\s\S]*?```)", snippet)
            normalized_parts: List[str] = []
            header_pat = re.compile(r"^(#{1,6})\s+(.+)$")
            for part in parts:
                if not part:
                    continue
                ps = part.strip()
                # 代码块保留原样
                if ps.startswith("```") and ps.endswith("```"):
                    normalized_parts.append(part)
                    continue
                # 非代码块：按行处理
                lines = part.splitlines()
                new_lines: List[str] = []
                prev_norm = None
                prev_is_header = False
                for line in lines:
                    norm = line.strip()
                    is_blank = norm == ""
                    is_header = bool(header_pat.match(norm))
                    # 连续空行压缩
                    if is_blank:
                        if new_lines and new_lines[-1].strip() == "":
                            continue
                    # 连续重复行去重（包括重复标题）
                    if prev_norm is not None and norm == prev_norm:
                        # 重复标题或重复行，跳过
                        if is_header or prev_is_header or is_blank:
                            continue
                    new_lines.append(line)
                    prev_norm = norm
                    prev_is_header = is_header
                normalized_parts.append("\n".join(new_lines))
            res = "".join(normalized_parts).strip()
            return res
        except Exception:
            return snippet

    @staticmethod
    def _best_chunk_index_by_terms(lst: List[Dict[str, Any]], terms: List[str], preferred_idx: int) -> int:
        """在文档分块中依据查询词选择最佳分块索引；若无命中则回退 preferred_idx。"""
        if not lst or not terms:
            return preferred_idx
        # 仅使用长度>=2的词，但保留重要符号（括号、尖括号、引号等）
        # 使用通用配置的符号集合
        try:
            from .symbol_utils import get_important_symbols

            important_symbols = set(get_important_symbols())
        except ImportError:
            # 回退到基本符号集合
            important_symbols = {
                "(",
                ")",
                "（",
                "）",
                "<",
                ">",
                "＜",
                "＞",
                "'",
                '"',
                "`",
                "´",
                "&lt;",
                "&gt;",
                "&#40;",
                "&#41;",
            }
        filtered = [t for t in terms if len(t) >= 2 or t in important_symbols]
        if not filtered:
            return preferred_idx
        best_idx = preferred_idx
        best_score = -1
        for i, item in enumerate(lst):
            s = (item.get("text", "") or "").lower()
            score = 0
            for t in filtered:
                try:
                    score += len(re.findall(re.escape(t), s))
                except Exception:
                    pass
            # 选择更高得分；若并列，靠近 preferred_idx 的优先
            if score > best_score or (score == best_score and abs(i - preferred_idx) < abs(best_idx - preferred_idx)):
                best_score = score
                best_idx = i
        return best_idx

    @staticmethod
    def _extract_query_terms(query_text: str) -> List[str]:
        """抽取查询关键词，采用通用化的符号和编码变体生成策略。
        - 提取中英文词汇作为基础术语
        - 动态识别符号并生成相关变体（编码、全角、HTML实体等）
        - 基于通用规则而非硬编码的特定符号列表
        """
        if not query_text:
            return []
        q = (query_text or "").strip()

        # 基础术语提取：中英文词汇
        cn_terms = re.findall(r"[\u4e00-\u9fff]{2,}", q)
        en_terms = re.findall(r"[A-Za-z0-9]{2,}", q)
        terms = [t.lower() for t in (cn_terms + en_terms)]

        # 通用符号变体生成
        def _generate_symbol_variants(src: str) -> List[str]:
            """通用符号变体生成器，使用SymbolUtils简化实现"""
            variants = []
            s = src.lower()

            try:
                # 使用新的SymbolUtils类
                from .symbol_utils import SymbolUtils

                # 提取文本中的符号
                symbols = SymbolUtils.extract_symbols(src)
                if symbols:
                    # 添加基础符号
                    variants.extend(symbols)
                    # 生成编码变体
                    variants.extend(SymbolUtils.generate_encodings("".join(symbols)))

                # 检测相关关键词并触发符号变体生成
                detected_categories = SymbolUtils.detect_categories(s)
                for category in detected_categories:
                    # 根据检测到的类别添加相关符号
                    category_config = SymbolUtils.SYMBOL_CATEGORIES.get(category, {})
                    if "chars" in category_config:
                        variants.extend(list(category_config["chars"]))
                        variants.extend(SymbolUtils.generate_encodings(category_config["chars"]))

            except ImportError:
                # 回退到基本实现
                import unicodedata

                # 提取符号字符
                symbols = []
                for char in src:
                    if len(char) == 1 and unicodedata.category(char).startswith("P"):
                        symbols.append(char)

                if symbols:
                    variants.extend(symbols)

                    # 基本编码生成
                    for char in symbols:
                        try:
                            # URL编码
                            url_encoded = "".join(f"%{ord(c):02X}" for c in char)
                            variants.append(url_encoded.lower())
                        except (ValueError, TypeError, AttributeError) as e:
                            # 忽略无法编码的字符
                            pass

                        # HTML实体编码
                        variants.append(f"&#{ord(char)};")  # 十进制
                        variants.append(f"&#x{ord(char):X};")  # 十六进制大写
                        variants.append(f"&#x{ord(char):x};")  # 十六进制小写

            return list(dict.fromkeys([v for v in variants if v]))

        # 生成符号变体
        symbol_variants = _generate_symbol_variants(q)

        # 合并术语并去重
        all_terms = terms + symbol_variants
        unique_terms = list(dict.fromkeys(all_terms))

        # 排序策略：长度优先，符号变体次之
        unique_terms.sort(
            key=lambda x: (
                len(x),  # 长度优先
                not any(c.isalnum() for c in x),  # 非字母数字的符号排在后面
                x not in terms,  # 原始术语优先于生成的变体
            ),
            reverse=True,
        )

        return unique_terms

    @staticmethod
    def _keyword_anchored_slice(content: str, query_text: str, desired_len: int) -> Optional[str]:
        """在内容中定位关键词并居中截断;若找不到,返回 None。"""
        if not content or not query_text:
            return None
        c = content
        terms = RAGClient._extract_query_terms(query_text)
        if not terms:
            return None
        # 优先匹配最长词;随后尝试符号同义词集合的精确/编码匹配
        anchor_idx = None
        for t in terms:
            try:
                m = re.search(re.escape(t), c, flags=re.IGNORECASE)
                if m:
                    anchor_idx = m.start()
                    break
            except Exception:
                continue
        # 若常规词未命中,尝试集中匹配符号组合(例如括号与引号相关场景)
        if anchor_idx is None:
            try:
                # 使用提取的查询术语中的符号变体进行匹配
                symbol_terms = [t for t in terms if not any(c.isalnum() for c in t)]
                if symbol_terms:
                    # 构建符号模式,优先匹配较长的符号变体
                    symbol_pattern = "|".join([re.escape(t) for t in symbol_terms])
                    m = re.search(symbol_pattern, c, flags=re.IGNORECASE)
                    if m:
                        anchor_idx = m.start()
            except Exception:
                pass
        if anchor_idx is None:
            return None
        # 修改：使用更大的窗口大小，确保提供足够的上下文
        # 原来：half = max(100, desired_len // 2)
        # 现在：使用更大的窗口，最小为desired_len的0.8倍
        half = max(int(desired_len * RAGClient.SNIPPET_WINDOW_FACTOR), RAGClient.SNIPPET_WINDOW_MIN)
        start = max(0, anchor_idx - half)
        end = min(len(c), anchor_idx + half)
        snippet = c[start:end]
        # 如果裁剪后的片段仍然很长，优先返回完整上下文
        if len(snippet) > desired_len * 1.5:
            return RAGClient._truncate_on_sentence_boundary(snippet, desired_len)
        return snippet  # 直接返回，不进行额外截断

    def _semantic_anchor_slice(self, content: str, query_text: str, desired_len: int) -> Optional[str]:
        """语义锚定回退：按句切分，选与查询最相似的句子为锚点，并向两侧扩展。"""
        if not content or not query_text:
            return None
        c = (content or "").strip()
        if not c:
            return None
        # 与截断一致的句子边界切分
        sentences = re.split(r"(?<=[.!?。！？])\s+", c)
        sentences = [s.strip() for s in sentences if s.strip()]
        if not sentences:
            return None
        try:
            # 查询向量并归一化
            q_vec = self.query_embedder.encode([query_text])[0]
            q = np.array(q_vec, dtype=np.float32)
            q_norm = float(np.linalg.norm(q)) or 1.0
            q = q / q_norm

            # 限制最多对前 400 句做语义比较，批量编码
            limit = min(len(sentences), 400)
            batch = sentences[:limit]
            s_vecs = self.query_embedder.encode(batch)
            # 计算余弦相似度并找最优句
            best_i = 0
            best_score = -1.0
            for i, sv in enumerate(s_vecs):
                v = np.array(sv, dtype=np.float32)
                v_norm = float(np.linalg.norm(v)) or 1.0
                v = v / v_norm
                score = float(np.dot(q, v))
                if score > best_score:
                    best_score = score
                    best_i = i

            # 修改：使用更大的扩展窗口，确保提供足够的上下文
            # 以最相似句为锚点，向两侧扩展直至达到 desired_len 的 1.5 倍
            snippet = sentences[best_i]
            left = best_i - 1
            right = best_i + 1
            target_length = int(desired_len * self.SEMANTIC_EXPAND_FACTOR)

            while len(snippet) < target_length and (left >= 0 or right < len(sentences)):
                if right < len(sentences):
                    snippet += " " + sentences[right]
                    right += 1
                if len(snippet) >= target_length:
                    break
                if left >= 0:
                    snippet = sentences[left] + " " + snippet
                    left -= 1

            # 如果扩展后的片段仍然很长，进行句子边界截断
            if len(snippet) > desired_len:
                return self._truncate_on_sentence_boundary(snippet, desired_len)
            return snippet  # 直接返回，不进行额外截断
        except Exception:
            return None

    def _lexical_candidates(self, query_text: str, limit: int = 10) -> List[Dict[str, Any]]:
        """词法召回回退：遍历文档分块，按查询词命中次数选出若干候选。
        返回的结构与 FAISS 结果一致，便于统一重排与去重。
        """
        # 采用 BM25 风格的词法评分以提升普适准确率
        terms_all = self._extract_query_terms(query_text)
        terms = [t for t in terms_all if re.fullmatch(r"[a-z0-9]{2,}", t)]
        if not terms:
            return []
        candidates: List[Dict[str, Any]] = []
        try:
            # BM25 参数
            k1 = self.BM25_K1
            b = self.BM25_B
            avg_len = self._avg_doc_len or 100.0
            # 计算每个分块的 BM25 词法得分
            for key, entry in self.doc_store.items():
                if not isinstance(entry, dict):
                    continue
                text = (entry.get("text", "") or "").lower()
                if not text:
                    continue

                # BM25 词法累计
                bm25 = 0.0
                dl = self._doc_len.get(str(entry.get("chunk_id", key)), 0)
                for t in terms:
                    try:
                        tf = len(re.findall(re.escape(t), text))
                    except Exception:
                        tf = 0
                    if tf <= 0:
                        continue
                    idf_t = self._idf.get(t, 0.0)
                    denom = tf + k1 * (1.0 - b + b * (float(dl) / float(avg_len)))
                    score_t = idf_t * ((k1 + 1.0) * tf) / (denom if denom > 0 else (tf + 1.0))
                    bm25 += score_t

                if bm25 <= 0:
                    continue

                # 组装结果
                doc_id = entry.get("doc_id", key)
                chunk_id = entry.get("chunk_id", key)
                meta = entry.get("meta", {})
                pos = meta.get("position", 0)
                desired_len = self._get_snippet_len()
                snippet = self._make_context_snippet(doc_id, pos, desired_len=desired_len, query_text=query_text)
                if not snippet:
                    snippet = self._truncate_on_sentence_boundary(entry.get("text", ""), desired_len)
                # 片段规范化：去重与压缩
                try:
                    snippet = self._normalize_snippet(snippet)
                except Exception:
                    pass
                # BM25 基础得分缩放到与语义分数相容的区间
                score = min(self.BM25_SCORE_MAX, self.BM25_SCORE_SCALE * bm25)
                item = {
                    "id": chunk_id,
                    "doc_id": doc_id,
                    "score": score,
                    "snippet": snippet,
                    "meta": meta,
                    "chunk_type": meta.get("type", "text"),
                    "chunk_level": meta.get("level", 0),
                }
                candidates.append(item)
        except Exception:
            return []
        # 按分数排序
        candidates.sort(key=lambda x: x.get("score", 0.0), reverse=True)
        return candidates[: max(1, limit)]

    @staticmethod
    def _tokenize(text: str) -> List[str]:
        """简单英文/数字分词：用于 DF/IDF 与 BM25 统计。"""
        s = (text or "").lower()
        try:
            return re.findall(r"[a-z0-9]{2,}", s)
        except Exception:
            return []


_rag_client_instance: Optional[RAGClient] = None


def get_rag_client(project_root: Optional[str] = None) -> RAGClient:
    global _rag_client_instance
    if _rag_client_instance is None:
        base_dir = project_root or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        client = RAGClient(base_dir)
        try:
            client.build_index()  # 仅加载持久库，不做向量化
        except Exception:
            pass
        _rag_client_instance = client
    return _rag_client_instance
