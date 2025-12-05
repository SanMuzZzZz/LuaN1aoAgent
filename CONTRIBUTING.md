# LuaN1ao 贡献指南

感谢你考虑为LuaN1ao做出贡献!本文档提供了参与项目开发的指导方针。

## 🌟 贡献方式

你可以通过以下方式为项目做出贡献:

1. **报告Bug**: 发现问题?创建一个Issue
2. **建议功能**: 有好想法?告诉我们
3. **提交代码**: 修复Bug或添加新功能
4. **改进文档**: 帮助完善文档
5. **分享经验**: 在Discussion中分享使用经验

## 🐛 报告Bug

在提交Bug报告之前,请:

1. **搜索现有Issue**: 确认问题未被报告
2. **使用最新版本**: 确认问题在最新版本中仍存在
3. **提供详细信息**: 使用下面的模板

### Bug报告模板

```markdown
**问题描述**
简要描述发生的问题

**复现步骤**
1. 执行命令 '...'
2. 设置配置 '...'
3. 观察错误 '...'

**预期行为**
描述你期望发生什么

**实际行为**
描述实际发生了什么

**环境信息**
- OS: [e.g. Ubuntu 20.04]
- Python版本: [e.g. 3.9.7]
- LuaN1ao版本: [e.g. v1.0.0]
- LLM提供商: [e.g. OpenAI gpt-4]

**日志**
```
粘贴相关的日志输出
```

**附加信息**
任何其他有助于诊断问题的信息
```

## 💡 建议功能

在提交功能建议之前,请:

1. **确认独特性**: 搜索现有Issue,避免重复
2. **详细说明**: 清楚描述你的想法和用例
3. **考虑范围**: 确认功能符合项目定位

### 功能建议模板

```markdown
**功能描述**
简要描述建议的功能

**动机**
为什么需要这个功能?它解决什么问题?

**建议方案**
描述你希望的实现方式

**替代方案**
是否考虑过其他实现方式?

**附加信息**
任何其他相关信息、截图、参考链接等
```

## 🔨 开发流程

### 1. 设置开发环境

```bash
# Fork并克隆仓库
git clone https://github.com/your-username/LuaN1aoAgent.git
cd LuaN1aoAgent

# 创建虚拟环境
python -m venv venv
source venv/bin/activate  # Linux/macOS
# 或
venv\Scripts\activate  # Windows

# 安装开发依赖
pip install -r requirements.txt
pip install -r requirements-dev.txt  # 如果有

# 安装pre-commit hooks(推荐)
pip install pre-commit
pre-commit install
```

### 2. 创建功能分支

```bash
# 从main分支创建新分支
git checkout -b feature/amazing-feature

# 或修复bug
git checkout -b fix/bug-description
```

### 3. 编写代码

遵循项目的代码规范(见下文)。

### 4. 提交更改

```bash
# 添加更改
git add .

# 提交(使用有意义的提交信息)
git commit -m "feat: 添加amazing功能"

# 推送到你的Fork
git push origin feature/amazing-feature
```

### 5. 创建Pull Request

1. 访问GitHub上的原始仓库
2. 点击"Pull Request"
3. 选择你的分支
4. 填写PR描述(见下文模板)
5. 提交PR

### Pull Request模板

```markdown
**变更类型**
- [ ] Bug修复
- [ ] 新功能
- [ ] 文档更新
- [ ] 性能优化
- [ ] 代码重构

**变更描述**
简要说明这个PR做了什么

**相关Issue**
修复 #(issue编号)

**测试情况**
描述你如何测试这些变更

**检查清单**
- [ ] 代码遵循项目规范
- [ ] 添加了必要的注释
- [ ] 更新了相关文档
- [ ] 通过了所有测试
- [ ] 没有引入新的警告

**截图**
如果适用,添加截图

**附加信息**
任何其他信息
```

## 📝 代码规范

### Python代码风格

遵循PEP 8规范,具体要求:

1. **命名约定**
   ```python
   # 类名: PascalCase
   class GraphManager:
       pass
   
   # 函数/变量: snake_case
   def process_graph_commands():
       node_id = "task_1"
   
   # 常量: UPPER_SNAKE_CASE
   MAX_RETRY_COUNT = 3
   
   # 私有成员: _leading_underscore
   def _internal_method():
       pass
   ```

2. **导入顺序**
   ```python
   # 标准库
   import os
   import sys
   
   # 第三方库
   import httpx
   from rich.console import Console
   
   # 本地模块
   from core.graph_manager import GraphManager
   from llm.llm_client import LLMClient
   ```

3. **文档字符串**
   ```python
   def function_name(param1: str, param2: int) -> str:
       """
       函数简要描述(第一行).
       
       详细描述函数的功能、用途和注意事项。
       可以包含多行说明。
       
       Args:
           param1: 参数1的详细说明
           param2: 参数2的详细说明
       
       Returns:
           str: 返回值的详细说明
       
       Raises:
           ValueError: 在什么情况下抛出
           RuntimeError: 在什么情况下抛出
       
       Examples:
           >>> function_name("test", 123)
           "result"
       
       Note:
           重要提示或注意事项
       """
       pass
   ```

4. **类型注解**
   ```python
   from typing import List, Dict, Any, Optional
   
   def process_data(
       data: List[Dict[str, Any]],
       options: Optional[Dict[str, str]] = None
   ) -> bool:
       """处理数据"""
       pass
   ```

5. **注释**
   ```python
   # 单行注释: 描述下一行代码的作用
   result = complex_function()
   
   # 多行注释: 用于说明复杂逻辑
   # 第一步: 初始化数据结构
   # 第二步: 处理边缘情况
   # 第三步: 返回结果
   
   # TODO: 待实现的功能描述
   # FIXME: 需要修复的问题描述
   # NOTE: 重要说明
   ```

### 代码组织

1. **文件结构**
   ```python
   #!/usr/bin/env python3
   # -*- coding: utf-8 -*-
   """模块文档字符串."""
   
   # 导入
   import ...
   
   # 常量
   CONSTANT_VALUE = 42
   
   # 类定义
   class MyClass:
       pass
   
   # 函数定义
   def my_function():
       pass
   
   # 主程序入口
   if __name__ == "__main__":
       main()
   ```

2. **函数长度**
   - 单个函数不超过50行(推荐)
   - 超过则考虑拆分为多个小函数

3. **模块职责**
   - 每个模块专注于单一职责
   - 避免循环导入

### 提交信息规范

使用Conventional Commits格式:

```
<类型>(<范围>): <简短描述>

[可选的详细描述]

[可选的页脚]
```

**类型**:
- `feat`: 新功能
- `fix`: Bug修复
- `docs`: 文档更新
- `style`: 代码格式调整
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具相关

**示例**:
```bash
# 新功能
git commit -m "feat(planner): 添加分支重规划功能"

# Bug修复
git commit -m "fix(executor): 修复工具调用超时问题"

# 文档更新
git commit -m "docs: 更新README中的安装说明"

# 详细提交
git commit -m "feat(reflector): 支持自定义反思模板

- 添加模板加载机制
- 实现模板参数替换
- 更新相关文档

Closes #123"
```

## 🧪 测试

### 运行测试

```bash
# 运行所有测试
pytest

# 运行特定测试文件
pytest tests/test_planner.py

# 查看覆盖率
pytest --cov=core tests/
```

### 编写测试

```python
import pytest
from core.planner import Planner

class TestPlanner:
    """Planner类的测试."""
    
    def setup_method(self):
        """每个测试方法前执行."""
        self.planner = Planner(mock_llm_client)
    
    def test_plan_generation(self):
        """测试规划生成功能."""
        # Arrange
        goal = "测试目标"
        
        # Act
        result = self.planner.plan(goal)
        
        # Assert
        assert result is not None
        assert len(result) > 0
    
    @pytest.mark.asyncio
    async def test_async_plan(self):
        """测试异步规划."""
        result = await self.planner.async_plan("目标")
        assert result is not None
```

## 📚 文档

### 更新文档

如果你的更改影响到用户使用方式:

1. 更新README.md
2. 更新相关的文档文件
3. 添加使用示例
4. 更新CHANGELOG.md

### 文档风格

- 使用清晰、简洁的语言
- 提供代码示例
- 包含常见问题的解决方案
- 使用适当的格式化(标题、列表、代码块等)

## 🔍 代码审查

Pull Request会经过以下审查:

1. **代码质量**: 是否遵循代码规范
2. **功能正确性**: 是否正确实现了功能
3. **测试覆盖**: 是否有足够的测试
4. **文档完整性**: 是否更新了相关文档
5. **向后兼容**: 是否保持了向后兼容性

### 审查反馈

收到审查反馈后:

1. 仔细阅读每条评论
2. 对于不清楚的地方提出问题
3. 根据反馈更新代码
4. 回复每条评论说明你的更改
5. 请求重新审查

## 🎯 优先事项

当前项目的开发重点:

1. **核心功能增强**
   - 改进规划器的策略生成
   - 优化执行器的并行处理
   - 增强反思器的分析能力

2. **工具生态**
   - 添加更多安全测试工具
   - 改进MCP工具集成框架
   - 提供工具开发模板

3. **性能优化**
   - 减少LLM调用次数
   - 优化图谱管理效率
   - 改进内存使用

4. **用户体验**
   - 改进Web可视化界面
   - 添加更多配置选项
   - 完善错误提示

## 📜 许可证

提交代码即表示你同意你的贡献将在MIT许可证下分发。

## 🙋 获取帮助

如果你在贡献过程中遇到问题:

1. 查看现有的Issues和Discussions
2. 在Discussion中提问
3. 联系维护者

## 🎉 感谢

感谢所有贡献者的付出!每一个贡献都让项目变得更好。

你的名字将出现在:
- README.md的贡献者列表中
- CHANGELOG.md的相应版本记录中
- 项目致谢页面

---

**记住**: 好的PR往往比大的PR更容易审查和合并。从小的改进开始!
