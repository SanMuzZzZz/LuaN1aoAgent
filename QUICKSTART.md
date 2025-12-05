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

## 🚀 运行 Agent

### 基础运行

最简单的运行方式，只需指定目标和任务名称。

```bash
python agent.py --goal "对 http://target.local 进行全面的 Web 安全测试" --task-name "task_001"
```

### 启用 Web 可视化 (推荐)

启动一个 Web 服务器，实时展示任务图谱和执行进度。

```bash
python agent.py --goal "测试 http://target.local 的 SQL 注入漏洞" --task-name "sql_test" --web --web-port 8000
```
*访问浏览器: http://localhost:8000*

### 详细日志模式

如果你需要调试或查看 Agent 的详细思考过程。

```bash
python agent.py --goal "测试目标" --task-name "debug_task" --output-mode debug
```

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

### Q3: LLM API 连接超时或 401 错误
*   **原因**: API Key 错误、Base URL 不匹配或网络问题。
*   **解决**: 检查 `.env` 中的 `LLM_API_KEY` 和 `LLM_API_BASE_URL`。如果是国内网络，可能需要配置代理或使用国内的中转 API。

### Q4: Agent 陷入死循环
*   **原因**: 模型能力不足或任务目标过于模糊。
*   **解决**:
    1.  尝试使用更强大的模型 (如 GPT-4o)。
    2.  提供更具体的目标描述 (例如："测试 /login 接口的 SQL 注入" 而不是 "黑掉这个网站")。

---

## 📚 更多文档

*   [README.md](README.md) - 项目主文档
*   [CONTRIBUTING.md](CONTRIBUTING.md) - 贡献指南