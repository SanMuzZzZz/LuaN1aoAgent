# core/console.py
"""
提供全局访问的Rich Console对象，通过getter函数获取。
"""

from rich.console import Console
from typing import TextIO, Any
import sys

_console = Console()


def get_console() -> Console:
    """
    获取当前的控制台实例。

    Returns:
        全局共享的Console实例
    """
    return _console


def init_console_with_file(log_file: TextIO) -> Console:
    """
    初始化支持文件写入的控制台。

    创建一个新的Console实例，可以同时向stdout和指定文件写入输出。

    Args:
        log_file: 用于写入日志的文件对象

    Returns:
        配置好的Console实例
    """

    class MultiFileWriter:
        """
        多文件写入器。

        将输出同时写入多个文件对象（如stdout和日志文件）。
        自动处理管道断开、文件句柄关闭等异常，确保业务不中断。

        Attributes:
            files: 文件对象元组，用于接收输出

        Examples:
            >>> writer = MultiFileWriter(sys.stdout, log_file)
            >>> writer.write("Hello\n")
            >>> writer.flush()
        """

        def __init__(self, *files):
            self.files = files

        def write(self, text):
            for file in self.files:
                try:
                    file.write(text)
                    file.flush()
                except (BrokenPipeError, ValueError, OSError):
                    # 忽略管道断开或文件句柄关闭的异常，保证业务不中断
                    # 仍然允许其他目标（如日志文件）写入成功
                    continue

        def flush(self):
            for file in self.files:
                try:
                    file.flush()
                except (BrokenPipeError, ValueError, OSError):
                    continue

    # 创建一个多文件写入器，同时写入stdout和日志文件
    multi_writer = MultiFileWriter(sys.stdout, log_file)
    
    # 检测 stdout 是否为终端，以决定是否强制开启颜色
    # MultiFileWriter 没有 isatty 方法，会导致 rich 默认关闭颜色
    is_terminal = False
    try:
        is_terminal = sys.stdout.isatty()
    except Exception:
        pass

    global _console
    _console = Console(file=multi_writer, force_terminal=is_terminal)
    return _console


def set_console(new_console: Console):
    """
    更新全局Console实例。

    Args:
        new_console: 新的Console实例
    """
    global _console
    _console = new_console


def sanitize_for_rich(text: Any) -> str:
    """
    清理文本中的Rich标记字符和非法字符，防止Rich库解析错误

    Args:
        text: 任意类型的输入，将被转换为字符串

    Returns:
        清理后的安全字符串
    """
    if text is None:
        return ""
    text = str(text)
    text = text.replace("[", "\\[").replace("]", "\\]")
    text = "".join(c for c in text if c.isprintable() or c in "\n\t\r")
    max_length = 10000
    if len(text) > max_length:
        text = text[:max_length] + "\n\n... (output truncated)"
    return text


class ConsoleProxy:
    """
    控制台代理类。

    该类作为全局Console实例的代理，确保每次调用时都能获取最新的、
    正确配置的Console实例。支持动态切换Console输出目标（文件/终端）。

    Attributes:
        无直接属性，所有属性和方法调用都会被代理到当前Console实例

    Examples:
        >>> console_proxy.print("Hello", style="bold green")
        >>> console_proxy.log("Debug info")
    """

    def __getattr__(self, name):
        return getattr(get_console(), name)


# 全局ConsoleProxy实例
console_proxy = ConsoleProxy()
