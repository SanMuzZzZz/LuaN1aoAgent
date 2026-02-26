# Core Prompts Module

基于Jinja2模板的统一提示词管理系统。

## 📦 模块结构

```
core/prompts/
├── __init__.py                    # 模块入口,导出公共接口
├── manager.py                     # PromptManager - 统一提示词管理器
├── renderers.py                   # 通用上下文渲染器
├── planner_template.jinja2        # Planner提示词模板
├── executor_template.jinja2       # Executor提示词模板
├── reflector_template.jinja2      # Reflector提示词模板
└── README.md                      # 本文档
```

## 🚀 快速开始

### 安装依赖

```bash
pip install jinja2==3.1.4
```

### 基本使用

```python
from core.prompts import PromptManager

# 创建管理器实例
manager = PromptManager()

# 生成Planner提示词
planner_prompt = manager.build_planner_prompt(
    goal="渗透测试目标系统",
    context={
        'causal_graph_summary': '当前图谱摘要',
        'failure_patterns': {'repeated_failures': [...]},
    }
)

# 生成Executor提示词
executor_prompt = manager.build_executor_prompt(
    main_goal="获取系统权限",
    subtask={'id': 'task_1', 'description': '测试SQL注入'},
    context={'key_facts': ['已发现登录表单'], ...}
)

# 生成Reflector提示词
reflector_prompt = manager.build_reflector_prompt(
    subtask={'id': 'task_1', 'description': '...'},
    status='completed',
    execution_log='...',
    staged_causal_nodes=[...],
    context={'causal_graph_summary': '...'}
)
```

## 📖 API文档

### PromptManager

统一的提示词管理器,负责所有角色的Prompt生成。

#### `build_planner_prompt(goal, context, is_dynamic=False, planner_context=None)`

生成Planner提示词。

**参数**:

- `goal` (str): 用户的高级目标
- `context` (dict): 上下文数据
  - `causal_graph_summary`: 因果图摘要
  - `causal_graph_data`: 因果图完整数据(用于渲染)
  - `failure_patterns`: 失败模式字典
  - `failed_tasks_summary`: 失败任务摘要
  - `retrieved_experience`: 检索到的历史经验
- `is_dynamic` (bool): 是否为动态规划
- `planner_context`: 规划上下文对象(可选)

**返回**: str - 格式化的提示词

**示例**:

```python
prompt = manager.build_planner_prompt(
    goal="渗透测试Web应用",
    context={
        'causal_graph_summary': '已完成初步侦察',
        'causal_graph_data': {
            'key_facts': ['使用Flask框架'],
            'hypotheses': [...]
        },
        'failure_patterns': {...},
        'failed_tasks_summary': '任务X失败: 原因Y',
        'retrieved_experience': '历史经验...'
    },
    is_dynamic=True
)
```

#### `build_executor_prompt(main_goal, subtask, context, global_mission_briefing="")`

生成Executor提示词。

**参数**:

- `main_goal` (str): 核心总目标
- `subtask` (dict): 当前子任务数据
  - `id`: 任务ID
  - `description`: 任务描述
  - `completion_criteria`: 完成标准
- `context` (dict): 上下文数据
  - `causal_context`: 相关因果链上下文
  - `dependencies`: 依赖任务列表
  - `causal_graph_summary`: 全局因果图摘要
  - `key_facts`: 关键事实列表
  - `subtask`: 子任务数据(同上)
- `global_mission_briefing` (str): 全局任务简报

**返回**: str - 格式化的提示词

**示例**:

```python
prompt = manager.build_executor_prompt(
    main_goal="获取管理员权限",
    subtask={
        'id': 'subtask_1',
        'description': '测试登录表单SQL注入',
        'completion_criteria': '确认漏洞存在'
    },
    context={
        'causal_context': {'related_hypotheses': [...]},
        'dependencies': [{...}],
        'key_facts': ['目标使用MySQL'],
        'causal_graph_summary': '...'
    },
    global_mission_briefing="这是授权的安全测试"
)
```

#### `build_reflector_prompt(subtask, status, execution_log, staged_causal_nodes, context, reflector_context=None)`

生成Reflector提示词。

**参数**:

- `subtask` (dict): 子任务数据
- `status` (str): 执行状态
- `execution_log` (str): 执行日志
- `staged_causal_nodes` (list): 暂存的因果节点
- `context` (dict): 上下文数据
  - `causal_graph_summary`: 因果图摘要
  - `dependency_context`: 依赖上下文
  - `failure_patterns`: 失败模式
- `reflector_context`: 反思上下文对象(可选)

**返回**: str - 格式化的提示词

**示例**:

```python
prompt = manager.build_reflector_prompt(
    subtask={'id': 'task_1', 'description': '...'},
    status='completed',
    execution_log='步骤1: ...\n步骤2: ...',
    staged_causal_nodes=[
        {'node_type': 'Evidence', 'id': 'e1', ...},
        {'node_type': 'ConfirmedVulnerability', ...}
    ],
    context={
        'causal_graph_summary': '已确认SQL注入',
        'failure_patterns': None
    }
)
```

### 渲染器函数

#### `render_causal_graph(context, mode='full')`

渲染因果图。

**参数**:

- `context` (dict): 因果图数据
- `mode` (str): 渲染模式
  - `'full'`: 完整图谱(Planner/Reflector)
  - `'relevant'`: 过滤后的相关上下文(Executor)

**返回**: str - 格式化的因果图文本

#### `render_key_facts(key_facts)`

渲染关键事实列表。

**参数**:

- `key_facts` (list): 关键事实列表

**返回**: str - 格式化的关键事实文本

#### `render_failure_patterns(patterns)`

渲染失败模式。

**参数**:

- `patterns` (dict): 失败模式数据

**返回**: str - 格式化的失败模式文本

#### `render_dependencies_summary(deps)`

渲染依赖任务摘要。

**参数**:

- `deps` (list): 依赖任务列表

**返回**: str - 格式化的依赖摘要文本

## 🎨 Jinja2模板

### 模板语法

#### 变量替换

```jinja2
### 高级目标
你的最终目标是实现: **{{ goal }}**
```

#### 条件渲染

```jinja2
{% if key_facts %}
{{ key_facts }}
{% endif %}
```

#### 循环(如需要)

```jinja2
{% for fact in key_facts %}
- {{ fact }}
{% endfor %}
```

### 自定义模板

1. 在`core/prompts/`目录下创建新的`.jinja2`文件
2. 在`PromptManager`中添加加载逻辑
3. 实现对应的`build_xxx_prompt()`方法

## 🔧 高级用法

### 添加自定义渲染器

在`renderers.py`中添加新函数:

```python
def render_custom_context(data: Dict[str, Any]) -> str:
    """自定义上下文渲染器"""
    lines = ["### 自定义上下文"]
    # 处理逻辑
    return "\n".join(lines)
```

### 扩展PromptManager

```python
from core.prompts.manager import PromptManager

class CustomPromptManager(PromptManager):
    def __init__(self):
        super().__init__()
        # 加载自定义模板
        self.custom_template = self.env.get_template('custom_template.jinja2')
    
    def build_custom_prompt(self, **kwargs):
        # 自定义逻辑
        return self.custom_template.render(**kwargs)
```

## 🧪 测试

运行测试套件:

```bash
python tests/test_prompt_system.py
```

测试内容包括:

- Planner提示词生成
- Executor提示词生成
- Reflector提示词生成
- 各个渲染器功能

## 📋 最佳实践

1. **统一使用PromptManager**: 不要直接操作模板文件
2. **复用渲染器**: 使用统一的渲染函数确保一致性
3. **参数验证**: 在调用前验证context字典的完整性
4. **错误处理**: 捕获模板渲染异常
5. **性能优化**: 对于频繁调用,考虑缓存PromptManager实例

## 🤝 贡献

修改模板或添加新功能时:

1. 更新相应的`.jinja2`模板文件
2. 在`manager.py`中添加/修改生成方法
3. 在`renderers.py`中添加/修改渲染函数
4. 更新测试用例
5. 更新文档

## 📚 相关文档

- [重构总结](../../PROMPT_SYSTEM_REFACTORING_SUMMARY.md)
- [迁移指南](../../PROMPT_REFACTORING_GUIDE.md)
- [测试脚本](../../tests/test_prompt_system.py)

## 🐛 故障排查

### 常见问题

**Q: 模板渲染失败**

```
jinja2.exceptions.TemplateNotFound: planner_template.jinja2
```

**A**: 确保模板文件在`core/prompts/`目录下

**Q: 变量未定义**

```
jinja2.exceptions.UndefinedError: 'key_facts' is undefined
```

**A**: 在调用`build_xxx_prompt()`时确保context包含所有必需字段

**Q: 输出格式不符合预期**
**A**: 检查渲染器函数的输出,确保返回格式正确

## 📄 许可

与LuaN1ao项目保持一致。
