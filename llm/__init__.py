#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LuaN1ao LLM客户端模块.

本包提供与大语言模型(LLM)交互的统一接口，
支持多种LLM提供商（OpenAI、Anthropic等）。

主要功能:
    - 统一的消息发送接口
    - 多提供商支持（OpenAI、Anthropic）
    - 角色化模型选择
    - 自动重试和错误处理
    - Token使用统计
    - 成本计算

典型用法:
    from llm import LLMClient

    client = LLMClient()
    response, metrics = await client.send_message(
        messages=[{"role": "user", "content": "Hello"}],
        role="executor"
    )
"""

from llm.llm_client import LLMClient

__all__ = [
    "LLMClient",
]

__version__ = "1.0.0"
