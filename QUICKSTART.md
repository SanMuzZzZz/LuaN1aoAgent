# 鸾鸟 (LuaN1ao) 快速参考指南

本指南旨在帮助你快速搭建环境并运行鸾鸟 (LuaN1ao) 自主渗透测试 Agent。

## 📋 环境准备

确保你的系统满足以下要求：

*   **操作系统**: Linux (推荐), macOS, 或 Windows (WSL2)
*   **Python**: 3.10 或更高版本
*   **内存**: 建议 8GB 以上 (运行 RAG 服务和 LLM 推理)
*   **LLM API**: 一个支持 OpenAI 格式的 API Key (如 OpenAI GPT-4o, DeepSeek, Claude-3.5 via API proxy 等)

## 🛠️ 安装步骤

### 1. 获取代码

```bash
git clone https://github.com/SanMuzZzZz/LuaN1aoAgent.git
cd LuaN1aoAgent
```

### 2. 创建虚拟环境 (推荐)

为了避免依赖冲突，建议使用 Python 虚拟环境。

**Linux / macOS:**
```bash
python3 -m venv venv
source venv/bin/activate
```

**Windows (CMD/PowerShell):**
```bash
python -m venv venv
venv\Scripts\activate
```

### 3. 安装依赖

```bash
pip install -r requirements.txt
```

---

## ⚙️ 配置指南

### 1. 环境变量配置

复制示例配置文件：
```bash
cp .env.example .env
```

编辑 `.env` 文件，填入你的 LLM 配置。关键配置项如下：

```ini
# 必填: LLM API 密钥
LLM_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx

# 必填: LLM API 基础 URL (根据你的服务商填写)
# 例如 OpenAI: https://api.openai.com/v1
# 例如 DeepSeek: https://api.deepseek.com/v1
LLM_API_BASE_URL=https://api.openai.com/v1

# 选填: 指定模型 (建议使用能力较强的模型)
LLM_DEFAULT_MODEL=gpt-4o
LLM_PLANNER_MODEL=gpt-4o
LLM_EXECUTOR_MODEL=gpt-4o
LLM_REFLECTOR_MODEL=gpt-4o

# 选填: 思考模式 (如果模型支持，如 Claude-3.5-Sonnet 或 o1)
LLM_DEFAULT_THINKING=off
```

### 2. 初始化知识库 (重要)

鸾鸟依赖 RAG (检索增强生成) 系统来获取最新的安全知识。首次运行前**必须**初始化知识库。

**步骤 2.1: 克隆知识库**
`PayloadsAllTheThings` 是一个广泛使用的开源渗透测试知识库。你需要手动将其克隆到项目的 `knowledge_base` 目录下。

```bash
# 检查 knowledge_base 目录是否存在，如果不存在则创建
mkdir -p knowledge_base

# 克隆 PayloadsAllTheThings 仓库
git clone https://github.com/swisskyrepo/PayloadsAllTheThings knowledge_base/PayloadsAllTheThings
```

**步骤 2.2: 构建知识库索引**
克隆完成后，运行以下命令构建知识库索引：

```bash
# 此命令将扫描 knowledge_base 目录下的文档并构建 FAISS 向量索引
python -m rag.rag_kdprepare
```
*注意：此步骤可能需要几分钟，取决于你的系统性能和知识库大小。*

---

## 🚀 运行 Agent (新架构)

系统现在分为两个独立进程运行：**Web 服务**（监控台）和 **Agent**（工作进程）。

### 1. 启动 Web 服务 (Dashboard)

首先启动持久化的 Web 界面。该进程应保持运行。

```bash
# 启动 Web Server (默认端口 8088)
python -m web.server
```
*打开浏览器访问: http://localhost:8088*

### 2. 启动 Agent 任务

打开一个**新的终端窗口**运行 Agent。Agent 将执行任务，将日志写入数据库，并在完成后退出。Web UI 会实时更新。

**基础扫描任务：**
```bash
python agent.py --goal "对 http://target.local 进行全面的 Web 安全测试" --task-name "task_001"
```

**启用 --web 标志：**
这不会启动新的 Web 服务，而是会打印出当前任务在 Web UI 中的直接访问链接。
```bash
python agent.py --goal "Scan localhost" --task-name "local_scan" --web
```

### 3. 管理任务

- **查看历史**: 访问 Web UI 首页，可以看到所有历史任务列表。
- **删除任务**: 在 Web UI 左侧任务列表中，悬停在任务卡片上，点击右侧的 "✕" 按钮删除任务及其关联数据。
- **人工干预**: 如果启用了 `HUMAN_IN_THE_LOOP=true`，Web UI 会自动弹出审批窗口。

---

## 🔍 常见问题排查 (Troubleshooting)

### Q1: `ModuleNotFoundError` 或 `ImportError`
*   **原因**: 依赖未正确安装或未激活虚拟环境。
*   **解决**: 确认已运行 `source venv/bin/activate` 且执行了 `pip install -r requirements.txt`。

### Q2: 知识检索报错 / RAG 服务未启动
*   **原因**: 未初始化知识库或端口被占用。
*   **解决**:
    1.  确保已运行 `python -m rag.rag_kdprepare`。
    2.  检查端口 8081 (默认 RAG 服务端口) 是否被占用。
    3.  在 `.env` 中修改 `KNOWLEDGE_SERVICE_PORT`。

### Q3: Web UI 显示空白或不刷新
*   **原因**: Web 服务与 Agent 没有连接到同一个数据库，或者前端缓存问题。
*   **解决**:
    1.  确保在项目根目录下运行命令。
    2.  尝试强制刷新浏览器 (Ctrl+F5)。
    3.  检查控制台是否有 SSE 连接错误。

### Q4: 无法删除任务
*   **原因**: 数据库锁定或权限问题。
*   **解决**: 确保没有其他进程（如 SQLite 客户端）正在锁定 `luan1ao.db` 文件。

---

## 📚 更多文档

*   [README.md](README.md) - 项目主文档
*   [CONTRIBUTING.md](CONTRIBUTING.md) - 贡献指南