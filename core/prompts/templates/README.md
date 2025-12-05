# 提示词模板目录结构

## 📁 目录组织

```
templates/
├── common/                          # 通用组件（所有角色共用）
│   ├── domain_knowledge.jinja2      # Web安全领域知识库
│   ├── node_type_guide.jinja2       # 节点类型指南
│   ├── causal_graph_summary.jinja2  # 因果图谱摘要
│   ├── advanced_node_relations.jinja2  # 高级节点关系（Reflector专用）
│   ├── failure_attribution_levels.jinja2  # L0-L5失败归因层级
│   ├── vulnerability_testing_guide.jinja2  # 漏洞测试方法论
│   ├── filter_bypass_methodology.jinja2   # 过滤器检测与绕过
│   ├── tool_selection_guide.jinja2  # 工具选择指南
│   └── response_analysis_framework.jinja2  # 响应分析框架
│
├── executor/                        # Executor专用组件
│   ├── execution_principles.jinja2  # 执行原则
│   ├── executor_methodology.jinja2  # 执行器方法论
│   └── output_schemas/
│       └── executor_schema.jinja2   # 输出格式定义
│
├── planner/                         # Planner专用组件
│   ├── planning_principles.jinja2   # 规划原则
│   └── output_schemas/
│       └── planner_schema.jinja2    # 输出格式定义
│
├── reflector/                       # Reflector专用组件
│   ├── reflection_principles.jinja2 # 反思原则
│   └── output_schemas/
│       └── reflector_schema.jinja2  # 输出格式定义
│
├── branch_replan/                   # BranchReplan专用组件
│   └── output_schemas/
│       └── branch_replan_schema.jinja2  # 输出格式定义
│
├── executor_template.jinja2         # Executor主模板
├── planner_template.jinja2          # Planner主模板
├── reflector_template.jinja2        # Reflector主模板
└── branch_replan_template.jinja2    # BranchReplan主模板
```

## 🎯 设计原则

### 1. 职责分离
- **common/**: 所有角色共享的通用知识和框架
- **角色目录**: 每个角色特有的原则和方法论
- **主模板**: 整合组件，定义角色的完整提示词

### 2. 组件化
- 每个组件专注于单一职责
- 通过`{% include %}`引用实现复用
- 避免重复定义，保持单一信息源

### 3. 分层结构
```
主模板 (角色定义)
  ├── 通用组件 (领域知识、工具、测试方法)
  ├── 角色专用组件 (执行/规划/反思原则)
  └── 输出Schema (JSON格式定义)
```

## 📋 组件说明

### Common 通用组件

| 组件 | 用途 | 使用者 |
|------|------|--------|
| `domain_knowledge.jinja2` | Web安全领域知识、战术知识库 | 所有角色 |
| `node_type_guide.jinja2` | 基础节点类型定义 | 所有角色 |
| `causal_graph_summary.jinja2` | 因果图谱显示 | 所有角色 |
| `advanced_node_relations.jinja2` | 高级节点类型与关系 | Reflector |
| `failure_attribution_levels.jinja2` | L0-L5失败归因标准 | Executor, Reflector |
| `vulnerability_testing_guide.jinja2` | 漏洞测试方法论大全 | Executor |
| `filter_bypass_methodology.jinja2` | 过滤器检测与绕过流程 | Executor |
| `tool_selection_guide.jinja2` | 工具选择决策树 | Executor |
| `response_analysis_framework.jinja2` | 响应分析标准流程 | Executor |

### Executor 执行器组件

| 组件 | 用途 |
|------|------|
| `execution_principles.jinja2` | 科学方法论、智能假设生成、节点提议框架 |
| `executor_methodology.jinja2` | 行动选择、盲注验证、入口检查、响应分析 |

### Planner 规划器组件

| 组件 | 用途 |
|------|------|
| `planning_principles.jinja2` | 战略规划原则、任务生命周期、CTF优化 |

### Reflector 反思器组件

| 组件 | 用途 |
|------|------|
| `reflection_principles.jinja2` | 审计原则、失败归因、证据合成、关键事实提炼 |

## 🔧 使用方法

### 在主模板中引用组件

```jinja2
{# 引用通用组件 #}
{% include 'common/domain_knowledge.jinja2' %}
{% include 'common/tool_selection_guide.jinja2' %}

{# 引用角色专用组件 #}
{% include 'executor/execution_principles.jinja2' %}

{# 引用输出Schema #}
{% include 'executor/output_schemas/executor_schema.jinja2' %}
```

### 在组件中引用其他组件

```jinja2
{# execution_principles.jinja2 中引用通用组件 #}
{% include 'common/vulnerability_testing_guide.jinja2' %}
{% include 'common/filter_bypass_methodology.jinja2' %}
```

## 📊 统计信息

### 文件数量
- 主模板: 4个
- 通用组件: 9个
- 角色专用组件: 4个
- 输出Schema: 4个
- **总计**: 21个文件

### 代码量
- Executor模板: ~33KB
- Planner模板: ~11KB
- Reflector模板: ~18KB
- BranchReplan模板: ~5KB

## ✅ 优化成果

1. **职责清晰**: 通用组件与角色专用组件分离
2. **易于维护**: 修改通用组件会自动影响所有使用者
3. **避免冗余**: 消除了70%的重复内容
4. **模块化**: 每个组件专注单一职责
5. **可扩展**: 新增角色时可复用通用组件

## 🔄 迁移记录

**2025-11-26**: 完成目录重构
- 从 `components/` 迁移到分角色目录
- 更新所有模板引用路径
- 验证所有模板渲染成功
