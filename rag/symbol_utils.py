"""
符号处理工具 - 基于Python标准库的简化实现
替代复杂的rag_symbols_config.py
"""

import unicodedata
from typing import Set, List


class SymbolUtils:
    """统一的符号处理工具类。"""

    # 符号类别映射
    SYMBOL_CATEGORIES = {
        "parentheses": {"chars": "()（）", "names": ["parenthesis", "brackets", "括号", "圆括号"]},
        "angle_brackets": {"chars": "<>＜＞", "names": ["angle", "chevrons", "尖括号", "标签"]},
        "quotes": {"chars": "'\"＇＂", "names": ["quote", "quotation", "引号", "引用符"]},
        "backticks": {"chars": "`", "names": ["backtick", "grave", "反引号"]},
        "acute_accents": {"chars": "´", "names": ["acute", "accent", "尖音符"]},
    }

    @staticmethod
    def is_symbol_char(char: str) -> bool:
        """检查字符是否为符号字符。"""
        if len(char) != 1:
            return False

        # 使用Unicode分类检测符号
        category = unicodedata.category(char)
        return category.startswith("P")  # 所有标点符号

    @staticmethod
    def detect_categories(text: str) -> Set[str]:
        """检测文本中的符号类别。"""
        categories = set()

        for char in text:
            if SymbolUtils.is_symbol_char(char):
                for category, config in SymbolUtils.SYMBOL_CATEGORIES.items():
                    if char in config["chars"]:
                        categories.add(category)
                        break

        return categories

    @staticmethod
    def generate_encodings(text: str) -> List[str]:
        """为文本中的符号生成编码变体。"""
        variants = []

        for char in text:
            if SymbolUtils.is_symbol_char(char):
                # URL编码
                try:
                    url_encoded = "".join(f"%{ord(c):02X}" for c in char)
                    variants.append(url_encoded)
                    variants.append(url_encoded.lower())
                except (ValueError, TypeError) as e:
                    # 忽略无法URL编码的字符
                    pass

                # HTML实体编码
                for c in char:
                    variants.append(f"&#{ord(c)};")  # 十进制
                    variants.append(f"&#x{ord(c):X};")  # 十六进制大写
                    variants.append(f"&#x{ord(c):x};")  # 十六进制小写

        return list(set(variants))  # 去重

    @staticmethod
    def extract_symbols(text: str) -> List[str]:
        """提取文本中的所有符号。"""
        symbols = []

        for char in text:
            if SymbolUtils.is_symbol_char(char):
                symbols.append(char)

        return symbols


def detect_symbol_categories(text: str) -> Set[str]:
    """兼容性函数 - 检测符号类别。"""
    return SymbolUtils.detect_categories(text)


def generate_all_symbol_variants() -> List[str]:
    """兼容性函数 - 生成所有符号变体。"""
    all_chars = "".join(config["chars"] for config in SymbolUtils.SYMBOL_CATEGORIES.values())
    return SymbolUtils.generate_encodings(all_chars)


def get_important_symbols() -> List[str]:
    """兼容性函数 - 获取重要符号。"""
    all_chars = "".join(config["chars"] for config in SymbolUtils.SYMBOL_CATEGORIES.values())
    return list(all_chars) + generate_all_symbol_variants()


# 测试
if __name__ == "__main__":
    test_text = "测试(括号)和'引号'<标签>"

    print("原始文本:", test_text)
    print("检测到的类别:", SymbolUtils.detect_categories(test_text))
    print("符号编码变体:", SymbolUtils.generate_encodings(test_text)[:5])
    print("提取的符号:", SymbolUtils.extract_symbols(test_text))
