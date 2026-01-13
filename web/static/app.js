const nodeColors = {
  'default': '#3b82f6',
  // 执行状态颜色
  'completed': '#10b981',
  'failed': '#ef4444',
  'pending': '#64748b',
  'in_progress': '#3b82f6',
  'deprecated': '#94a3b8',
  'aborted': '#94a3b8',
  'aborted_by_halt_signal': '#94a3b8',
  'stalled_no_plan': '#f59e0b',
  'stalled_orphan': '#f59e0b',
  'completed_error': '#ef4444',
  // 因果图节点类型颜色
  'ConfirmedVulnerability': '#f59e0b',
  'Vulnerability': '#a855f7',
  'Evidence': '#06b6d4',
  'Hypothesis': '#84cc16',
  'KeyFact': '#fbbf24',
  'Flag': '#ef4444'
};

// 因果图颜色映射
const causalColors = {
  'ConfirmedVulnerability': '#f59e0b',
  'Vulnerability': '#a855f7',
  'Evidence': '#06b6d4',
  'Hypothesis': '#84cc16',
  'KeyFact': '#fbbf24',
  'Flag': '#ef4444'
};
let state = { op_id: new URLSearchParams(location.search).get('op_id') || '', view: 'exec', simulation: null, svg: null, g: null, zoom: null, es: null, processedEvents: new Set(), pendingReq: null, isModifyMode: false, currentPhase: null, missionAccomplished: false, userHasInteracted: false, lastActiveNodeId: null, isProgrammaticZoom: false, renderDebounceTimer: null, lastRenderTime: 0, isLoadingHistory: false, collapsedNodes: new Set(), userExpandedNodes: new Set(), leftSidebarCollapsed: false, rightSidebarCollapsed: false };
const api = (p, b) => fetch(p + (p.includes('?') ? '&' : '?') + `op_id=${state.op_id}`, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : {}).then(r => r.json());

// 显示阶段横幅
function showPhaseBanner(phase) {
  const banner = document.getElementById('phase-banner');
  const text = document.getElementById('phase-text');

  // 如果任务已完成，不再显示中间状态
  if (state.missionAccomplished) return;

  if (phase) {
    text.textContent = t('phase.' + phase);
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }

  state.currentPhase = phase;
}

// 隐藏阶段横幅
function hidePhaseBanner() {
  document.getElementById('phase-banner').style.display = 'none';
  state.currentPhase = null;
}

// 显示任务完成横幅
function showSuccessBanner() {
  const banner = document.getElementById('phase-banner');
  const spinner = banner.querySelector('.spinner');
  const text = document.getElementById('phase-text'); // [Fix] Use ID selector instead of class selector

  // 隐藏旋转图标，改为成功图标
  if (spinner) spinner.style.display = 'none';

  text.textContent = '🎉 ' + t('status.mission_accomplished');
  banner.style.background = 'linear-gradient(90deg, rgba(16, 185, 129, 0.9), rgba(5, 150, 105, 0.9))';
  banner.style.display = 'block';
}

document.addEventListener('DOMContentLoaded', () => {
  initD3();
  loadOps().then(() => { if (!state.op_id) { const f = document.querySelector('.task-card'); if (f) selectOp(f.dataset.op); } else selectOp(state.op_id, false); });
  setInterval(checkPendingIntervention, 2000);
});

async function loadOps() {
  try {
    const data = await fetch('/api/ops').then(r => r.json());
    const list = document.getElementById('ops'); list.innerHTML = '';
    data.items.forEach(i => {
      const li = document.createElement('li'); li.className = `task-card ${i.op_id === state.op_id ? 'active' : ''}`; li.dataset.op = i.op_id; li.onclick = () => selectOp(i.op_id, false);

      let color = 'var(--accent-primary)'; // Default: in progress / pending
      if (i.status.achieved) color = 'var(--success)';
      else if (i.status.failed) color = 'var(--error)';
      else if (i.status.aborted) color = '#94a3b8'; // Grey for aborted

      // 显示名称：优先使用task_id（name字段），否则使用goal的前30字符
      const displayName = i.task_id || (i.goal ? i.goal.slice(0, 30) + (i.goal.length > 30 ? '...' : '') : 'Unnamed');

      li.innerHTML = `<div class="flex justify-between mb-1">
          <span style="font-family:monospace;font-size:10px;opacity:0.7">#${i.op_id.slice(-4)}</span>
          <div style="display:flex;gap:8px;align-items:center;">
              <span class="status-dot" style="background:${color}" title="${i.status.raw}"></span>
              <span class="rename-btn" onclick="renameOp(event, '${i.op_id}', this)" title="Rename">✏️</span>
              <span class="delete-btn" onclick="deleteOp(event, '${i.op_id}')" title="Delete Task">✕</span>
          </div>
      </div>
      <div class="task-name" data-op="${i.op_id}" style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(i.goal)}">${escapeHtml(displayName)}</div>`;
      list.appendChild(li);
    });
    initOpsDragAndDrop();
  } catch (e) { }
}

function initOpsDragAndDrop() {
  const list = document.getElementById('ops');
  if (!list) return;

  const items = Array.from(list.querySelectorAll('.task-card'));
  items.forEach(item => {
    item.setAttribute('draggable', 'true');
    item.addEventListener('dragstart', handleTaskDragStart);
    item.addEventListener('dragend', handleTaskDragEnd);
  });

  if (!list._opsDragBound) {
    list.addEventListener('dragover', handleTaskDragOver);
    list._opsDragBound = true;
  }
}

function handleTaskDragStart(e) {
  const target = e.currentTarget;
  if (target && target.classList) {
    target.classList.add('dragging');
  }
}

function handleTaskDragEnd(e) {
  const target = e.currentTarget;
  if (target && target.classList) {
    target.classList.remove('dragging');
  }

  const list = document.getElementById('ops');
  if (!list) return;

  const order = Array.from(list.querySelectorAll('.task-card')).map(item => item.dataset.op);
  saveOpsOrder(order);
}

function handleTaskDragOver(e) {
  e.preventDefault();
  const list = e.currentTarget;
  const dragging = list.querySelector('.task-card.dragging');
  if (!dragging) return;

  const afterElement = getDragAfterElement(list, e.clientY);
  if (!afterElement) {
    list.appendChild(dragging);
  } else if (afterElement !== dragging) {
    list.insertBefore(dragging, afterElement);
  }
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.task-card:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };

  draggableElements.forEach(child => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: child };
    }
  });

  return closest.element;
}

async function saveOpsOrder(order) {
  try {
    await api('/api/ops/reorder', { order });
  } catch (e) {
    console.error('Failed to save task order', e);
  }
}

async function deleteOp(e, id) {
  e.stopPropagation();
  
  const isZh = (window.currentLang || 'zh') === 'zh';
  const ok = await showConfirmModal({
    title: isZh ? '删除任务' : 'Delete Task',
    message: isZh
      ? '确定要删除这个任务吗？此操作不可恢复。'
      : 'Are you sure you want to delete this task? This action cannot be undone.',
    confirmText: isZh ? '删除' : 'Delete',
    cancelText: isZh ? '取消' : 'Cancel',
    danger: true
  });
  if (!ok) return;
  
  await fetch(`/api/ops/${id}`, { method: 'DELETE' });
  if (state.op_id === id) {
    state.op_id = '';
    history.replaceState(null, '', location.pathname);
    document.getElementById('llm-stream').innerHTML = '';
    if (state.g) state.g.selectAll("*").remove();
    if (state.es) state.es.close();
  }
  loadOps();
}

// 重命名任务
async function renameOp(e, opId, btn) {
  e.stopPropagation();

  const taskCard = btn.closest('.task-card');
  const nameEl = taskCard.querySelector('.task-name');
  if (!nameEl) return;

  const currentName = nameEl.textContent;

  // 创建输入框替换文本
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentName;
  input.className = 'rename-input';
  input.style.cssText = 'width:100%;background:var(--bg-input);border:1px solid var(--accent-primary);border-radius:4px;padding:4px;color:var(--text-main);font-size:13px;';

  nameEl.innerHTML = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();

  // 保存函数
  const saveRename = async () => {
    const newName = input.value.trim();
    if (newName && newName !== currentName) {
      try {
        const r = await fetch(`/api/ops/${opId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName })
        }).then(res => res.json());

        if (r.ok) {
          nameEl.textContent = newName;
        } else {
          nameEl.textContent = currentName;
        }
      } catch (err) {
        nameEl.textContent = currentName;
      }
    } else {
      nameEl.textContent = currentName;
    }
  };

  // 回车保存
  input.onkeydown = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      input.blur();
    } else if (ev.key === 'Escape') {
      nameEl.textContent = currentName;
    }
  };

  // 失焦保存
  input.onblur = saveRename;
}

function selectOp(id, refresh = true) {
  if (!id) return; state.op_id = id;
  document.querySelectorAll('.task-card').forEach(el => el.classList.toggle('active', el.dataset.op === id));
  history.replaceState(null, '', `?op_id=${id}`);
  document.getElementById('llm-stream').innerHTML = '';
  state.processedEvents.clear(); // [Fix] Clear processed events history so they can be re-rendered
  state.missionAccomplished = false; // [Fix] Reset mission status when switching tasks
  state.collapsedNodes.clear(); // 重置折叠节点
  state.userExpandedNodes.clear(); // 重置用户展开节点
  state.userHasInteracted = false; // 切换任务时重置用户交互标志，允许自动聚焦
  state.lastActiveNodeId = null; // 重置上次活跃节点
  state.lastRenderTime = 0; // 重置渲染时间，允许立即渲染
  state.currentPhase = null; // 重置阶段状态
  // 清除占位节点（切换任务时）
  if (state.placeholderRootNode && state.placeholderRootNode.id !== id) {
    state.placeholderRootNode = null;
  }
  hidePhaseBanner(); // 隐藏阶段横幅，等待正确状态加载
  document.getElementById('node-detail-content').innerHTML = '<div style="padding:20px;text-align:center;color:#64748b">Loading...</div>';
  closeDetails();
  if (state.es) state.es.close(); subscribe(); render(true); if (refresh) loadOps();
}

async function render(force) {
  if (!state.op_id) return;

  // 记录当前渲染的任务ID，用于检测竞争条件
  const renderingOpId = state.op_id;

  // 防抖：如果上次渲染时间距现在不足 300ms 且非强制刷新，则跳过
  const now = Date.now();
  if (!force && state.missionAccomplished && (now - state.lastRenderTime) < 500) {
    console.log('Skipping render: task completed, debounce active');
    return;
  }

  // 清除已有的防抖定时器
  if (state.renderDebounceTimer) {
    clearTimeout(state.renderDebounceTimer);
    state.renderDebounceTimer = null;
  }

  state.lastRenderTime = now;

  try {
    let data;
    if (state.view === 'exec') data = await api('/api/graph/execution');
    else if (state.view === 'causal') data = await api('/api/graph/causal');

    // 检查竞争条件：如果在 API 调用期间用户切换了任务，则放弃本次渲染
    if (state.op_id !== renderingOpId) {
      console.log('Skipping render: task switched during API call', renderingOpId, '->', state.op_id);
      return;
    }

    drawForceGraph(data);
    updateLegend();
    
    // 检测规划完成：如果有子任务且当前处于 planning 阶段，切换为 executing
    if (state.currentPhase === 'planning' && data && data.nodes) {
      const hasSubTasks = data.nodes.some(n => n.type === 'task' && n.id !== state.op_id);
      if (hasSubTasks) {
        showPhaseBanner('executing');
        console.log('Planning completed, detected subtasks, switching to executing phase');
      }
    }
  } catch (e) { console.error(e); }
}

function switchView(v) { state.view = v; document.querySelectorAll('#topbar .btn[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v)); render(); }

function initD3() {
  const c = document.getElementById('main');
  state.svg = d3.select('#d3-graph').attr('viewBox', [0, 0, c.clientWidth, c.clientHeight]);
  state.g = state.svg.append('g');
  // 创建 zoom 行为，并区分用户交互与程序化缩放
  state.zoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', e => {
    state.g.attr('transform', e.transform);
    // 检测是否为用户主动交互（非程序化触发）
    // sourceEvent 存在表示是用户操作（鼠标/触摸/滚轮）
    if (e.sourceEvent && !state.isProgrammaticZoom) {
      state.userHasInteracted = true;
      updateTrackButton();
      console.log('User interaction detected, auto-focus disabled');
    }
  });
  state.svg.call(state.zoom);
  // 定义箭头 marker - refX=0 使箭头紧贴路径末端
  state.svg.append("defs").append("marker")
    .attr("id", "arrow")
    .attr("viewBox", "0 -4 8 8")
    .attr("refX", 8)  // 箭头尖端位于路径末端
    .attr("refY", 0)
    .attr("markerWidth", 5)
    .attr("markerHeight", 5)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-4L8,0L0,4")
    .attr("fill", "#64748b");
}

function drawForceGraph(data) {
  const svg = state.svg;
  state.g.selectAll("*").remove(); // 清除旧图

  const g = state.g;

  if (!data || !data.nodes || data.nodes.length === 0) {
    // 如果有占位节点，渲染它
    if (state.placeholderRootNode && state.placeholderRootNode.id === state.op_id) {
      console.log('Rendering placeholder root node');
      data = {
        nodes: [state.placeholderRootNode],
        edges: []
      };
      // 继续往下渲染
    } else {
      console.log('Skipping render: no data or empty nodes');
      return;
    }
  } else if (data.nodes.length > 0 && !data.nodes[0].placeholder) {
    // 真实数据到达，清除占位节点
    if (state.placeholderRootNode) {
      console.log('Real data arrived, clearing placeholder node');
      state.placeholderRootNode = null;
    }
  }

  // --- [新增] 节点去重与状态清洗逻辑 ---
  const uniqueNodesMap = new Map();
  const terminalStates = new Set(['completed', 'failed', 'aborted', 'deprecated', 'stalled_orphan', 'completed_error']);

  data.nodes.forEach(node => {
    const existing = uniqueNodesMap.get(node.id);
    if (!existing) {
      uniqueNodesMap.set(node.id, node);
    } else {
      // 如果已存在节点是终态，保留它
      if (terminalStates.has(existing.status)) return;
      // 如果新节点是终态，替换旧节点
      if (terminalStates.has(node.status)) {
        uniqueNodesMap.set(node.id, node);
        return;
      }
      // 都是非终态，优先保留 'in_progress'
      if (node.status === 'in_progress' || node.status === 'running') {
        uniqueNodesMap.set(node.id, node);
      }
    }
  });
  // 使用去重后的节点列表覆盖原始数据
  data.nodes = Array.from(uniqueNodesMap.values());
  // -------------------------------------

  // --- [智能自动折叠] 当横向宽度过大时自动折叠非关键任务 ---
  if (state.view === 'exec') {
    const parentToTasks = new Map();
    const taskById = new Map();

    // 找出所有 task 节点及其父节点关系
    if (data.edges) {
      const nodeTypes = new Map(data.nodes.map(n => [n.id, n.type]));
      data.edges.forEach(edge => {
        if (nodeTypes.get(edge.target) === 'task') {
          if (!parentToTasks.has(edge.source)) parentToTasks.set(edge.source, []);
          parentToTasks.get(edge.source).push(edge.target);
        }
      });
    }
    data.nodes.forEach(n => { if (n.type === 'task') taskById.set(n.id, n); });

    // 对每个父节点下的子任务进行分析
    parentToTasks.forEach((childrenIds, parentId) => {
      const children = childrenIds.map(id => taskById.get(id)).filter(Boolean);

      // 如果并行的子任务超过 2 个，启动自动折叠
      if (children.length > 2) {
        // 找出需要保留（不自动折叠）的节点
        const preserved = new Set();

        // 1. 保留成功路径节点
        const goalNode = children.find(c => c.is_goal_achieved);
        if (goalNode) preserved.add(goalNode.id);

        // 2. 保留正在运行的节点
        children.forEach(c => {
          if (c.status === 'in_progress' || c.status === 'running') preserved.add(c.id);
        });

        // 3. 保留用户手动展开的节点
        children.forEach(c => {
          if (state.userExpandedNodes.has(c.id)) preserved.add(c.id);
        });

        // 4. 保留最近完成的一个节点（如果没有 preserved 活跃节点）
        const completed = children.filter(c => c.status === 'completed' && !preserved.has(c.id))
          .sort((a, b) => (b.completed_at || 0) - (a.completed_at || 0));

        if (preserved.size === 0 && completed.length > 0) {
          preserved.add(completed[0].id);
        }

        // 自动折叠非保留节点
        children.forEach(c => {
          if (!preserved.has(c.id) && (c.status === 'completed' || c.status === 'failed')) {
            // 只有当用户没有手动展开它时，才自动将其加入折叠集
            if (!state.userExpandedNodes.has(c.id)) {
              state.collapsedNodes.add(c.id);
            }
          }
        });
      }
    });
  }
  // -------------------------------------

  // --- [折叠功能] 过滤掉被折叠子任务下的执行步骤 ---
  if (state.view === 'exec' && state.collapsedNodes.size > 0) {
    const nodeTypes = new Map(data.nodes.map(n => [n.id, n.type]));
    const parentMap = new Map(); // action_id -> direct_task_id

    // 构建邻接表用于遍历执行链
    const actionChainGraph = new Map(); // node_id -> Set(child_node_ids)
    data.nodes.forEach(n => actionChainGraph.set(n.id, new Set()));
    if (data.edges) {
      data.edges.forEach(edge => {
        const edgeType = edge.type || edge.relation_type;
        // 只处理 execution 类型的边（用于执行链遍历）
        if (edgeType === 'execution') {
          if (actionChainGraph.has(edge.source)) {
            actionChainGraph.get(edge.source).add(edge.target);
          }
        }
        // 同时记录直接父子关系（task/root -> action）
        const sourceType = nodeTypes.get(edge.source);
        const targetType = nodeTypes.get(edge.target);
        if ((sourceType === 'task' || sourceType === 'root') && targetType === 'action' && edgeType === 'execution') {
          parentMap.set(edge.target, edge.source);
        }
      });
    }

    // 递归收集执行链中的所有 action 节点
    function collectExecutionChain(startNodeId, visited = new Set()) {
      const result = new Set();
      const toVisit = [startNodeId];

      while (toVisit.length > 0) {
        const nodeId = toVisit.pop();
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);

        const nodeType = nodeTypes.get(nodeId);
        // 如果是 action 节点，添加到结果中
        if (nodeType === 'action') {
          result.add(nodeId);
        }

        // 遍历子节点（沿着 execution 边）
        const children = actionChainGraph.get(nodeId);
        if (children) {
          children.forEach(childId => {
            if (!visited.has(childId)) {
              toVisit.push(childId);
            }
          });
        }
      }
      return result;
    }

    // 计算每个折叠节点需要隐藏的所有 action（包括执行链中的）
    const actionsToHide = new Set();
    const collapsedChildCounts = new Map();
    const chainVisited = new Set();

    state.collapsedNodes.forEach(collapsedId => {
      const actions = collectExecutionChain(collapsedId, chainVisited);
      collapsedChildCounts.set(collapsedId, actions.size);
      actions.forEach(actionId => actionsToHide.add(actionId));
    });

    // 调试日志
    if (state.collapsedNodes.size > 0) {
      console.log('[Collapse] Collapsed nodes:', Array.from(state.collapsedNodes));
      console.log('[Collapse] Actions to hide:', actionsToHide.size, Array.from(actionsToHide).slice(0, 10));
    }

    // 过滤节点：隐藏被折叠节点下的所有 action（包括执行链中的）
    const beforeFilterCount = data.nodes.length;
    data.nodes = data.nodes.filter(node => {
      return !actionsToHide.has(node.id);
    });
    const afterFilterCount = data.nodes.length;
    if (state.collapsedNodes.size > 0 && beforeFilterCount !== afterFilterCount) {
      console.log('[Collapse] Filtered', beforeFilterCount - afterFilterCount, 'action nodes');
    }

    // 将隐藏数量存储到节点数据中，供渲染时使用
    data.nodes.forEach(node => {
      if (collapsedChildCounts.has(node.id)) {
        node._collapsedChildCount = collapsedChildCounts.get(node.id);
      }
    });

    // 过滤边：移除涉及被过滤节点的边
    if (data.edges) {
      const remainingNodeIds = new Set(data.nodes.map(n => n.id));
      data.edges = data.edges.filter(edge =>
        remainingNodeIds.has(edge.source) && remainingNodeIds.has(edge.target)
      );
    }
  }
  // -------------------------------------

  // 1. 数据转换与 Dagre 图构建
  const dagreGraph = new dagre.graphlib.Graph();

  // 根据视图类型使用不同的布局配置
  if (state.view === 'causal') {
    // 因果图：使用从上到下的紧凑布局
    const nodeCount = data.nodes ? data.nodes.length : 0;

    // 如果节点数量很多，使用更紧凑的参数
    const nodesep = nodeCount > 20 ? 30 : 40;
    const ranksep = nodeCount > 20 ? 50 : 60;

    dagreGraph.setGraph({
      rankdir: 'TB',  // Top-to-Bottom 布局
      align: 'DL',    // 下左对齐，减少横向扩展
      nodesep: nodesep,    // 同层节点间距（动态调整）
      ranksep: ranksep,    // 层级间距（动态调整）
      marginx: 20,
      marginy: 20,
      ranker: 'tight-tree'  // 使用紧凑树算法，减少宽度
    });
  } else {
    // 执行图：使用标准树形布局
    dagreGraph.setGraph({
      rankdir: 'TB',  // Top-to-Bottom 布局 (更像攻击图/树)
      align: undefined,    // 不设置对齐方式，让算法自动平衡
      nodesep: 40,    // 同层节点水平间距
      ranksep: 50,    // 层级间垂直间距
      marginx: 40,
      marginy: 40,
      ranker: 'network-simplex'  // 使用网络单纯形算法，更好地平衡布局
    });
  }

  // 添加节点 (根据节点类型设置不同尺寸)
  if (!data || !data.nodes || data.nodes.length === 0) {
    console.log('No nodes to render, skipping layout');
    return;
  }

  // 调试：打印因果图节点类型
  if (state.view === 'causal' && data.nodes.length > 0) {
    console.log('Causal graph nodes:', data.nodes.map(n => ({
      id: n.id,
      type: n.type,
      node_type: n.node_type
    })));
  }

  data.nodes.forEach(node => {
    // 根据视图类型和节点类型设置不同的宽度
    let width, height;

    if (state.view === 'causal') {
      // 因果图节点：更紧凑的尺寸
      const nodeType = node.node_type || node.type;
      if (nodeType === 'KeyFact' || nodeType === 'Evidence') {
        width = 140;   // 关键事实和证据
        height = 50;
      } else if (nodeType === 'Hypothesis') {
        width = 130;   // 假设
        height = 50;
      } else if (nodeType === 'Vulnerability' || nodeType === 'ConfirmedVulnerability') {
        width = 150;   // 漏洞节点稍宽
        height = 50;
      } else if (nodeType === 'Flag') {
        width = 100;   // Flag 最窄
        height = 45;
      } else {
        width = 140;   // 默认因果图节点
        height = 50;
      }
    } else {
      // 执行图节点：原有尺寸
      if (node.type === 'root') {
        width = 200;   // 主任务：最宽
        height = 60;
      } else if (node.type === 'task') {
        width = 180;   // 子任务：标准宽度
        height = 60;
      } else if (node.type === 'action') {
        width = 120;   // 动作节点：较窄
        height = 40;   // 更矮一些，让执行步骤更紧凑
      } else {
        width = 160;   // 其他类型：中等宽度
        height = 55;
      }
    }

    dagreGraph.setNode(node.id, {
      label: node.label || node.id,
      width: width,
      height: height,
      ...node // 传递原始数据
    });
  });

  // 添加边
  if (data.edges) {
    data.edges.forEach(link => {
      dagreGraph.setEdge(link.source, link.target, {
        ...link // 传递原始数据
      });
    });
  }

  // 2. 执行布局计算 (确定性坐标)
  dagre.layout(dagreGraph);

  // 修复孤立节点的 NaN 坐标（防止跳动闪烁）
  dagreGraph.nodes().forEach(nodeId => {
    const node = dagreGraph.node(nodeId);
    if (isNaN(node.x) || isNaN(node.y)) {
      // 将孤立节点放在布局空间的顶部中心（考虑 margin）
      const graphConfig = dagreGraph.graph();
      const marginx = graphConfig.marginx || 40;
      const marginy = graphConfig.marginy || 40;
      // 默认将单节点放在距离顶部 150px 的位置（较靠上）
      node.x = 400;  // 水平居中
      node.y = 150;  // 靠近顶部
      console.warn(`Fixed NaN coordinates for isolated node ${nodeId}, set to (${node.x}, ${node.y})`);
    }
  });

  // 3. 绘制连线 (使用贝塞尔曲线)
  // 生成曲线路径生成器
  const lineGen = d3.line()
    .x(d => d.x)
    .y(d => d.y)
    .curve(d3.curveBasis); // 使用 Basis 样条插值实现平滑曲线

  const links = g.selectAll(".link")
    .data(dagreGraph.edges())
    .enter().append("path")
    .attr("class", d => {
      const edgeData = dagreGraph.edge(d);
      // 如果目标节点正在运行，则连线也设为 active
      const targetNode = data.nodes.find(n => n.id === d.w);
      return `link ${targetNode && targetNode.status === 'running' ? 'active' : ''}`;
    })
    .attr("d", d => {
      const points = dagreGraph.edge(d).points;
      return lineGen(points);
    })
    .attr("marker-end", "url(#arrow)");

  // 4. 绘制节点 (圆角矩形)
  const nodes = g.selectAll(".node")
    .data(dagreGraph.nodes())
    .enter().append("g")
    .attr("class", d => {
      const nodeData = dagreGraph.node(d);
      return `node status-${nodeData.status || 'pending'} type-${nodeData.type || 'unknown'}`;
    })
    .attr("transform", d => {
      const node = dagreGraph.node(d);
      return `translate(${node.x},${node.y})`;
    })
    .on("click", (e, d) => showDetails(dagreGraph.node(d)));

  // 节点背景 - 使用动态宽度和高度
  nodes.append("rect")
    .attr("width", d => dagreGraph.node(d).width)
    .attr("height", d => dagreGraph.node(d).height)
    .attr("x", d => -dagreGraph.node(d).width / 2)
    .attr("y", d => -dagreGraph.node(d).height / 2)
    .attr("rx", d => {
      const n = dagreGraph.node(d);
      return n.type === 'action' ? 6 : 8;  // 动作节点圆角稍小
    })
    .attr("ry", d => {
      const n = dagreGraph.node(d);
      return n.type === 'action' ? 6 : 8;
    })
    .style("fill", d => {
      const n = dagreGraph.node(d);
      // 区分 Task 和 Action 的背景色
      if (n.type === 'task') return '#1e293b'; // Darker for tasks
      if (n.type === 'action' || n.type === 'tool_use') return '#0f172a'; // Even darker for actions
      return '#1e293b';
    })
    .style("stroke", d => {
      const n = dagreGraph.node(d);

      // 因果图：使用 node_type 来确定颜色
      if (state.view === 'causal') {
        const nodeType = n.node_type || n.type;
        return causalColors[nodeType] || '#64748b';
      }

      // 执行图：使用状态和类型来确定颜色
      if (n.status === 'failed') return '#ef4444';
      if (n.status === 'completed') return '#10b981';
      if (n.status === 'running' || n.status === 'in_progress') return '#3b82f6';

      if (n.type === 'root') return '#3b82f6'; // Blue for root task
      if (n.type === 'task') return '#8b5cf6'; // Purple for tasks
      if (n.type === 'action' || n.type === 'tool_use') return '#f59e0b'; // Orange for actions
      return '#475569';
    })
    .style("stroke-width", d => {
      const n = dagreGraph.node(d);
      return (n.status === 'running' || n.status === 'in_progress') ? 2 : 1.5;
    });

  // 节点类型标签 (左上角小标签) - 增强可见性
  nodes.append("rect")
    .attr("width", d => {
      const n = dagreGraph.node(d);
      if (n.type === 'root') return 58;
      if (n.type === 'action') return 45;  // 动作节点标签更窄
      return 50;
    })
    .attr("height", 18)
    .attr("x", d => {
      const n = dagreGraph.node(d);
      return -n.width / 2;  // 使用动态宽度
    })
    .attr("y", d => {
      const n = dagreGraph.node(d);
      return -n.height / 2 - 9;  // 使用动态高度
    })
    .attr("rx", 4)
    .attr("ry", 4)
    .style("fill", d => {
      const n = dagreGraph.node(d);

      // 因果图：使用 causal 颜色
      if (state.view === 'causal') {
        const nodeType = n.node_type || n.type;
        return causalColors[nodeType] || '#64748b';
      }

      // 执行图：使用任务类型颜色
      if (n.type === 'root') return '#3b82f6';  // 蓝色 - 主任务
      if (n.type === 'task') return '#8b5cf6';  // 紫色 - 子任务
      if (n.type === 'action') return '#f59e0b';  // 橙色 - 动作节点
      return '#64748b';
    })
    .style("stroke", "#fff")
    .style("stroke-width", "1px");

  nodes.append("text")
    .attr("x", d => {
      const n = dagreGraph.node(d);
      // 计算标签中心位置
      const labelWidth = n.type === 'root' ? 58 : (n.type === 'action' ? 45 : 50);
      return -n.width / 2 + labelWidth / 2;
    })
    .attr("y", d => {
      const n = dagreGraph.node(d);
      return -n.height / 2 + 3;
    })
    .attr("text-anchor", "middle")
    .attr("fill", "#fff")
    .style("font-size", "10px")
    .style("font-weight", "bold")
    .text(d => {
      const n = dagreGraph.node(d);

      // 因果图：显示 node_type
      if (state.view === 'causal') {
        const nodeType = n.node_type || n.type;
        // 节点类型翻译映射
        const typeLabels = {
          'KeyFact': currentLang === 'zh' ? '关键事实' : 'Key Fact',
          'Evidence': currentLang === 'zh' ? '证据' : 'Evidence',
          'Hypothesis': currentLang === 'zh' ? '假设' : 'Hypothesis',
          'Vulnerability': currentLang === 'zh' ? '漏洞' : 'Vuln',
          'ConfirmedVulnerability': currentLang === 'zh' ? '确认漏洞' : 'Confirmed',
          'Flag': 'Flag'
        };
        return typeLabels[nodeType] || nodeType || 'UNKNOWN';
      }

      // 执行图：显示任务类型
      if (n.type === 'root') return currentLang === 'zh' ? '主任务' : 'Root';
      if (n.type === 'task') return currentLang === 'zh' ? '子任务' : 'Task';
      if (n.type === 'action') return currentLang === 'zh' ? '动作' : 'Action';
      return 'NODE';
    });

  // 节点文字 (使用节点名称/描述)
  nodes.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.3em")
    .attr("fill", "#fff")
    .style("font-weight", "bold")
    .style("font-size", "11px")
    .each(function (d) {
      const n = dagreGraph.node(d);
      let label = n.label || n.id;

      // 如果是动作节点，提取真正的动作名称
      if (n.type === 'action' && label.includes('_')) {
        // 格式通常为: <subtask>_step_<action> 或 <subtask>_<action>
        // 例如: basic_app_recon_step_homepage -> homepage
        //       initial_reconnaissance_step_1a -> step_1a

        // 先尝试匹配 _step_ 模式
        const stepMatch = label.match(/_step_(.+)$/);
        if (stepMatch) {
          label = stepMatch[1];  // 取 step_ 后面的部分
        } else {
          // 如果没有 _step_，则取最后一个下划线后的部分
          const parts = label.split('_');
          if (parts.length >= 2) {
            label = parts[parts.length - 1];  // 只取最后一个部分
          }
        }
      }

      // 智能截断：考虑中英文字符宽度
      const textElement = d3.select(this);
      textElement.text(label);

      // 根据节点宽度动态设置最大文本宽度
      const nodeWidth = n.width;
      const maxWidth = nodeWidth - 20;  // 留出左右边距
      let currentText = label;

      while (textElement.node().getComputedTextLength() > maxWidth && currentText.length > 3) {
        currentText = currentText.substring(0, currentText.length - 1);
        textElement.text(currentText + '...');
      }
    });

  // 节点副标题 (例如耗时或工具名)
  nodes.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "1.8em")
    .attr("fill", "#94a3b8")
    .style("font-size", "9px")
    .text(d => {
      const n = dagreGraph.node(d);
      if (n.tool_name) return `Tool: ${n.tool_name}`;
      return n.status || "";
    });

  // 5. 交互：聚焦模式 (Focus Mode)
  nodes.on("mouseenter", function (event, d) {
    const nodeId = d;
    // 找出前驱和后继
    const predecessors = dagreGraph.predecessors(nodeId);
    const successors = dagreGraph.successors(nodeId);
    const neighbors = new Set([nodeId, ...predecessors, ...successors]);

    // 变暗所有非相关节点
    nodes.classed("dimmed", n => !neighbors.has(n));

    // 变暗所有非相关连线
    links.classed("dimmed", l => !neighbors.has(l.v) || !neighbors.has(l.w));

    tippy(this, { content: `<b>${dagreGraph.node(d).type}</b><br>${dagreGraph.node(d).label || d}`, allowHTML: true });
  }).on("mouseleave", function () {
    // 恢复原状
    nodes.classed("dimmed", false);
    links.classed("dimmed", false);
  });

  // [折叠功能] 双击子任务节点切换折叠状态
  nodes.on("dblclick", function (event, d) {
    event.stopPropagation();
    const n = dagreGraph.node(d);

    // 只有 task/root 类型的节点可以折叠
    if (n.type !== 'task' && n.type !== 'root') return;

    // 切换折叠状态
    if (state.collapsedNodes.has(d)) {
      state.collapsedNodes.delete(d);
      state.userExpandedNodes.add(d); // 记录用户主动展开
      console.log('Expanded subtask (manual):', d);
    } else {
      state.collapsedNodes.add(d);
      state.userExpandedNodes.delete(d); // 如果收起，移除主动展开标记
      console.log('Collapsed subtask (manual):', d);
    }

    // 重新渲染
    render(true);
  });

  // [折叠功能] 折叠按钮和状态指示器
  const taskNodes = nodes.filter(d => {
    const n = dagreGraph.node(d);
    return n.type === 'task' || n.type === 'root';
  });

  // 1. 折叠状态徽章 (Pill Badge) - 仅在折叠时显示
  const badgeGroup = taskNodes.filter(d => state.collapsedNodes.has(d))
    .append("g")
    .attr("transform", d => {
      const n = dagreGraph.node(d);
      return `translate(0, ${n.height / 2 + 12})`; // 位于节点下方
    });

  badgeGroup.append("rect")
    .attr("x", -30)
    .attr("y", -10)
    .attr("width", 60)
    .attr("height", 20)
    .attr("rx", 10)
    .attr("ry", 10)
    .attr("fill", "#e2e8f0")
    .attr("stroke", "#cbd5e1")
    .attr("stroke-width", 1);

  badgeGroup.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", 4)
    .attr("fill", "#64748b")
    .style("font-size", "11px")
    .style("font-weight", "500")
    .text(d => {
      const n = dagreGraph.node(d);
      const count = n._collapsedChildCount || 0;
      return `${count} steps`;
    });

  // 2. 折叠切换按钮 (底部圆形按钮)
  const toggleBtn = taskNodes.append("g")
    .attr("class", "toggle-btn")
    .attr("transform", d => {
      const n = dagreGraph.node(d);
      // 如果已折叠，按钮位于徽章下方；否则紧贴节点底部
      const offset = state.collapsedNodes.has(d) ? (n.height / 2 + 35) : (n.height / 2);
      return `translate(0, ${offset})`;
    })
    .style("cursor", "pointer")
    .on("click", function (event, d) {
      event.stopPropagation();
      // 切换状态
      if (state.collapsedNodes.has(d)) {
        state.collapsedNodes.delete(d);
        state.userExpandedNodes.add(d); // 记录用户主动展开
      } else {
        state.collapsedNodes.add(d);
        state.userExpandedNodes.delete(d); // 移除主动展开标记
      }
      render(true);
    });

  // 按钮背景圆
  toggleBtn.append("circle")
    .attr("r", 8)
    .attr("fill", "#fff")
    .attr("stroke", "#94a3b8")
    .attr("stroke-width", 1.5)
    .on("mouseenter", function () {
      d3.select(this).attr("stroke", "#3b82f6").attr("fill", "#eff6ff");
      d3.select(this.parentNode).select("path").attr("stroke", "#3b82f6");
    })
    .on("mouseleave", function () {
      d3.select(this).attr("stroke", "#94a3b8").attr("fill", "#fff");
      d3.select(this.parentNode).select("path").attr("stroke", "#64748b");
    });

  // 按钮图标 (Chevron)
  toggleBtn.append("path")
    .attr("d", d => state.collapsedNodes.has(d)
      ? "M-3.5,-1.5 L0,2 L3.5,-1.5" // 向下箭头 (展开意图)
      : "M-3.5,1.5 L0,-2 L3.5,1.5"  // 向上箭头 (折叠意图)
    )
    .attr("fill", "none")
    .attr("stroke", "#64748b")
    .attr("stroke-width", 1.5)
    .attr("stroke-linecap", "round")
    .attr("stroke-linejoin", "round")
    .style("pointer-events", "none"); // 让点击穿透到 circle


  // 自适应缩放和居中
  const graphWidth = dagreGraph.graph().width;
  const graphHeight = dagreGraph.graph().height;
  const svgWidth = state.svg.node().clientWidth || 800;
  const svgHeight = state.svg.node().clientHeight || 600;

  // 查找正在执行的节点（优先 action，其次 task，排除 root）
  const activeNodes = data.nodes.filter(n => n.status === 'in_progress' || n.status === 'running');
  // 按类型优先级排序：action > task > root
  const typePriority = { 'action': 0, 'task': 1, 'root': 2 };
  activeNodes.sort((a, b) => (typePriority[a.type] ?? 1) - (typePriority[b.type] ?? 1));
  const activeNode = activeNodes.length > 0 ? activeNodes[0] : null;
  const activeNodeId = activeNode ? activeNode.id : null;

  // 判断是否需要自动聚焦：
  // 1. 用户没有手动交互过视图
  // 2. 或者活跃节点发生了变化（新的任务开始）
  const shouldAutoFocus = !state.userHasInteracted ||
    (activeNodeId && activeNodeId !== state.lastActiveNodeId);

  // 更新上次活跃节点 ID
  if (activeNodeId) {
    state.lastActiveNodeId = activeNodeId;
  }

  if (shouldAutoFocus) {
    let targetX, targetY, targetScale;
    let focusNode = null;

    if (activeNode && activeNode.type !== 'root') {
      // 优先聚焦到正在执行的节点（排除 root）
      focusNode = dagreGraph.node(activeNode.id);
      if (focusNode) {
        console.log('Auto-focusing on active node:', activeNode.id, 'type:', activeNode.type);
      }
    }

    // 如果没有活跃节点，根据视图类型选择不同的聚焦策略
    if (!focusNode) {
      if (state.view === 'causal') {
        // 因果图：按类型优先级聚焦（Flag > ConfirmedVulnerability > Vulnerability > 其他）
        const causalPriority = { 'Flag': 0, 'ConfirmedVulnerability': 1, 'Vulnerability': 2, 'Hypothesis': 3, 'Evidence': 4, 'KeyFact': 5 };
        const sortedNodes = [...data.nodes].sort((a, b) => {
          const typeA = a.node_type || a.type;
          const typeB = b.node_type || b.type;
          const priorityA = causalPriority[typeA] ?? 10;
          const priorityB = causalPriority[typeB] ?? 10;
          // 优先级相同时，按 created_at 降序（最新的优先）
          if (priorityA === priorityB) {
            return (b.created_at || 0) - (a.created_at || 0);
          }
          return priorityA - priorityB;
        });

        if (sortedNodes.length > 0) {
          focusNode = dagreGraph.node(sortedNodes[0].id);
          console.log('Causal graph: focusing on node:', sortedNodes[0].id, 'type:', sortedNodes[0].node_type || sortedNodes[0].type);
        }
      } else {
        // 执行图：原有逻辑
        // 优先找 in_progress 的 task
        const inProgressTasks = data.nodes.filter(n => n.type === 'task' && (n.status === 'in_progress' || n.status === 'running'));
        if (inProgressTasks.length > 0) {
          focusNode = dagreGraph.node(inProgressTasks[0].id);
          console.log('Auto-focusing on in_progress task:', inProgressTasks[0].id);
        } else {
          // 找最新完成的 action 或 task
          const completedActions = data.nodes.filter(n => n.type === 'action' && n.status === 'completed' && n.completed_at);
          if (completedActions.length > 0) {
            completedActions.sort((a, b) => (b.completed_at || 0) - (a.completed_at || 0));
            focusNode = dagreGraph.node(completedActions[0].id);
            console.log('Auto-focusing on latest completed action:', completedActions[0].id);
          } else {
            // 找最新的 pending task
            const pendingTasks = data.nodes.filter(n => n.type === 'task' && n.status === 'pending');
            if (pendingTasks.length > 0) {
              focusNode = dagreGraph.node(pendingTasks[pendingTasks.length - 1].id);
              console.log('Auto-focusing on pending task:', pendingTasks[pendingTasks.length - 1].id);
            }
          }
        }
      }
    }

    if (focusNode) {
      // 使用与成功路径相同的缩放比例（1.1倍）
      targetScale = 0.75;
      targetX = svgWidth / 2 - focusNode.x * targetScale;
      targetY = svgHeight / 2 - focusNode.y * targetScale;
    } else {
      // 没有找到焦点节点，显示整体视图
      const scaleX = (svgWidth * 0.9) / graphWidth;
      const scaleY = (svgHeight * 0.9) / graphHeight;
      targetScale = Math.min(scaleX, scaleY, 1);
      targetX = (svgWidth - graphWidth * targetScale) / 2;
      targetY = (svgHeight - graphHeight * targetScale) / 2;
    }

    // 设置程序化缩放标志，避免被误判为用户交互
    state.isProgrammaticZoom = true;

    // 根据节点数量调整过渡动画时间：节点少时动画更快，避免卡顿感
    const animDuration = data.nodes.length <= 3 ? 100 : 250;

    // 使用平滑动画应用变换
    state.svg.transition()
      .duration(animDuration)
      .call(state.zoom.transform, d3.zoomIdentity
        .translate(targetX, targetY)
        .scale(targetScale))
      .on('end', () => {
        state.isProgrammaticZoom = false;
      });
  } else {
    console.log('Skipping auto-focus: user has interacted with view');
  }

  // 高亮当前执行路径
  highlightActivePath(dagreGraph, data.nodes, nodes, links);
}

function highlightActivePath(dagreGraph, dataNodes, nodeSelection, linkSelection) {
  // 清除之前的高亮
  nodeSelection.classed("path-highlight", false);
  linkSelection.classed("path-highlight", false);

  // 如果系统在反思或规划阶段，不进行路径高亮
  if (state.currentPhase === 'reflecting' || state.currentPhase === 'planning') {
    console.log('Skipping path highlight - system in phase:', state.currentPhase);
    return;
  }

  console.log('All nodes:', dataNodes.map(n => ({ id: n.id, type: n.type, status: n.status })));
  console.log('All edges in graph:', dagreGraph.edges().map(e => `${e.v} -> ${e.w}`));

  // 检查全局任务是否完成
  // 方法1: 检查根节点状态
  const rootNode = dataNodes.find(n => n.type === 'root');
  const rootCompleted = rootNode && rootNode.status === 'completed';

  // 方法2: 检查全局标志（通过 state.missionAccomplished）
  const isGoalAchieved = rootCompleted || state.missionAccomplished;

  if (isGoalAchieved) {
    // 确保 missionAccomplished 状态同步（首次渲染时可能还未设置）
    if (!state.missionAccomplished) {
      state.missionAccomplished = true;
      showSuccessBanner();
      console.log('🎉 Task completed detected from graph data, setting missionAccomplished');
    }
    console.log('🎉 Goal achieved! Highlighting success path...');
    // 高亮所有成功完成的路径
    highlightSuccessPaths(dagreGraph, dataNodes, nodeSelection, linkSelection);
    return;
  }

  // 新策略：始终高亮到最新的执行节点，不管是否有活跃节点
  // 1. 优先：正在执行的动作节点
  // 2. 其次：如果有活跃任务，找它路径上最后执行的动作节点
  // 3. 最后：找所有已完成/失败的动作节点中的叶子节点

  const activeNodes = dataNodes.filter(n => n.status === 'in_progress' || n.status === 'running');
  const allActionNodes = dataNodes.filter(n => n.type === 'action');
  const activeActionNodes = activeNodes.filter(n => n.type === 'action');
  const activeTaskNodes = activeNodes.filter(n => n.type === 'task');
  const activeRootNodes = activeNodes.filter(n => n.type === 'root');

  // 收集所有需要高亮的"叶子节点"（执行的最前沿）
  let leafNodes = [];

  if (activeActionNodes.length > 0) {
    // 有正在运行的动作节点，高亮所有这些节点的路径
    leafNodes = activeActionNodes;
    console.log('Found active action nodes:', leafNodes.map(n => n.id));
  } else if (activeTaskNodes.length > 0) {
    // 任务在执行但没有动作节点在运行
    // 策略：从当前 in_progress 的任务向下找到所有子节点中最深的已执行 action 节点
    activeTaskNodes.forEach(task => {
      console.log('Processing active task:', task.id);

      // 递归收集从当前任务向下的所有后继节点（子任务树）
      const descendantsSet = new Set();

      function collectDescendants(nodeId) {
        const succs = dagreGraph.successors(nodeId);
        if (!succs || succs.length === 0) return;

        succs.forEach(succ => {
          if (!descendantsSet.has(succ)) {
            descendantsSet.add(succ);
            collectDescendants(succ); // 递归收集子节点
          }
        });
      }

      collectDescendants(task.id);
      console.log('  Descendants of task:', Array.from(descendantsSet));

      // 在后继节点中找到所有动作节点
      const actionsInSubtree = allActionNodes.filter(action => descendantsSet.has(action.id));
      console.log('  Actions in subtree:', actionsInSubtree.map(a => ({ id: a.id, status: a.status })));

      if (actionsInSubtree.length > 0) {
        // 找到所有已执行的动作节点（completed 或 failed）
        const executedActions = actionsInSubtree.filter(n =>
          n.status === 'completed' || n.status === 'failed'
        );

        console.log('  Executed actions:', executedActions.map(a => ({ id: a.id, completed_at: a.completed_at })));

        if (executedActions.length > 0) {
          // 策略：使用 completed_at 时间戳找到最新执行完成的 action 节点
          const actionsWithTime = executedActions.filter(a => a.completed_at);

          let latestAction = null;

          if (actionsWithTime.length > 0) {
            // 按 completed_at 排序，找到最新的
            actionsWithTime.sort((a, b) => b.completed_at - a.completed_at);
            latestAction = actionsWithTime[0];
            console.log('  Latest action by timestamp:', latestAction.id, 'completed at', latestAction.completed_at);
          } else {
            // 如果没有时间戳信息，回退到查找最深的叶子节点
            console.log('  No timestamp info, falling back to deepest leaf strategy');
            const executedIds = new Set(executedActions.map(a => a.id));

            // BFS 寻找最深的叶子节点
            function findDeepestLeaf() {
              const queue = [{ id: task.id, depth: 0 }];
              let maxDepth = 0;
              let deepestLeaf = null;
              const visited = new Set();

              while (queue.length > 0) {
                const { id, depth } = queue.shift();
                if (visited.has(id)) continue;
                visited.add(id);

                const successors = dagreGraph.successors(id);
                const executedSuccessors = successors?.filter(s => executedIds.has(s)) || [];

                if (executedSuccessors.length === 0 && executedIds.has(id)) {
                  // 这是一个已执行的叶子节点
                  if (depth > maxDepth) {
                    maxDepth = depth;
                    deepestLeaf = id;
                  }
                } else {
                  // 继续向下搜索
                  executedSuccessors.forEach(succ => {
                    queue.push({ id: succ, depth: depth + 1 });
                  });
                }
              }

              return deepestLeaf;
            }

            const deepestLeaf = findDeepestLeaf();
            if (deepestLeaf) {
              latestAction = dataNodes.find(n => n.id === deepestLeaf);
            }
          }

          if (latestAction) {
            leafNodes.push(latestAction);
          } else {
            // 如果没找到，使用任务本身
            console.log('  No latest action found, using task itself');
            leafNodes.push(task);
          }
        } else {
          // 子树中没有已执行的动作，高亮任务本身
          console.log('  No executed actions in subtree, using task itself');
          leafNodes.push(task);
        }
      } else {
        // 子树中没有动作节点，高亮任务本身
        console.log('  No actions in subtree, using task itself');
        leafNodes.push(task);
      }
    });

    console.log('Task in progress, final leaf nodes:', leafNodes.map(n => n.id));
  } else if (activeRootNodes.length > 0) {
    // 只有根节点在运行，但没有活跃的任务或动作节点
    // 找到所有已完成/失败的动作节点中的叶子节点
    const executedActions = allActionNodes.filter(n =>
      n.status === 'completed' || n.status === 'failed'
    );

    console.log('Root active, executed actions:', executedActions.map(a => ({ id: a.id, status: a.status })));

    if (executedActions.length > 0) {
      // 找到叶子节点（没有后继，或后继不在已执行列表中）
      const executedIds = new Set(executedActions.map(a => a.id));
      const leaves = executedActions.filter(action => {
        const successors = dagreGraph.successors(action.id);
        return !successors || successors.length === 0 ||
          !successors.some(succ => executedIds.has(succ));
      });

      console.log('Leaf executed actions:', leaves.map(l => l.id));

      if (leaves.length > 0) {
        leafNodes.push(...leaves);
      } else {
        // 找不到叶子，用所有已执行的
        leafNodes.push(...executedActions);
      }
    } else {
      // 没有已执行的动作，高亮根节点
      leafNodes = activeRootNodes;
    }

    console.log('Root only, final leaf nodes:', leafNodes.map(n => n.id));
  } else {
    // 完全没有活跃节点 - 这种情况下也要显示最后的执行状态
    console.log('No active nodes at all, finding latest executed actions');

    const executedActions = allActionNodes.filter(n =>
      n.status === 'completed' || n.status === 'failed'
    );

    if (executedActions.length > 0) {
      const executedIds = new Set(executedActions.map(a => a.id));
      const leaves = executedActions.filter(action => {
        const successors = dagreGraph.successors(action.id);
        return !successors || successors.length === 0 ||
          !successors.some(succ => executedIds.has(succ));
      });

      if (leaves.length > 0) {
        leafNodes.push(...leaves);
      }
    }

    console.log('No active nodes, using executed leaves:', leafNodes.map(n => n.id));
  }

  if (leafNodes.length === 0) {
    console.log('No leaf nodes to highlight');
    return;
  }

  // 从所有叶子节点追溯到根节点（支持多条并行路径）
  const pathToRoot = new Set();
  const edgesInPath = new Set();

  function findPathToRoot(nodeId) {
    if (!nodeId || pathToRoot.has(nodeId)) return; // 防止循环

    pathToRoot.add(nodeId);
    const predecessors = dagreGraph.predecessors(nodeId);

    if (predecessors && predecessors.length > 0) {
      predecessors.forEach(pred => {
        edgesInPath.add(`${pred}->${nodeId}`);
        findPathToRoot(pred);
      });
    }
  }

  // 对每个叶子节点追溯路径
  console.log('Tracing paths from leaf nodes:', leafNodes.map(n => n.id));
  leafNodes.forEach(leaf => {
    findPathToRoot(leaf.id);
  });

  console.log('Highlighted paths include', pathToRoot.size, 'nodes and', edgesInPath.size, 'edges');
  console.log('Path nodes:', Array.from(pathToRoot));

  // 高亮路径上的节点
  nodeSelection.classed("path-highlight", d => pathToRoot.has(d));

  // 高亮路径上的边
  linkSelection.classed("path-highlight", d => {
    const edgeKey = `${d.v}->${d.w}`;
    return edgesInPath.has(edgeKey);
  });
}

// 高亮成功路径（当全局任务完成时）
function highlightSuccessPaths(dagreGraph, dataNodes, nodeSelection, linkSelection) {
  console.log('🎉 Highlighting success path...');

  // 显示成功横幅
  showSuccessBanner();

  // 构建节点ID到数据的映射
  const nodeById = new Map(dataNodes.map(n => [n.id, n]));

  let targetGoalNode = null;

  // 策略：查找带有 is_goal_achieved 标记的节点（由后端标记）
  const goalAchievedNode = dataNodes.find(n => n.is_goal_achieved === true);

  if (goalAchievedNode) {
    console.log('🎯 Found goal-achieved node:', goalAchievedNode.id, 'type:', goalAchievedNode.type);

    // 如果是 task/subtask 类型，需要继续向下找它下面最深的 completed action 节点
    if (goalAchievedNode.type === 'task' || goalAchievedNode.type === 'subtask') {
      console.log('Goal node is a subtask, finding deepest action underneath...');

      // 递归寻找该子任务下最后完成的 action（按时间）
      const visited = new Set(); // 防止无限循环

      function findDeepestCompletedAction(nodeId, depth = 0) {
        // 防止无限循环和过深递归
        if (!nodeId || visited.has(nodeId) || depth > 100) {
          return null;
        }
        visited.add(nodeId);

        const successors = dagreGraph.successors(nodeId);
        if (!successors || successors.length === 0) {
          const node = nodeById.get(nodeId);
          return (node && (node.type === 'action' || node.type === 'execution_step')) ? node : null;
        }

        let latestNode = null;
        let latestTime = 0;

        for (const succId of successors) {
          const succNode = nodeById.get(succId);
          if (succNode && succNode.status === 'completed') {
            // 如果是 action/execution_step，检查完成时间
            if (succNode.type === 'action' || succNode.type === 'execution_step') {
              const completedAt = succNode.completed_at || 0;
              if (completedAt > latestTime) {
                latestTime = completedAt;
                latestNode = succNode;
              }
            }
            // 递归检查子节点
            const deeperNode = findDeepestCompletedAction(succId, depth + 1);
            if (deeperNode && (deeperNode.type === 'action' || deeperNode.type === 'execution_step')) {
              const deeperTime = deeperNode.completed_at || 0;
              if (deeperTime > latestTime) {
                latestTime = deeperTime;
                latestNode = deeperNode;
              }
            }
          }
        }

        return latestNode;
      }

      const deepestAction = findDeepestCompletedAction(goalAchievedNode.id);
      if (deepestAction && deepestAction.id !== goalAchievedNode.id) {
        console.log('Found deepest action under goal subtask:', deepestAction.id);
        targetGoalNode = deepestAction;
      } else {
        targetGoalNode = goalAchievedNode;
      }
    } else {
      targetGoalNode = goalAchievedNode;
    }
  } else {
    // 策略1：尝试找到 result/observation 中包含 flag 标识的节点
    const flagKeywords = ['flag', 'FLAG', 'secret', 'success', 'accomplished', 'objective'];

    function containsFlag(node) {
      const result = node.result || '';
      const observation = node.observation || '';
      const combined = (typeof result === 'string' ? result : JSON.stringify(result)) +
        (typeof observation === 'string' ? observation : JSON.stringify(observation));
      return flagKeywords.some(kw => combined.toLowerCase().includes(kw.toLowerCase()));
    }

    const flagNode = dataNodes.find(n =>
      n.status === 'completed' && (n.type === 'action' || n.type === 'task') && containsFlag(n)
    );

    if (flagNode) {
      console.log('🚩 Found flag-bearing node:', flagNode.id);
      targetGoalNode = flagNode;
    } else {
      // 策略2：从根节点向下，选择有最长 completed 后代链的路径
      console.log('No explicit goal node found, using longest completed chain strategy');

      const rootNode = dataNodes.find(n => n.type === 'root');
      if (!rootNode || rootNode.status !== 'completed') {
        console.log('Root node not completed');
        return;
      }

      // 计算每个节点的最长completed后代链深度
      const depthCache = new Map();

      function getMaxCompletedDepth(nodeId) {
        if (depthCache.has(nodeId)) return depthCache.get(nodeId);

        const node = nodeById.get(nodeId);
        if (!node || node.status !== 'completed') {
          depthCache.set(nodeId, -1);
          return -1;
        }

        const successors = dagreGraph.successors(nodeId);
        if (!successors || successors.length === 0) {
          depthCache.set(nodeId, 0);
          return 0;
        }

        let maxChildDepth = -1;
        for (const succId of successors) {
          const childDepth = getMaxCompletedDepth(succId);
          if (childDepth > maxChildDepth) {
            maxChildDepth = childDepth;
          }
        }

        const myDepth = maxChildDepth >= 0 ? maxChildDepth + 1 : 0;
        depthCache.set(nodeId, myDepth);
        return myDepth;
      }

      // 从根节点追踪最长completed链
      let currentNode = rootNode.id;
      let lastNode = rootNode.id;

      while (currentNode) {
        lastNode = currentNode;
        const successors = dagreGraph.successors(currentNode);
        if (!successors || successors.length === 0) break;

        // 筛选completed后继
        const completedSucc = successors
          .map(succId => nodeById.get(succId))
          .filter(n => n && n.status === 'completed');

        if (completedSucc.length === 0) break;

        // 选择有最长completed后代链的那个
        let bestSucc = null;
        let bestDepth = -1;
        for (const succ of completedSucc) {
          const depth = getMaxCompletedDepth(succ.id);
          if (depth > bestDepth) {
            bestDepth = depth;
            bestSucc = succ;
          }
        }

        if (bestSucc) {
          currentNode = bestSucc.id;
        } else {
          break;
        }
      }

      targetGoalNode = nodeById.get(lastNode);
      console.log('Selected deepest chain leaf:', lastNode);
    }
  }

  // 如果在最外层（策略0成功时）也需要执行回溯和高亮
  if (targetGoalNode) {
    // 从目标节点向上回溯到根节点
    const successPathNodes = new Set();
    const successPathEdges = new Set();

    function traceToRoot(nodeId) {
      if (!nodeId || successPathNodes.has(nodeId)) return;

      successPathNodes.add(nodeId);

      const predecessors = dagreGraph.predecessors(nodeId);
      if (predecessors && predecessors.length > 0) {
        const selectedPred = predecessors[0];
        successPathEdges.add(`${selectedPred}->${nodeId}`);
        traceToRoot(selectedPred);
      }
    }

    traceToRoot(targetGoalNode.id);

    console.log('✨ Success path found:', successPathNodes.size, 'nodes,', successPathEdges.size, 'edges');
    console.log('Path nodes:', Array.from(successPathNodes));

    // 高亮成功路径
    nodeSelection.classed("success-path", d => successPathNodes.has(d));

    linkSelection.classed("success-path", d => {
      const edgeKey = `${d.v}->${d.w}`;
      return successPathEdges.has(edgeKey);
    });

    // 自动聚焦到成功路径的目标节点
    if (!state.userHasInteracted) {
      const nodeData = dagreGraph.node(targetGoalNode.id);
      if (nodeData) {
        const svgWidth = state.svg.node().clientWidth || 800;
        const svgHeight = state.svg.node().clientHeight || 600;

        const focusScale = 0.75;
        const targetX = svgWidth / 2 - nodeData.x * focusScale;
        const targetY = svgHeight / 2 - nodeData.y * focusScale;

        console.log('Focusing on success target:', targetGoalNode.id, 'at', nodeData.x, nodeData.y);

        state.isProgrammaticZoom = true;
        state.svg.transition()
          .duration(500)
          .call(state.zoom.transform, d3.zoomIdentity
            .translate(targetX, targetY)
            .scale(focusScale))
          .on('end', () => {
            state.isProgrammaticZoom = false;
          });
      }
    }
  }
}

// 从指定节点回溯到根节点并高亮路径
function highlightPathFromNode(dagreGraph, startNodeId, nodeSelection, linkSelection) {
  const pathToRoot = new Set();
  const edgesInPath = new Set();

  function findPathToRoot(nodeId) {
    if (!nodeId || pathToRoot.has(nodeId)) return;

    pathToRoot.add(nodeId);
    const predecessors = dagreGraph.predecessors(nodeId);

    if (predecessors && predecessors.length > 0) {
      predecessors.forEach(pred => {
        edgesInPath.add(`${pred}->${nodeId}`);
        findPathToRoot(pred);
      });
    }
  }

  findPathToRoot(startNodeId);

  console.log('✨ Success path includes', pathToRoot.size, 'nodes and', edgesInPath.size, 'edges');
  console.log('Path nodes:', Array.from(pathToRoot));

  // 使用 success-path 类高亮节点和边（绿色发光效果）
  nodeSelection.classed("success-path", d => pathToRoot.has(d));

  linkSelection.classed("success-path", d => {
    const edgeKey = `${d.v}->${d.w}`;
    return edgesInPath.has(edgeKey);
  });

  // 自动聚焦到起始节点（最后完成的 action）
  const nodeData = dagreGraph.node(startNodeId);
  if (nodeData && !state.userHasInteracted) {
    const svgWidth = state.svg.node().clientWidth || 800;
    const svgHeight = state.svg.node().clientHeight || 600;

    // 使用较大的缩放比例，让视图能看到周围几个节点
    const focusScale = 0.75;
    const targetX = svgWidth / 2 - nodeData.x * focusScale;
    const targetY = svgHeight / 2 - nodeData.y * focusScale;

    console.log('Focusing on success node:', startNodeId, 'at', nodeData.x, nodeData.y);

    // 设置程序化缩放标志
    state.isProgrammaticZoom = true;

    // 使用平滑动画聚焦
    state.svg.transition()
      .duration(500)
      .call(state.zoom.transform, d3.zoomIdentity
        .translate(targetX, targetY)
        .scale(focusScale))
      .on('end', () => {
        state.isProgrammaticZoom = false;
      });
  }
}

function dragstarted(e, d) { if (!e.active) state.simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
function dragged(e, d) { d.fx = e.x; d.fy = e.y; }
function dragended(e, d) { if (!e.active) state.simulation.alphaTarget(0); d.fx = null; d.fy = null; }
function zoomIn() { state.svg.transition().call(state.zoom.scaleBy, 1.1); }
function zoomOut() { state.svg.transition().call(state.zoom.scaleBy, 0.8); }
function zoomReset() { state.svg.transition().call(state.zoom.transform, d3.zoomIdentity); }

// 切换自动追踪模式
function toggleAutoFocus() {
  state.userHasInteracted = !state.userHasInteracted;
  updateTrackButton();

  if (!state.userHasInteracted) {
    // 重新启用追踪时，立即聚焦到活跃节点
    console.log('Auto-focus re-enabled, re-rendering...');
    render();
  } else {
    console.log('Auto-focus disabled by user');
  }
}

// 更新追踪按钮状态
function updateTrackButton() {
  const btn = document.getElementById('btn-track');
  if (btn) {
    if (state.userHasInteracted) {
      btn.style.opacity = '0.5';
      btn.title = currentLang === 'zh' ? '点击启用自动追踪' : 'Click to enable auto-tracking';
    } else {
      btn.style.opacity = '1';
      btn.title = currentLang === 'zh' ? '自动追踪已启用' : 'Auto-tracking enabled';
    }
  }
}

function updateLegend() {
  const el = document.getElementById('legend-content');
  let h = '';

  if (state.view === 'exec') {
    // 攻击图 - 显示执行状态
    const execLegend = {
      'completed': { color: '#10b981', label: t('status.completed') },
      'failed': { color: '#ef4444', label: t('status.failed') },
      'in_progress': { color: '#3b82f6', label: t('status.in_progress') },
      'pending': { color: '#64748b', label: t('status.pending') },
      'deprecated': { color: '#94a3b8', label: t('status.deprecated') }
    };
    Object.entries(execLegend).forEach(([k, v]) => {
      h += `<div class="legend-item">
                    <div class="legend-dot" style="background:${v.color}"></div>
                    <span>${v.label}</span>
                  </div>`;
    });
  } else if (state.view === 'causal') {
    // 因果图 - 显示节点类型（这些标签保持原样，因为是专业术语）
    const causalLegend = {
      'ConfirmedVulnerability': { color: '#f59e0b', label: currentLang === 'zh' ? '确认漏洞' : 'Confirmed Vuln' },
      'Vulnerability': { color: '#a855f7', label: currentLang === 'zh' ? '疑似漏洞' : 'Vulnerability' },
      'Evidence': { color: '#06b6d4', label: currentLang === 'zh' ? '证据' : 'Evidence' },
      'Hypothesis': { color: '#84cc16', label: currentLang === 'zh' ? '假设' : 'Hypothesis' },
      'KeyFact': { color: '#fbbf24', label: currentLang === 'zh' ? '关键事实' : 'Key Fact' },
      'Flag': { color: '#ef4444', label: 'Flag' }
    };
    Object.entries(causalLegend).forEach(([k, v]) => {
      h += `<div class="legend-item">
                    <div class="legend-dot" style="background:${v.color}"></div>
                    <span>${v.label}</span>
                  </div>`;
    });
  }

  el.innerHTML = h;
}

function showDetails(d) {
  const c = document.getElementById('node-detail-content');
  let h = '';

  // Header with Type and ID - 增强类型显示
  const typeLabel = d.type === 'root' ? t('type.root') :
    d.type === 'task' ? t('type.task') :
      d.type === 'action' ? t('type.action') :
        (d.type || 'NODE');
  const typeColor = d.type === 'root' ? '#3b82f6' :
    d.type === 'task' ? '#8b5cf6' :
      d.type === 'action' ? '#f59e0b' :
        '#64748b';

  h += `<div style="margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border-color)">
          <div style="font-size:10px;text-transform:uppercase;color:${typeColor};font-weight:bold;display:inline-block;background:${typeColor}22;padding:2px 6px;border-radius:3px;">${typeLabel}</div>
          <div style="font-size:14px;font-weight:bold;word-break:break-all;margin-top:6px;">${d.label || d.description || d.id}</div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:4px">ID: ${d.id}</div>
        </div>`;

  // Status Badge
  const statusColor = nodeColors[d.status] || '#64748b';
  const statusText = d.status ? t('status.' + d.status) || d.status : 'UNKNOWN';
  h += `<div style="margin-bottom:16px"><span style="background:${statusColor};color:white;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:bold;text-transform:uppercase">${statusText}</span></div>`;

  // Tool Execution Details (if available) - 增强显示
  if (d.tool_name || d.action) {
    h += `<div class="detail-section" style="border:1px solid #f59e0b;border-radius:6px;padding:12px;margin-bottom:12px;background:rgba(245,158,11,0.05);">
              <div class="detail-header" style="color:#f59e0b;margin-bottom:8px;">🔧 ${t('panel.tool')}</div>`;

    const toolName = d.tool_name || (d.action && d.action.tool);
    if (toolName) {
      h += `<div class="detail-row" style="margin-bottom:8px;">
                  <span class="detail-key">${t('panel.tool')}:</span> 
                  <span class="detail-val" style="color:#f59e0b;font-weight:bold;font-family:monospace;">${toolName}</span>
                </div>`;
    }

    const toolArgs = d.tool_args || (d.action && d.action.params);
    if (toolArgs) {
      h += `<div class="detail-row" style="margin-bottom:4px;">
                  <span class="detail-key">${t('panel.args')}:</span>
                </div>
                <div class="code-block" style="max-height:200px;overflow-y:auto;margin-bottom:8px;">${hlJson(toolArgs)}</div>`;
    }

    if (d.result) {
      h += `<div class="detail-row" style="margin-bottom:4px;">
                  <span class="detail-key">${t('panel.result')}:</span>
                </div>
                <div class="code-block" style="max-height:300px;overflow-y:auto;">${hlJson(d.result)}</div>`;
    }

    if (d.observation) {
      h += `<div class="detail-row" style="margin-bottom:4px;margin-top:8px;">
                  <span class="detail-key">${t('panel.observation')}:</span>
                </div>
                <div class="code-block" style="max-height:300px;overflow-y:auto;">${hlJson(d.observation)}</div>`;
    }

    h += `</div>`;
  }

  // Other Properties
  h += `<div class="detail-section"><div class="detail-header">${t('panel.description')}</div><table class="detail-table">`;
  Object.entries(d).forEach(([k, v]) => {
    if (!['x', 'y', 'fx', 'fy', 'vx', 'vy', 'index', 'children', 'width', 'height', 'tool_name', 'tool_args', 'result', 'observation', 'action', 'label', 'id', 'type', 'status', 'description', 'original_type'].includes(k)) {
      h += `<tr><td class="detail-key">${escapeHtml(k)}</td><td class="detail-val">${typeof v === 'object' ? hlJson(v) : escapeHtml(String(v))}</td></tr>`;
    }
  });
  h += '</table></div>';

  c.innerHTML = h;
  document.getElementById('node-details-panel').classList.add('show');
}

function closeDetails() {
  document.getElementById('node-details-panel').classList.remove('show');
}

// 初始化节点详情窗口拖动功能
function initPanelDrag() {
  const panel = document.getElementById('node-details-panel');
  const header = panel.querySelector('.panel-header');

  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  header.style.cursor = 'move';

  header.addEventListener('mousedown', (e) => {
    // 忽略按钮点击
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;

    isDragging = true;
    const rect = panel.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;

    // 防止选中文本
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const main = document.getElementById('main');
    const mainRect = main.getBoundingClientRect();

    // 计算新位置（相对于 main 容器）
    let newLeft = e.clientX - mainRect.left - offsetX;
    let newTop = e.clientY - mainRect.top - offsetY;

    // 限制在 main 容器内
    const panelRect = panel.getBoundingClientRect();
    newLeft = Math.max(0, Math.min(newLeft, mainRect.width - panelRect.width));
    newTop = Math.max(0, Math.min(newTop, mainRect.height - panelRect.height));

    panel.style.left = newLeft + 'px';
    panel.style.top = newTop + 'px';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
  });
}

// 页面加载后初始化拖动
document.addEventListener('DOMContentLoaded', () => {
  initPanelDrag();
});

function subscribe() {
  state.es = new EventSource(`/api/events?op_id=${state.op_id}`);
  state.es.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);

      // 统一处理所有事件
      const eventType = msg.event || 'message';

      // 对于已完成的任务，跳过图形刷新事件（减少不必要的渲染）
      if (eventType === 'graph.changed' || eventType === 'execution.step.completed') {
        if (!state.missionAccomplished) {
          render();
        }
      }
      if (eventType === 'ping' || eventType === 'graph.ready') return;

      // 分流渲染（实时事件）
      if (eventType.startsWith('llm.')) {
        renderLLMResponse(msg, false);
      } else {
        renderSystemEvent(msg);
      }
    } catch (x) { console.error('Parse error', x); }
  };
  // 加载历史事件时设置标志，避免 phase banner 闪烁
  fetch(`/api/ops/${state.op_id}/llm-events`).then(r => r.json()).then(d => {
    state.isLoadingHistory = true;
    (d.events || []).forEach(e => {
      if (e.event && e.event.startsWith('llm.')) renderLLMResponse(e, true); else renderSystemEvent(e);
    });
    state.isLoadingHistory = false;
  });
}

// 专门处理系统/执行事件 (execution.step.completed, graph.changed, etc)
function renderSystemEvent(msg) {
  const id = (msg.timestamp || 0) + '_' + msg.event;
  if (state.processedEvents.has(id)) return;
  state.processedEvents.add(id);

  const container = document.getElementById('llm-stream');
  const div = document.createElement('div');
  // 使用 role-system 样式
  div.className = 'llm-msg role-system';

  const time = new Date(msg.timestamp ? msg.timestamp * 1000 : Date.now()).toLocaleTimeString();
  const eventType = msg.event;
  const data = msg.data || msg.payload || {};

  // 步骤分隔线
  if (eventType === 'execution.step.completed') {
    const sep = document.createElement('div');
    sep.className = 'step-separator';
    container.appendChild(sep);
  }

  let html = `<div class="msg-meta">
        <div><span class="role-badge">SYSTEM</span><span>${msg.event}</span></div>
        <span>${time}</span>
    </div>`;

  // 针对 Tool Execution Completed 的特殊渲染
  if (eventType === 'execution.step.completed') {
    let result = data.result;
    // 尝试解析 result 字符串内部的 JSON
    if (typeof result === 'string') {
      try { result = JSON.parse(result); } catch (e) { }
    }

    html += `<div style="color:#a5d6ff;margin-bottom:4px;">Tool: <b>${data.tool_name}</b> (Step: ${data.step_id})</div>`;
    html += `<div class="tool-output">${hlJson(result)}</div>`;
  }
  // 针对 Graph Changed
  else if (eventType === 'graph.changed') {
    if (data.reason === 'mission_accomplished') {
      html += `<div style="color:#10b981;font-weight:bold;">🎉 Mission Accomplished!</div>`;
      html += `<div style="color:#94a3b8">Root task marked as completed</div>`;
      if (!state.missionAccomplished) {
        state.missionAccomplished = true;
        showSuccessBanner(); // [Fix] Update UI to show success banner
        loadOps(); // Refresh the task list on mission accomplished
      }
    } else if (data.reason === 'confidence_update') {
      html += `<div style="color:#fbbf24;font-weight:bold;">📈 Confidence Update</div>`;
      html += `<div style="color:#94a3b8">${escapeHtml(data.message || 'No details')}</div>`;
    } else {
      html += `<div style="color:#94a3b8">Graph updated: ${escapeHtml(data.reason || 'Unknown reason')}</div>`;
    }
  }
  // 针对 Intervention
  else if (eventType === 'intervention.required') {
    html += `<div style="color:#f59e0b;font-weight:bold;">⚠ Intervention Required</div>`;
    html += `<div style="color:#94a3b8">Waiting for user approval...</div>`;
  }
  // 兜底通用渲染
  else {
    html += `<div class="raw-data-content">${hlJson(data)}</div>`;
  }

  div.innerHTML = html;
  const shouldScroll = Math.abs(container.scrollHeight - container.clientHeight - container.scrollTop) < 50;
  container.appendChild(div);
  if (shouldScroll) container.scrollTop = container.scrollHeight;
}

// 专门处理 LLM 响应
function renderLLMResponse(msg, isHistory = false) {
  const id = (msg.timestamp || Date.now()) + '_' + msg.event;
  if (state.processedEvents.has(id)) return;
  state.processedEvents.add(id);

  if (msg.event && msg.event.includes('request')) return;

  // 1. 确定角色和样式
  const eventType = msg.event || '';
  const data = msg.data || msg.payload || {};

  let roleClass = 'role-system';
  let roleName = 'SYSTEM';

  // 尝试从 payload 中获取 role
  let role = data.role;
  if (!role && typeof data === 'string') {
    try { const p = JSON.parse(data); role = p.role; } catch (e) { }
  }

  // 只在实时事件（非历史回放）且任务未完成时显示 phase banner
  const shouldShowPhase = !isHistory && !state.missionAccomplished;

  if (role === 'planner' || eventType.includes('planner') || (data.model && data.model.includes('planner'))) {
    roleClass = 'role-planner'; roleName = 'PLANNER';
    if (shouldShowPhase) showPhaseBanner('planning');
  } else if (role === 'executor' || eventType.includes('executor') || (data.model && data.model.includes('executor'))) {
    roleClass = 'role-executor'; roleName = 'EXECUTOR';
    if (shouldShowPhase) {
      showPhaseBanner('executing');
      setTimeout(() => { if (state.currentPhase === 'executing') hidePhaseBanner(); }, 2000);
    }
  } else if (role === 'reflector' || eventType.includes('reflector') || (data.model && data.model.includes('reflector'))) {
    roleClass = 'role-reflector'; roleName = 'REFLECTOR';
    if (shouldShowPhase) showPhaseBanner('reflecting');
  }

  // 检测全局任务完成
  let missionFlag = false;
  const msgContentStr = JSON.stringify(msg).toLowerCase();
  if ((data && data.global_mission_accomplished === true) ||
    (data.data && data.data.global_mission_accomplished === true) ||
    (msgContentStr.includes('global_mission_accomplished') && msgContentStr.includes('true'))) {
    missionFlag = true;
  }

  if (missionFlag && !state.missionAccomplished) {
    state.missionAccomplished = true;
    showSuccessBanner();
    render();
  }

  // 2. 解析内容
  let content = data;
  if (content && content.content) content = content.content;
  if (typeof content === 'string' && (content.trim().startsWith('{') || content.trim().startsWith('['))) {
    try { content = JSON.parse(content); } catch (e) { }
  }

  // 3. 构建 HTML 内容
  const container = document.getElementById('llm-stream');
  const div = document.createElement('div');
  div.className = `llm-msg ${roleClass}`;

  const time = new Date(msg.timestamp ? msg.timestamp * 1000 : Date.now()).toLocaleTimeString();

  let htmlContent = `<div class="msg-meta">
      <div><span class="role-badge">${roleName}</span><span>${msg.event}</span></div>
      <span>${time}</span>
  </div>`;

  if (typeof content === 'object' && content !== null) {
    let remaining = { ...content };

    // Thought
    if (remaining.thought) {
      let thoughtText = '';
      if (typeof remaining.thought === 'object') {
        for (const [key, val] of Object.entries(remaining.thought)) {
          if (typeof val === 'string') thoughtText += `<div style="margin-bottom:6px;"><span class="detail-key">${escapeHtml(key.replace(/_/g, ' '))}:</span> <span style="color:#e2e8f0">${escapeHtml(val)}</span></div>`;
        }
      } else {
        thoughtText = `<div style="color:#e2e8f0">${escapeHtml(String(remaining.thought))}</div>`;
      }
      htmlContent += `<div class="thought-card">${thoughtText}</div>`;
      delete remaining.thought;
    }

    // Audit Result
    if (remaining.audit_result) {
      const audit = remaining.audit_result;
      const statusColor = audit.status === 'passed' ? '#10b981' : (audit.status === 'failed' ? '#ef4444' : '#f59e0b');
      htmlContent += `<div class="thought-card" style="border-left-color:${statusColor}">
              <div class="thought-title" style="color:${statusColor}">Audit: ${escapeHtml(audit.status.toUpperCase())}</div>
              <div style="margin-bottom:6px;">${escapeHtml(audit.completion_check || '')}</div>
          </div>`;
      delete remaining.audit_result;
    }

    // Collapsible Graph Actions
    if (remaining.graph_operations && Array.isArray(remaining.graph_operations)) {
      const count = remaining.graph_operations.length;
      let detailsHtml = '';
      remaining.graph_operations.forEach(op => {
        const nodeData = op.node_data || {};
        detailsHtml += `<div class="op-item"><span class="plan-tag ${op.command}">${op.command}</span> <span style="font-family:monospace;color:#cbd5e1">${nodeData.id || '-'}</span></div>`;
      });
      htmlContent += `
          <div class="log-group">
              <div class="log-summary" onclick="this.parentElement.classList.toggle('open')">Graph Actions (${count})</div>
              <div class="log-details">${detailsHtml}</div>
          </div>`;
      delete remaining.graph_operations;
    }

    // Collapsible Execution Actions
    if (remaining.execution_operations && Array.isArray(remaining.execution_operations)) {
      const count = remaining.execution_operations.length;
      let detailsHtml = '';
      remaining.execution_operations.forEach(op => {
        const toolName = op.action ? op.action.tool : 'Unknown';
        detailsHtml += `<div class="op-item"><span style="color:#f59e0b">🔧 ${toolName}</span> <span style="color:#94a3b8">${op.thought || ''}</span></div>`;
      });
      htmlContent += `
          <div class="log-group open">
              <div class="log-summary" onclick="this.parentElement.classList.toggle('open')">Execution Actions (${count})</div>
              <div class="log-details">${detailsHtml}</div>
          </div>`;
      delete remaining.execution_operations;
    }

    // Cleanup common fields
    delete remaining.key_findings; delete remaining.key_facts; delete remaining.causal_graph_updates;
    delete remaining.staged_causal_nodes; delete remaining.attack_intelligence; delete remaining.role; delete remaining.model;
    delete remaining.global_mission_accomplished; delete remaining.is_subtask_complete; delete remaining.success; delete remaining.hypothesis_update;

    // Remaining Data Dump (Collapsible)
    if (Object.keys(remaining).length > 0) {
      htmlContent += `
          <div class="log-group">
              <div class="log-summary" onclick="this.parentElement.classList.toggle('open')">Other Data</div>
              <div class="log-details"><div class="raw-data-content">${hlJson(JSON.stringify(remaining, null, 2))}</div></div>
          </div>`;
    }

  } else {
    htmlContent += `<div style="white-space:pre-wrap;color:#e2e8f0;">${escapeHtml(content)}</div>`;
  }

  div.innerHTML = htmlContent;

  const shouldScroll = Math.abs(container.scrollHeight - container.clientHeight - container.scrollTop) < 50;
  container.appendChild(div);
  if (shouldScroll) container.scrollTop = container.scrollHeight;
}

function hlJson(s) {
  if (typeof s !== 'string') {
    if (typeof s === 'object') s = JSON.stringify(s, null, 2);
    else s = String(s);
  }
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/("(\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, m => {
    let c = 'json-number';
    if (/^"/.test(m)) c = /:$/.test(m) ? 'json-key' : 'json-string';
    else if (/true|false/.test(m)) c = 'json-boolean';
    return `<span class="${c}">${m}</span>`;
  });
}

// HTML 转义辅助函数
function escapeHtml(str) {
  if (typeof str !== 'string') str = String(str);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 打开新建任务弹窗
function openCreateTaskModal() {
  document.getElementById('create-task-modal').classList.add('show');
  document.getElementById('create-goal').value = '';
  document.getElementById('create-taskname').value = '';
  document.getElementById('create-hitl').checked = false;
  document.getElementById('create-output-mode').value = 'default';
  document.getElementById('create-llm-planner').value = '';
  document.getElementById('create-llm-executor').value = '';
  document.getElementById('create-llm-reflector').value = '';
  document.getElementById('advanced-content').style.display = 'none';
  document.getElementById('advanced-arrow').style.transform = 'rotate(0deg)';
  updateHitlLabel();
  // 聚焦到目标输入框
  setTimeout(() => document.getElementById('create-goal').focus(), 100);
}

// 切换高级配置展开/折叠
function toggleAdvancedConfig() {
  const content = document.getElementById('advanced-content');
  const arrow = document.getElementById('advanced-arrow');
  if (content.style.display === 'none') {
    content.style.display = 'block';
    arrow.style.transform = 'rotate(180deg)';
  } else {
    content.style.display = 'none';
    arrow.style.transform = 'rotate(0deg)';
  }
}

// 更新人机协同模式标签
function updateHitlLabel() {
  const checkbox = document.getElementById('create-hitl');
  const label = document.getElementById('hitl-label');
  if (checkbox.checked) {
    label.textContent = currentLang === 'zh' ? '开启' : 'On';
    label.style.color = '#10b981';
  } else {
    label.textContent = currentLang === 'zh' ? '关闭' : 'Off';
    label.style.color = '#94a3b8';
  }
}

// 监听人机协同复选框变化
document.addEventListener('DOMContentLoaded', () => {
  const hitlCheckbox = document.getElementById('create-hitl');
  if (hitlCheckbox) {
    hitlCheckbox.addEventListener('change', updateHitlLabel);
  }
});

// 提交创建任务
async function submitCreateTask() {
  const goal = document.getElementById('create-goal').value.trim();
  const taskName = document.getElementById('create-taskname').value.trim();
  const hitl = document.getElementById('create-hitl').checked;
  const outputMode = document.getElementById('create-output-mode').value;
  const plannerModel = document.getElementById('create-llm-planner').value.trim();
  const executorModel = document.getElementById('create-llm-executor').value.trim();
  const reflectorModel = document.getElementById('create-llm-reflector').value.trim();

  if (!goal) {
    alert(currentLang === 'zh' ? '请输入任务目标' : 'Please enter a task goal');
    document.getElementById('create-goal').focus();
    return;
  }

  const payload = {
    goal: goal,
    task_name: taskName || undefined,
    human_in_the_loop: hitl,
    output_mode: outputMode
  };

  // 添加可选的LLM模型配置
  if (plannerModel) payload.llm_planner_model = plannerModel;
  if (executorModel) payload.llm_executor_model = executorModel;
  if (reflectorModel) payload.llm_reflector_model = reflectorModel;

  try {
    const r = await api('/api/ops', payload);
    if (r.ok) {
      closeModals();
      // 等待任务列表刷新完成
      await loadOps();
      
      // 创建占位主任务节点（立即显示）
      state.placeholderRootNode = {
        id: r.op_id,
        type: 'root',
        status: 'in_progress',
        label: goal.length > 50 ? goal.substring(0, 50) + '...' : goal,
        description: goal,
        placeholder: true
      };
      
      // 选择新任务并开始渲染
      selectOp(r.op_id);
      // 立即显示规划中横幅（在 selectOp 之后，避免被重置）
      showPhaseBanner('planning');
      // 显示成功提示
      const msg = currentLang === 'zh'
        ? `任务已启动！${hitl ? '（人机协同模式）' : ''}`
        : `Task started!${hitl ? ' (HITL mode)' : ''}`;
      console.log(msg, r);
    }
  } catch (e) {
    alert(currentLang === 'zh' ? `创建任务失败: ${e}` : `Failed to create task: ${e}`);
  }
}

// 兼容旧版调用（如果有地方还用着旧的createTask）
async function createTask() {
  openCreateTaskModal();
}

async function abortOp() {
  const isZh = (window.currentLang || 'zh') === 'zh';
  const ok = await showConfirmModal({
    title: isZh ? '终止任务' : 'Abort Operation',
    message: t('msg.confirm_abort'),
    confirmText: isZh ? '终止' : 'Abort',
    cancelText: isZh ? '取消' : 'Cancel',
    danger: true
  });
  if (!ok) return;
  
  try {
    const r = await api(`/api/ops/${state.op_id}/abort`, {});
    if (r.ok) {
      // 隐藏 phase banner
      hidePhaseBanner();

      // 更新状态，防止继续显示执行中状态
      state.missionAccomplished = false;
      state.currentPhase = null;

      // 显示终止横幅
      const banner = document.getElementById('phase-banner');
      const text = document.getElementById('phase-text');
      if (banner && text) {
        text.textContent = currentLang === 'zh' ? '⛔ 任务已终止' : '⛔ Task Aborted';
        banner.style.background = 'rgba(239, 68, 68, 0.95)';
        banner.style.display = 'block';
        // 3秒后隐藏
        setTimeout(() => {
          banner.style.display = 'none';
          banner.style.background = 'rgba(59,130,246,0.95)';
        }, 3000);
      }

      // 刷新任务列表
      loadOps();
      // 重新渲染图表
      render(true);

      console.log('Task aborted:', r.message, 'process_killed:', r.process_killed);
    }
  } catch (e) {
    console.error('Abort failed:', e);
  }
}

async function checkPendingIntervention() {
  if (!state.op_id) return;
  try {
    const r = await api(`/api/ops/${state.op_id}/intervention/pending`);
    const m = document.getElementById('approval-modal');
    if (r.pending && r.request) {
      if (!state.pendingReq || state.pendingReq.id !== r.request.id) {
        state.pendingReq = r.request; state.isModifyMode = false;
        renderApproval(r.request); m.classList.add('show');
      }
    } else if (state.pendingReq) { m.classList.remove('show'); state.pendingReq = null; }
  } catch (e) { }
}

function renderApproval(r) {
  const l = document.getElementById('approval-list'), e = document.getElementById('approval-json-editor'), ea = document.getElementById('approval-edit-area'), b = document.getElementById('btn-modify-mode');
  l.style.display = 'block'; ea.style.display = 'none'; b.innerText = 'Modify'; b.classList.remove('active');
  let h = ''; (r.data || []).forEach(o => { h += `<div class="plan-item"><div class="plan-tag ${o.command}">${o.command}</div><div style="flex:1;font-size:12px;color:#94a3b8"><div style="color:#e2e8f0;font-family:monospace">${o.node_id || (o.node_data ? o.node_data.id : '-')}</div>${o.command === 'ADD_NODE' ? (o.node_data.description || '') : ''}</div></div>`; });
  l.innerHTML = h; e.value = JSON.stringify(r.data, null, 2);
}

function toggleModifyMode() { state.isModifyMode = !state.isModifyMode; const l = document.getElementById('approval-list'), ea = document.getElementById('approval-edit-area'), b = document.getElementById('btn-modify-mode'); if (state.isModifyMode) { l.style.display = 'none'; ea.style.display = 'block'; b.innerText = 'Cancel'; b.classList.add('active') } else { l.style.display = 'block'; ea.style.display = 'none'; b.innerText = 'Modify'; b.classList.remove('active') } }
async function submitDecision(a) {
  if (!state.pendingReq) return;
  let p = { action: a, id: state.pendingReq.id };
  if (a === 'APPROVE' && state.isModifyMode) {
    try { p.modified_data = JSON.parse(document.getElementById('approval-json-editor').value); p.action = 'MODIFY' } catch (e) { return alert('Invalid JSON') }
  }
  await api(`/api/ops/${state.op_id}/intervention/decision`, p);
  document.getElementById('approval-modal').classList.remove('show');
  state.pendingReq = null;
}

function openInjectModal() { document.getElementById('inject-modal').classList.add('show') }
function closeModals() { document.querySelectorAll('.modal-overlay').forEach(e => e.classList.remove('show')) }
async function submitInjection() { const d = document.getElementById('inject-desc').value, dp = document.getElementById('inject-deps').value; if (d) await api(`/api/ops/${state.op_id}/inject_task`, { description: d, dependencies: dp ? dp.split(',') : [] }); closeModals(); }

// 通用确认弹窗
function showConfirmModal({ title, message, confirmText, cancelText, danger = false }) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const cancelBtn = document.getElementById('confirm-cancel-btn');
    const okBtn = document.getElementById('confirm-ok-btn');

    // 清理旧的事件
    cancelBtn.onclick = null;
    okBtn.onclick = null;

    // 设置文案
    const isZh = (window.currentLang || 'zh') === 'zh';
    titleEl.textContent = title || (isZh ? '确认操作' : 'Confirm');
    msgEl.textContent = message || (isZh ? '确认要执行该操作吗？' : 'Are you sure to proceed?');
    cancelBtn.textContent = cancelText || (isZh ? '取消' : 'Cancel');
    okBtn.textContent = confirmText || (isZh ? '确定' : 'OK');

    // 按钮风格：删除/终止用危险色
    if (danger) {
      okBtn.classList.add('btn-danger');
      okBtn.classList.remove('btn-primary');
    } else {
      okBtn.classList.remove('btn-danger');
      okBtn.classList.add('btn-primary');
    }

    // 绑定事件
    cancelBtn.onclick = () => {
      modal.classList.remove('show');
      resolve(false);
    };
    okBtn.onclick = () => {
      modal.classList.remove('show');
      resolve(true);
    };

    // 点击遮罩关闭
    modal.onclick = (e) => {
      if (e.target === modal) {
        modal.classList.remove('show');
        resolve(false);
      }
    };

    modal.classList.add('show');
  });
}

function openMCPModal() {
  document.getElementById('mcp-modal').classList.add('show');
  loadMCPConfig();
}

async function loadMCPConfig() {
  try {
    const data = await api('/api/mcp/config');
    const list = document.getElementById('mcp-list');
    let h = '';
    if (data.mcpServers) {
      Object.entries(data.mcpServers).forEach(([k, v]) => {
        h += `<div class="mb-1 border-b border-slate-700 pb-1">
                      <div class="font-bold text-blue-400">${k}</div>
                      <div class="text-gray-500">${v.command} ${(v.args || []).join(' ')}</div>
                    </div>`;
      });
    }
    list.innerHTML = h || t('mcp.no_servers');
  } catch (e) { console.error(e); }
}

async function addMCPServer() {
  const name = document.getElementById('mcp-name').value;
  const cmd = document.getElementById('mcp-cmd').value;
  const argsStr = document.getElementById('mcp-args').value;
  const envStr = document.getElementById('mcp-env').value;

  if (!name || !cmd) return alert(t('mcp.required'));

  let env = {};
  try {
    if (envStr) env = JSON.parse(envStr);
  } catch (e) { return alert(t('mcp.invalid_json')); }

  const args = argsStr ? argsStr.split(',').map(s => s.trim()) : [];

  try {
    await api('/api/mcp/add', { name, command: cmd, args, env });
    alert(t('mcp.success'));
    loadMCPConfig();
    // Clear inputs
    document.getElementById('mcp-name').value = '';
    document.getElementById('mcp-cmd').value = '';
    document.getElementById('mcp-args').value = '';
    document.getElementById('mcp-env').value = '';
  } catch (e) { alert(t('mcp.error') + ': ' + e); }
}

// Toggle left sidebar (operations list)
function toggleLeftSidebar() {
  state.leftSidebarCollapsed = !state.leftSidebarCollapsed;
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');

  if (state.leftSidebarCollapsed) {
    sidebar.classList.add('collapsed');
    toggleBtn.classList.add('collapsed');
  } else {
    sidebar.classList.remove('collapsed');
    toggleBtn.classList.remove('collapsed');
  }

  // Trigger graph resize after sidebar animation completes
  requestAnimationFrame(() => {
    setTimeout(() => {
      if (state.svg) {
        const c = document.getElementById('main');
        state.svg.attr('viewBox', [0, 0, c.clientWidth, c.clientHeight]);
      }
    }, 280);
  });
}

// Toggle right sidebar (Agent Logs)
function toggleRightSidebar() {
  state.rightSidebarCollapsed = !state.rightSidebarCollapsed;
  const rightPanel = document.getElementById('right-panel');
  const toggleBtn = document.getElementById('right-panel-toggle');

  if (state.rightSidebarCollapsed) {
    rightPanel.classList.add('collapsed');
    toggleBtn.classList.add('collapsed');
  } else {
    rightPanel.classList.remove('collapsed');
    toggleBtn.classList.remove('collapsed');
  }

  // Trigger graph resize after sidebar animation completes
  requestAnimationFrame(() => {
    setTimeout(() => {
      if (state.svg) {
        const c = document.getElementById('main');
        state.svg.attr('viewBox', [0, 0, c.clientWidth, c.clientHeight]);
      }
    }, 280);
  });
}