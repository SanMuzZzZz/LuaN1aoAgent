#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LuaN1ao配置模块.

本包提供系统的配置管理功能，包括API密钥、模型参数等核心配置项。

主要配置项:
    - LLM API配置
    - 模型选择和参数
    - 任务成功标准
    - 系统行为控制
"""

from conf.config import (
    LLM_API_BASE_URL,
    LLM_API_KEY,
    LLM_FALLBACK_API_KEY,
    LLM_MODELS,
    LLM_TEMPERATURES,
    LLM_PROVIDER,
)

__all__ = [
    "LLM_API_BASE_URL",
    "LLM_API_KEY",
    "LLM_FALLBACK_API_KEY",
    "LLM_MODELS",
    "LLM_TEMPERATURES",
    "LLM_PROVIDER",
]

__version__ = "1.0.0"
