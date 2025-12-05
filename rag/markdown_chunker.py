"""
Markdown分块器 - 支持结构化和语义分块

功能:
- 按Markdown结构分层分块（标题、段落、代码块、列表）
- 支持语义分块（句子边界、语义完整性）
- 生成统一的chunk ID机制
"""

import re
from typing import List, Dict, Any, Tuple
from dataclasses import dataclass


@dataclass
class Chunk:
    """分块数据结构。"""

    id: str  # 统一格式: {doc_id}::chunk::{chunk_index}
    content: str
    metadata: Dict[str, Any]
    doc_id: str
    chunk_index: int
    chunk_type: str = "text"  # 分块类型: text, code, header, etc.
    level: int = 0  # 层级（用于标题级别）
    position: int = 0  # 位置索引


class MarkdownChunker:
    """文档分块器 - 通用Markdown分块处理。"""

    def __init__(self, min_chunk_size: int = 60, max_chunk_size: int = 1000):
        self.min_chunk_size = min_chunk_size
        self.max_chunk_size = max_chunk_size

    def _split_by_headers(self, content: str) -> List[Tuple[str, str]]:
        """按Markdown标题分割。"""
        # 匹配各级标题
        header_pattern = r"^(#{1,6})\s+(.+)$"
        parts = []
        current_header = ""
        current_content = []

        lines = content.split("\n")
        for line in lines:
            if re.match(header_pattern, line.strip()):
                # 如果已经有内容，保存当前部分
                if current_content or current_header:
                    parts.append((current_header, "\n".join(current_content)))
                current_header = line.strip()
                current_content = []
            else:
                current_content.append(line)

        # 保存最后一部分
        if current_content or current_header:
            parts.append((current_header, "\n".join(current_content)))

        return parts

    def _split_by_code_blocks(self, content: str) -> List[str]:
        """
        按代码块分割并保留代码块本身。
        返回的列表包含普通文本段和代码段，顺序一致。
        """
        # 使用捕获组，使得re.split保留分隔符（即代码块本身）
        # [\s\S]*? 允许跨行非贪婪匹配，确保捕获完整的``` ... ```代码段
        code_block_pattern = r"(```[\s\S]*?```)"  # 捕获所有代码块，包括内部换行
        parts = re.split(code_block_pattern, content)
        # 去除空字符串，保持原始顺序
        return [p for p in parts if p]

    def _split_by_semantic_boundaries(self, content: str) -> List[str]:
        """按语义边界分割（句子、段落）。"""
        # 按段落分割
        paragraphs = content.split("\n\n")
        chunks = []

        current_chunk = []
        current_length = 0

        for paragraph in paragraphs:
            para_length = len(paragraph)

            # 如果当前块为空，直接添加
            if not current_chunk:
                current_chunk.append(paragraph)
                current_length = para_length
            # 如果添加这个段落不会超过最大长度，就添加到当前块
            elif current_length + para_length + 2 <= self.max_chunk_size:
                current_chunk.append(paragraph)
                current_length += para_length + 2  # +2 for newlines
            else:
                # 当前块已满，保存并开始新块
                if current_chunk:
                    chunks.append("\n\n".join(current_chunk))
                current_chunk = [paragraph]
                current_length = para_length

        # 添加最后一个块
        if current_chunk:
            chunks.append("\n\n".join(current_chunk))

        return chunks

    def _generate_chunk_id(self, doc_id: str, chunk_index: int) -> str:
        """生成统一的chunk ID。"""
        return f"{doc_id}::chunk::{chunk_index:04d}"

    def chunk_document(self, doc_id: str, content: str) -> List[Chunk]:
        """
        主分块方法 - 优化分块策略。
        1. 首先按代码块分割，保护代码完整性
        2. 然后按语义边界分割，优先保持内容连贯性
        3. 最后合并标题信息，避免过度分割
        """
        all_chunks = []
        chunk_index = 0

        # 第一层：按代码块分割（保护代码完整性，保留代码块本身）
        code_parts = self._split_by_code_blocks(content)

        for part in code_parts:
            part_stripped = part.strip()
            is_code_block = part_stripped.startswith("```") and part_stripped.endswith("```")

            # 如果是代码块，直接作为一个整体chunk，不再做语义拆分
            if is_code_block:
                header = self._extract_relevant_header(part, content)
                merged_content = part  # 代码块保持原样
                if header and header.strip() and not merged_content.strip().startswith(header.strip()):
                    merged_content = f"{header.strip()}\n\n{merged_content}"

                if len(merged_content.strip()) < self.min_chunk_size:
                    # 对于代码块，即使很短也保留，保持代码完整性
                    pass

                chunk_id = self._generate_chunk_id(doc_id, chunk_index)
                metadata = {
                    "header": header or "",
                    "has_code": True,
                    "length": len(merged_content),
                    "word_count": len(merged_content.split()),
                }
                chunk = Chunk(
                    id=chunk_id,
                    content=merged_content,
                    metadata=metadata,
                    doc_id=doc_id,
                    chunk_index=chunk_index,
                    chunk_type="code",
                    level=header.count("#") if header and header.startswith("#") else 0,
                    position=chunk_index,
                )
                all_chunks.append(chunk)
                chunk_index += 1
                continue  # 处理下一个part

            # 非代码文本，继续按语义边界分块
            semantic_chunks = self._split_by_semantic_boundaries(part)

            for chunk_content in semantic_chunks:
                # 提取当前块的标题信息（如果有）
                header = self._extract_relevant_header(chunk_content, content)

                # 合并标题信息
                merged_content = chunk_content
                if header and header.strip():
                    h = header.strip()
                    # 避免重复：若标题已包含在内容开头，不再合并
                    if not merged_content.strip().startswith(h):
                        merged_content = f"{h}\n\n{merged_content}"

                # 跳过太小的块
                mc = merged_content.strip()
                if len(mc) < self.min_chunk_size:
                    continue

                # 创建chunk
                chunk_id = self._generate_chunk_id(doc_id, chunk_index)

                metadata = {
                    "header": header or "",
                    "has_code": "```" in merged_content,
                    "length": len(merged_content),
                    "word_count": len(merged_content.split()),
                }

                # 确定分块类型
                chunk_type = "text"
                if "```" in merged_content:
                    chunk_type = "code"
                elif header and header.startswith("#"):
                    chunk_type = "header"

                # 确定层级（标题级别）
                level = 0
                if header and header.startswith("#"):
                    level = header.count("#")

                chunk = Chunk(
                    id=chunk_id,
                    content=merged_content,
                    metadata=metadata,
                    doc_id=doc_id,
                    chunk_index=chunk_index,
                    chunk_type=chunk_type,
                    level=level,
                    position=chunk_index,
                )

                all_chunks.append(chunk)
                chunk_index += 1

        return all_chunks

    def _extract_relevant_header(self, chunk_content: str, full_content: str) -> str:
        """
        提取与当前分块内容最相关的标题。
        """
        # 查找当前分块在完整内容中的位置
        chunk_start = full_content.find(chunk_content)
        if chunk_start == -1:
            return ""

        # 向前搜索最近的标题
        lines = full_content[:chunk_start].split("\n")
        header_pattern = r"^(#{1,6})\s+(.+)$"

        # 从后向前搜索，找到最近的标题
        for i in range(len(lines) - 1, -1, -1):
            line = lines[i].strip()
            if re.match(header_pattern, line):
                return line

        return ""


def test_chunker():
    """测试分块器 - 基本功能验证。"""
    chunker = MarkdownChunker()

    # 测试文档 - 通用Markdown结构
    test_content = """
# 标题一

This is a section about general content.

## 子标题 1

Some paragraph content here.

```python
# 代码示例
def example_function():
    return "Hello, World!"
```

## 子标题 2

More content with various formatting.

# 标题二

Another section with different content.

```javascript
console.log('Example');
```

Final paragraph content.
"""

    chunks = chunker.chunk_document("test.md", test_content)

    print(f"Generated {len(chunks)} chunks:")
    for i, chunk in enumerate(chunks):
        print(f"\n--- Chunk {i} ---")
        print(f"ID: {chunk.id}")
        print(f"Type: {chunk.chunk_type}, Level: {chunk.level}")
        print(f"Content preview: {chunk.content[:100]}...")


if __name__ == "__main__":
    test_chunker()
