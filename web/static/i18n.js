// 国际化配置
const i18n = {
  zh: {
    // Topbar
    'brand': '鸾鸟Agent',
    'view.exec': '攻击图',
    'view.causal': '因果图',
    'input.goal': '输入目标...',
    'input.taskid': '任务ID',
    'btn.create': '新建',
    'btn.mcp': 'MCP',
    'btn.inject': '注入',
    'btn.refresh': '刷新',
    'btn.stop': '终止',
    
    // Sidebar
    'sidebar.operations': '操作列表',
    
    // Right Panel
    'panel.details': '节点详情',
    'panel.notselected': '未选择节点',
    'panel.type': '类型',
    'panel.status': '状态',
    'panel.description': '描述',
    'panel.thought': '思考',
    'panel.goal': '目标',
    'panel.tool': '工具',
    'panel.args': '参数',
    'panel.result': '结果',
    'panel.observation': '观察',
    
    // Modals
    'modal.mcp.title': 'MCP服务配置',
    'modal.mcp.name': '服务名',
    'modal.mcp.command': '启动命令',
    'modal.mcp.args': '参数 (JSON)',
    'modal.mcp.env': '环境变量 (JSON)',
    'modal.inject.title': '注入任务',
    'modal.inject.opid': 'Operation ID',
    'modal.inject.subtask': '子任务 (JSON)',
    'btn.submit': '提交',
    'btn.cancel': '取消',
    
    // Status
    'status.completed': '已完成',
    'status.failed': '失败',
    'status.in_progress': '进行中',
    'status.pending': '待执行',
    'status.deprecated': '已废弃',
    'status.running': '运行中',
    
    // Node Types
    'type.root': '主任务',
    'type.task': '子任务',
    'type.action': '执行步骤',
    
    // Legend
    'legend.title': '图例',
    'legend.node_types': '节点类型',
    'legend.node_status': '节点状态',
    
    // Messages
    'msg.no_opid': '请先选择一个 Operation',
    'msg.confirm_abort': '确认要终止当前操作吗？',
    'msg.task_created': '任务创建成功',
    'msg.task_injected': '任务注入成功',
    'msg.operation_aborted': '操作已终止',
  },
  
  en: {
    // Topbar
    'brand': 'LuanNiao Agent',
    'view.exec': 'Attack Graph',
    'view.causal': 'Causal Graph',
    'input.goal': 'Enter goal...',
    'input.taskid': 'Task ID',
    'btn.create': 'Create',
    'btn.mcp': 'MCP',
    'btn.inject': 'Inject',
    'btn.refresh': 'Refresh',
    'btn.stop': 'Stop',
    
    // Sidebar
    'sidebar.operations': 'Operations',
    
    // Right Panel
    'panel.details': 'Node Details',
    'panel.notselected': 'No node selected',
    'panel.type': 'Type',
    'panel.status': 'Status',
    'panel.description': 'Description',
    'panel.thought': 'Thought',
    'panel.goal': 'Goal',
    'panel.tool': 'Tool',
    'panel.args': 'Arguments',
    'panel.result': 'Result',
    'panel.observation': 'Observation',
    
    // Modals
    'modal.mcp.title': 'MCP Service Config',
    'modal.mcp.name': 'Service Name',
    'modal.mcp.command': 'Command',
    'modal.mcp.args': 'Args (JSON)',
    'modal.mcp.env': 'Environment (JSON)',
    'modal.inject.title': 'Inject Task',
    'modal.inject.opid': 'Operation ID',
    'modal.inject.subtask': 'Subtask (JSON)',
    'btn.submit': 'Submit',
    'btn.cancel': 'Cancel',
    
    // Status
    'status.completed': 'Completed',
    'status.failed': 'Failed',
    'status.in_progress': 'In Progress',
    'status.pending': 'Pending',
    'status.deprecated': 'Deprecated',
    'status.running': 'Running',
    
    // Node Types
    'type.root': 'Root Task',
    'type.task': 'Subtask',
    'type.action': 'Action',
    
    // Legend
    'legend.title': 'Legend',
    'legend.node_types': 'Node Types',
    'legend.node_status': 'Node Status',
    
    // Messages
    'msg.no_opid': 'Please select an operation first',
    'msg.confirm_abort': 'Are you sure to abort current operation?',
    'msg.task_created': 'Task created successfully',
    'msg.task_injected': 'Task injected successfully',
    'msg.operation_aborted': 'Operation aborted',
  }
};

// 当前语言，默认中文
let currentLang = localStorage.getItem('lang') || 'zh';

// 翻译函数
function t(key) {
  return i18n[currentLang][key] || key;
}

// 切换语言
function switchLanguage(lang) {
  if (!i18n[lang]) return;
  currentLang = lang;
  localStorage.setItem('lang', lang);
  updateUITexts();
  // 重新渲染图表以更新节点文本
  render(true);
}

// 更新UI中的文本
function updateUITexts() {
  // 更新所有带 data-i18n 属性的元素
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const translation = t(key);
    
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.placeholder = translation;
    } else {
      el.textContent = translation;
    }
  });
}

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', () => {
  updateUITexts();
});
