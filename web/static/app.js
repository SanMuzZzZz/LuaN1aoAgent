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
let state = { op_id: new URLSearchParams(location.search).get('op_id') || '', view: 'exec', simulation: null, svg: null, g: null, zoom: null, es: null, processedEvents: new Set(), pendingReq: null, isModifyMode: false };
const api = (p, b) => fetch(p + (p.includes('?')?'&':'?') + `op_id=${state.op_id}`, b ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{}).then(r=>r.json());

document.addEventListener('DOMContentLoaded', () => {
  initD3();
  loadOps().then(() => { if(!state.op_id) { const f = document.querySelector('.task-card'); if(f) selectOp(f.dataset.op); } else selectOp(state.op_id, false); });
  setInterval(checkPendingIntervention, 2000);
});

async function loadOps() {
  try {
    const data = await fetch('/api/ops').then(r=>r.json());
    const list = document.getElementById('ops'); list.innerHTML = '';
    data.items.forEach(i => {
      const li = document.createElement('li'); li.className = `task-card ${i.op_id === state.op_id ? 'active' : ''}`; li.dataset.op = i.op_id; li.onclick = () => selectOp(i.op_id);
      const color = i.status.achieved ? 'var(--success)' : (i.status.failed ? 'var(--error)' : 'var(--accent-primary)');
      li.innerHTML = `<div class="flex justify-between mb-1"><span style="font-family:monospace;font-size:10px;opacity:0.7">#${i.op_id.slice(-4)}</span><span class="status-dot" style="background:${color}"></span></div><div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${i.goal}</div>`;
      list.appendChild(li);
    });
  } catch(e) {}
}

function selectOp(id, refresh=true) {
  if(!id) return; state.op_id = id;
  document.querySelectorAll('.task-card').forEach(el => el.classList.toggle('active', el.dataset.op === id));
  history.replaceState(null, '', `?op_id=${id}`);
  document.getElementById('llm-stream').innerHTML = '';
  document.getElementById('node-detail-content').innerHTML = '<div style="padding:20px;text-align:center;color:#64748b">Loading...</div>';
  closeDetails();
  if(state.es) state.es.close(); subscribe(); render(); if(refresh) loadOps();
}

async function render(force) {
  if(!state.op_id) return;
  try {
    let data;
    if(state.view === 'exec') data = await api('/api/graph/execution');
    else if(state.view === 'causal') data = await api('/api/graph/causal');
    drawForceGraph(data);
    updateLegend();
  } catch(e) { console.error(e); }
}

function switchView(v) { state.view = v; document.querySelectorAll('#topbar .btn[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v)); render(); }

function initD3() {
  const c = document.getElementById('main');
  state.svg = d3.select('#d3-graph').attr('viewBox', [0, 0, c.clientWidth, c.clientHeight]);
  state.g = state.svg.append('g');
  state.zoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', e => state.g.attr('transform', e.transform));
  state.svg.call(state.zoom);
  state.svg.append("defs").append("marker").attr("id","arrow").attr("viewBox","0 -5 10 10").attr("refX",22).attr("refY",0).attr("markerWidth",6).attr("markerHeight",6).attr("orient","auto").append("path").attr("d","M0,-5L10,0L0,5").attr("fill","#475569");
}

function drawForceGraph(data) {
  const svg = state.svg;
  state.g.selectAll("*").remove(); // 清除旧图
  
  const g = state.g;

  // 1. 数据转换与 Dagre 图构建
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setGraph({ 
      rankdir: 'TB',  // Top-to-Bottom 布局 (更像攻击图/树)
      align: undefined,    // 不设置对齐方式，让算法自动平衡
      nodesep: 40,    // 同层节点水平间距（适当增加以改善可读性）
      ranksep: 80,    // 层级间垂直间距（增大以拉长纵向）
      marginx: 40, 
      marginy: 40,
      ranker: 'network-simplex'  // 使用网络单纯形算法，更好地平衡布局
  });

  // 添加节点 (根据节点类型设置不同尺寸)
  if (!data || !data.nodes) return;

  data.nodes.forEach(node => {
      // 根据节点类型设置不同的宽度
      let width, height;
      if (node.type === 'root') {
          width = 200;   // 主任务：最宽
          height = 60;
      } else if (node.type === 'task') {
          width = 180;   // 子任务：标准宽度
          height = 60;
      } else if (node.type === 'action') {
          width = 120;   // 动作节点：较窄
          height = 50;   // 稍矮一些
      } else {
          width = 160;   // 其他类型：中等宽度
          height = 55;
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
      .attr("marker-end", d => {
          // 不要在连线上添加箭头，保持简洁
          return null;
      });

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
      .on("click", (e,d)=>showDetails(dagreGraph.node(d)));

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
          // 区分 Task 和 Action 的边框色
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
          if (n.type === 'root') return '主任务';
          if (n.type === 'task') return '子任务';
          if (n.type === 'action') return '动作';
          return 'NODE';
      });

  // 节点文字 (使用节点名称/描述)
  nodes.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.3em")
      .attr("fill", "#fff")
      .style("font-weight", "bold")
      .style("font-size", "11px")
      .each(function(d) {
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
  nodes.on("mouseenter", function(event, d) {
      const nodeId = d;
      // 找出前驱和后继
      const predecessors = dagreGraph.predecessors(nodeId);
      const successors = dagreGraph.successors(nodeId);
      const neighbors = new Set([nodeId, ...predecessors, ...successors]);

      // 变暗所有非相关节点
      nodes.classed("dimmed", n => !neighbors.has(n));
      
      // 变暗所有非相关连线
      links.classed("dimmed", l => !neighbors.has(l.v) || !neighbors.has(l.w));
      
      tippy(this, { content: `<b>${dagreGraph.node(d).type}</b><br>${dagreGraph.node(d).label||d}`, allowHTML:true });
  }).on("mouseleave", function() {
      // 恢复原状
      nodes.classed("dimmed", false);
      links.classed("dimmed", false);
  });
  
  // 自适应缩放和居中
  const graphWidth = dagreGraph.graph().width;
  const graphHeight = dagreGraph.graph().height;
  const svgWidth = state.svg.node().clientWidth || 800;
  const svgHeight = state.svg.node().clientHeight || 600;
  
  // 计算合适的缩放比例，确保图完全可见
  const scaleX = (svgWidth * 0.9) / graphWidth;  // 留10%边距
  const scaleY = (svgHeight * 0.9) / graphHeight;
  const autoScale = Math.min(scaleX, scaleY, 1);  // 不超过1倍，避免放大过度
  
  // 计算居中偏移
  const x = (svgWidth - graphWidth * autoScale) / 2;
  const y = (svgHeight - graphHeight * autoScale) / 2;
  
  // 应用变换
  state.svg.call(state.zoom.transform, d3.zoomIdentity
      .translate(x, y)
      .scale(autoScale));
  
  // 高亮当前执行路径
  highlightActivePath(dagreGraph, data.nodes, nodes, links);
}

function highlightActivePath(dagreGraph, dataNodes, nodeSelection, linkSelection) {
  // 清除之前的高亮
  nodeSelection.classed("path-highlight", false);
  linkSelection.classed("path-highlight", false);
  
  console.log('All nodes:', dataNodes.map(n => ({id: n.id, type: n.type, status: n.status})));
  console.log('All edges in graph:', dagreGraph.edges().map(e => `${e.v} -> ${e.w}`));
  
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
    // 策略：找到从根节点到当前任务路径上的所有动作节点中最新的
    activeTaskNodes.forEach(task => {
      console.log('Processing active task:', task.id);
      
      // 递归收集从根到当前任务的路径上的所有节点
      const pathFromRoot = new Set();
      
      function traceToRoot(nodeId) {
        if (pathFromRoot.has(nodeId)) return;
        pathFromRoot.add(nodeId);
        
        const preds = dagreGraph.predecessors(nodeId);
        if (preds && preds.length > 0) {
          preds.forEach(pred => traceToRoot(pred));
        }
      }
      
      traceToRoot(task.id);
      console.log('  Path from root to task:', Array.from(pathFromRoot));
      
      // 在这条路径上找到所有动作节点
      const actionsInPath = allActionNodes.filter(action => pathFromRoot.has(action.id));
      console.log('  Actions in path:', actionsInPath.map(a => ({id: a.id, status: a.status})));
      
      if (actionsInPath.length > 0) {
        // 找到所有非 pending 状态的动作节点（已执行的）
        const executedActions = actionsInPath.filter(n => 
          n.status === 'completed' || n.status === 'failed'
        );
        
        console.log('  Executed actions:', executedActions.map(a => a.id));
        
        if (executedActions.length > 0) {
          // 在已执行的动作中找到"叶子节点"（没有后继，或后继不在已执行列表中）
          const executedIds = new Set(executedActions.map(a => a.id));
          const leaves = executedActions.filter(action => {
            const successors = dagreGraph.successors(action.id);
            // 没有后继，或者后继都不在已执行的动作中
            return !successors || successors.length === 0 || 
                   !successors.some(succ => executedIds.has(succ));
          });
          
          console.log('  Leaf executed actions:', leaves.map(l => l.id));
          
          if (leaves.length > 0) {
            leafNodes.push(...leaves);
          } else {
            // 如果找不到叶子，用最后一个已执行的
            leafNodes.push(executedActions[executedActions.length - 1]);
          }
        } else {
          // 路径上没有已执行的动作，高亮任务本身
          console.log('  No executed actions, using task itself');
          leafNodes.push(task);
        }
      } else {
        // 路径上没有动作节点，高亮任务本身
        console.log('  No actions in path, using task itself');
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
    
    console.log('Root active, executed actions:', executedActions.map(a => ({id: a.id, status: a.status})));
    
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

function dragstarted(e,d) { if(!e.active) state.simulation.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; }
function dragged(e,d) { d.fx=e.x; d.fy=e.y; }
function dragended(e,d) { if(!e.active) state.simulation.alphaTarget(0); d.fx=null; d.fy=null; }
function zoomIn() { state.svg.transition().call(state.zoom.scaleBy, 1.2); }
function zoomOut() { state.svg.transition().call(state.zoom.scaleBy, 0.8); }
function zoomReset() { state.svg.transition().call(state.zoom.transform, d3.zoomIdentity); }
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
  const c=document.getElementById('node-detail-content'); 
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
                <div class="code-block" style="max-height:300px;overflow-y:auto;">${typeof d.observation === 'object' ? hlJson(d.observation) : d.observation}</div>`;
      }
      
      h += `</div>`;
  }

  // Other Properties
  h += `<div class="detail-section"><div class="detail-header">${t('panel.description')}</div><table class="detail-table">`;
  Object.entries(d).forEach(([k,v])=>{ 
      if(!['x','y','fx','fy','vx','vy','index','children','width','height','tool_name','tool_args','result','observation','action','label','id','type','status','description','original_type'].includes(k)) {
          h+=`<tr><td class="detail-key">${k}</td><td class="detail-val">${typeof v==='object'?JSON.stringify(v,null,2):v}</td></tr>`; 
      }
  });
  h+='</table></div>';
  
  c.innerHTML=h;
  document.getElementById('node-details-panel').classList.add('show');
}

function closeDetails() {
  document.getElementById('node-details-panel').classList.remove('show');
}

function subscribe() {
  state.es = new EventSource(`/api/events?op_id=${state.op_id}`);
  state.es.onmessage = e => {
    try {
        const msg = JSON.parse(e.data);
        
        // 统一处理所有事件
        const eventType = msg.event || 'message';
        
        if(eventType === 'graph.changed' || eventType === 'execution.step.completed') render();
        if(eventType === 'ping' || eventType === 'graph.ready') return;
        
        // 分流渲染
        if(eventType.startsWith('llm.')) {
            renderLLMResponse(msg);
        } else {
            renderSystemEvent(msg);
        }
    } catch(x) { console.error('Parse error', x); }
  };
  fetch(`/api/ops/${state.op_id}/llm-events`).then(r=>r.json()).then(d=>(d.events||[]).forEach(e => {
      if(e.event && e.event.startsWith('llm.')) renderLLMResponse(e); else renderSystemEvent(e);
  }));
}

// 专门处理系统/执行事件 (execution.step.completed, graph.changed, etc)
function renderSystemEvent(msg) {
    const id = (msg.timestamp||0) + '_' + msg.event;
    if(state.processedEvents.has(id)) return;
    state.processedEvents.add(id);

    const container = document.getElementById('llm-stream');
    const div = document.createElement('div');
    div.className = 'system-msg';
    const time = new Date(msg.timestamp ? msg.timestamp * 1000 : Date.now()).toLocaleTimeString();
    let html = `<div class="msg-meta"><span>${msg.event}</span><span>${time}</span></div>`;
    
    const eventType = msg.event;
    const data = msg.data || msg.payload || {};

    // 针对 Tool Execution Completed 的特殊渲染
    if (eventType === 'execution.step.completed') {
        let result = data.result;
        // 尝试解析 result 字符串内部的 JSON
        if (typeof result === 'string') {
            try { result = JSON.parse(result); } catch(e) {}
        }
        
        html += `<div style="color:#a5d6ff;margin-bottom:4px;">Tool: <b>${data.tool_name}</b> (Step: ${data.step_id})</div>`;
        html += `<div class="tool-output">${hlJson(result)}</div>`;
    } 
    // 针对 Graph Changed
    else if (eventType === 'graph.changed') {
        if (data.reason === 'confidence_update') {
            html += `<div style="color:#fbbf24;font-weight:bold;">📈 Confidence Update</div>`;
            html += `<div style="color:#94a3b8">${data.message || 'No details'}</div>`;
        } else {
            html += `<div style="color:#94a3b8">Graph updated: ${data.reason || 'Unknown reason'}</div>`;
        }
    }
    // 针对 Intervention
    else if (eventType === 'intervention.required') {
        html += `<div style="color:#f59e0b;font-weight:bold;">⚠ Intervention Required</div>`;
    }
    // 兜底通用渲染
    else {
        html += `<div class="raw-data-content">${hlJson(data)}</div>`;
    }
    
    div.innerHTML = html;
    const shouldScroll = Math.abs(container.scrollHeight - container.clientHeight - container.scrollTop) < 50;
    container.appendChild(div);
    if(shouldScroll) container.scrollTop = container.scrollHeight;
}

// 专门处理 LLM 响应
function renderLLMResponse(msg) {
  const id = (msg.timestamp||Date.now()) + '_' + msg.event; 
  if(state.processedEvents.has(id)) return; 
  state.processedEvents.add(id);
  
  if (msg.event && msg.event.includes('request')) return;
  
  const container = document.getElementById('llm-stream');
  const div = document.createElement('div');
  div.className = `llm-msg assistant`;
  
  let content = msg.data || msg.payload;
  if (typeof content === 'string') { try { content = JSON.parse(content); } catch(e){} }
  if (content && content.content) content = content.content;
  if (typeof content === 'string' && (content.trim().startsWith('{') || content.trim().startsWith('['))) {
      try { content = JSON.parse(content); } catch(e){}
  }
  
  let htmlContent = '';
  
  if (typeof content === 'object' && content !== null) {
      let remaining = { ...content };
      
      // 1. Thought
      if (remaining.thought) {
          htmlContent += `<div class="thought-card"><div class="thought-header"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>Thinking Process</div>`;
          if (typeof remaining.thought === 'object') {
              for (const [key, val] of Object.entries(remaining.thought)) {
                   if (typeof val === 'string') htmlContent += `<div class="thought-item"><span class="thought-key">${key.replace(/_/g,' ')}</span><div class="thought-val">${val}</div></div>`;
              }
          } else {
              htmlContent += `<div class="thought-val">${remaining.thought}</div>`;
          }
          htmlContent += `</div>`;
          delete remaining.thought;
      }
      
      // 2. Reflector/Audit
      if (remaining.audit_result) {
          htmlContent += `<div class="thought-card" style="border-color:#ec4899;"><div class="thought-header audit-header"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>Reflector Audit</div>`;
          const audit = remaining.audit_result;
          htmlContent += `<div class="audit-badge" style="background:${audit.status==='passed'?'#10b981':'#f59e0b'}">Status: ${audit.status.toUpperCase()}</div>`;
          htmlContent += `<div style="font-size:12px;margin-bottom:8px;">${audit.completion_check}</div>`;
          if (audit.logic_issues && audit.logic_issues.length > 0) {
              htmlContent += `<div class="audit-issues">`;
              audit.logic_issues.forEach(issue => { htmlContent += `<div class="audit-issue-item">⚠ ${issue}</div>`; });
              htmlContent += `</div>`;
          }
          htmlContent += `</div>`;
          delete remaining.audit_result;
      }

      if (remaining.attack_intelligence) {
          const intel = remaining.attack_intelligence;
          if (intel.actionable_insights && intel.actionable_insights.length > 0) {
              htmlContent += `<div class="thought-card"><div class="thought-header" style="color:#a855f7">Actionable Insights</div><ul style="padding-left:16px;font-size:12px;color:#e2e8f0;list-style:disc">`;
              intel.actionable_insights.forEach(item => { htmlContent += `<li>${item}</li>`; });
              htmlContent += `</ul></div>`;
          }
          delete remaining.attack_intelligence;
      }

      if (remaining.key_findings) {
          htmlContent += `<div class="thought-card"><div class="thought-header" style="color:#f59e0b">Key Findings</div><div class="op-list">`;
          remaining.key_findings.forEach(f => {
              htmlContent += `<div class="op-card-inner"><div class="op-desc" style="color:#fbbf24">${f.title}</div><div style="font-size:11px;color:#94a3b8">${f.description}</div></div>`;
          });
          htmlContent += `</div></div>`;
          delete remaining.key_findings;
      }
      delete remaining.key_facts;
      delete remaining.causal_graph_updates;

      // 3. Graph Operations
      if (remaining.graph_operations && Array.isArray(remaining.graph_operations)) {
          htmlContent += `<div class="thought-header" style="margin-top:10px;"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>Graph Actions</div><div class="op-list">`;
          remaining.graph_operations.forEach(op => {
              const nodeData = op.node_data || {};
              htmlContent += `<div class="op-card-inner"><div class="op-badge">${op.command}</div><div style="flex:1"><div class="op-id">${nodeData.id || '-'}</div><div class="op-desc">${nodeData.description || (op.updates ? JSON.stringify(op.updates) : '')}</div></div></div>`;
          });
          htmlContent += `</div>`;
          delete remaining.graph_operations;
      }

      // 4. Execution Operations
      if (remaining.execution_operations && Array.isArray(remaining.execution_operations)) {
          htmlContent += `<div class="thought-header" style="margin-top:10px; color:#f59e0b;"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>Execution Actions</div><div class="op-list">`;
          remaining.execution_operations.forEach(op => {
              const params = op.action && op.action.params ? JSON.stringify(op.action.params, null, 1) : '';
              const toolName = op.action ? op.action.tool : 'Unknown Tool';
              htmlContent += `<div class="op-card-inner"><div class="op-badge" style="background:rgba(245, 158, 11, 0.2);color:#f59e0b;">${toolName}</div><div style="flex:1"><div class="op-id">${op.node_id}</div><div class="op-desc">${op.thought || ''}</div>${params ? `<div class="op-details">${params}</div>` : ''}</div></div>`;
          });
          htmlContent += `</div>`;
          delete remaining.execution_operations;
      }

      // 5. Hypothesis Update
      if (remaining.hypothesis_update && typeof remaining.hypothesis_update === 'object') {
          htmlContent += `<div class="thought-card" style="border-color:#8b5cf6;"><div class="thought-header" style="color:#8b5cf6;"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.384-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" /></svg>Hypothesis Update</div>`;
          for (const [key, val] of Object.entries(remaining.hypothesis_update)) {
               if(val) htmlContent += `<div class="thought-item"><span class="thought-key">${key.replace(/_/g,' ')}</span><div class="thought-val">${val}</div></div>`;
          }
          htmlContent += `</div>`;
          delete remaining.hypothesis_update;
      }
      
      // 6. Staged Causal Nodes
      if (remaining.staged_causal_nodes && Array.isArray(remaining.staged_causal_nodes) && remaining.staged_causal_nodes.length > 0) {
           htmlContent += `<div class="thought-header" style="margin-top:10px; color:#06b6d4;">New Findings</div><div class="op-list">`;
           remaining.staged_causal_nodes.forEach(node => {
               htmlContent += `<div class="op-card-inner"><div class="op-badge" style="background:rgba(6, 182, 212, 0.2);color:#06b6d4;">${node.type || 'Finding'}</div><div class="op-desc" style="flex:1">${node.description || node.title}</div></div>`;
           });
           htmlContent += `</div>`;
           delete remaining.staged_causal_nodes;
      } else {
           delete remaining.staged_causal_nodes;
      }

      // 7. Render Remaining Specific Keys nicely
      if (Object.keys(remaining).length > 0) {
          htmlContent += `<div class="raw-data-block"><div class="raw-data-header">Status & Other Data</div><div style="display:flex;flex-wrap:wrap;">`;
          
          // Render specific flags as badges
          const flags = ['global_mission_accomplished', 'is_subtask_complete', 'success'];
          flags.forEach(f => {
              if (remaining[f] !== undefined) {
                  const isTrue = remaining[f] === true;
                  htmlContent += `<div class="status-item"><span class="${isTrue?'status-check':'status-cross'}">${isTrue?'✓':'✕'}</span> ${f}</div>`;
                  delete remaining[f];
              }
          });
          htmlContent += `</div>`;
          
          // If anything is STILL left, dump as JSON
          if (Object.keys(remaining).length > 0) {
              htmlContent += `<div class="raw-data-content">${hlJson(JSON.stringify(remaining, null, 2))}</div>`;
          }
          htmlContent += `</div>`;
      }
      
  } else {
      htmlContent = `<div style="white-space:pre-wrap">${content}</div>`;
  }

  div.innerHTML = `<div class="msg-meta"><span>${msg.event}</span><span>${new Date().toLocaleTimeString()}</span></div>${htmlContent}`;
  
  const shouldScroll = Math.abs(container.scrollHeight - container.clientHeight - container.scrollTop) < 50;
  container.appendChild(div); 
  if(shouldScroll) container.scrollTop = container.scrollHeight;
}

function hlJson(s) {
  if(typeof s !== 'string') {
      if(typeof s === 'object') s = JSON.stringify(s, null, 2);
      else s = String(s);
  }
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/("(\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, m => {
    let c = 'json-number';
    if(/^"/.test(m)) c = /:$/.test(m) ? 'json-key' : 'json-string';
    else if(/true|false/.test(m)) c = 'json-boolean';
    return `<span class="${c}">${m}</span>`;
  });
}

async function createTask() { const g=document.getElementById('in-goal').value, t=document.getElementById('in-task').value; if(!g)return; await api('/api/ops',{goal:g,task_name:t}).then(r=>{if(r.ok){loadOps();selectOp(r.op_id)}}); }
async function abortOp() { if(confirm(t('msg.confirm_abort'))) await api(`/api/ops/${state.op_id}/abort`,{}); }

async function checkPendingIntervention() {
  if(!state.op_id) return;
  try {
      const r = await api(`/api/ops/${state.op_id}/intervention/pending`);
      const m = document.getElementById('approval-modal');
      if(r.pending && r.request) {
          if(!state.pendingReq || state.pendingReq.id !== r.request.id) {
              state.pendingReq = r.request; state.isModifyMode = false;
              renderApproval(r.request); m.classList.add('show');
          }
      } else if(state.pendingReq) { m.classList.remove('show'); state.pendingReq = null; }
  } catch(e){}
}

function renderApproval(r) {
  const l=document.getElementById('approval-list'), e=document.getElementById('approval-json-editor'), ea=document.getElementById('approval-edit-area'), b=document.getElementById('btn-modify-mode');
  l.style.display='block'; ea.style.display='none'; b.innerText='Modify'; b.classList.remove('active');
  let h=''; (r.data||[]).forEach(o=>{ h+=`<div class="plan-item"><div class="plan-tag ${o.command}">${o.command}</div><div style="flex:1;font-size:12px;color:#94a3b8"><div style="color:#e2e8f0;font-family:monospace">${o.node_id||(o.node_data?o.node_data.id:'-')}</div>${o.command==='ADD_NODE'?(o.node_data.description||''):''}</div></div>`; });
  l.innerHTML=h; e.value=JSON.stringify(r.data,null,2);
}

function toggleModifyMode() { state.isModifyMode=!state.isModifyMode; const l=document.getElementById('approval-list'), ea=document.getElementById('approval-edit-area'), b=document.getElementById('btn-modify-mode'); if(state.isModifyMode){l.style.display='none';ea.style.display='block';b.innerText='Cancel';b.classList.add('active')}else{l.style.display='block';ea.style.display='none';b.innerText='Modify';b.classList.remove('active')} } 
async function submitDecision(a) { let p={action:a}; if(a==='APPROVE'&&state.isModifyMode) { try{p.modified_data=JSON.parse(document.getElementById('approval-json-editor').value);p.action='MODIFY'}catch(e){return alert('Invalid JSON')} } await api(`/api/ops/${state.op_id}/intervention/decision`,p); document.getElementById('approval-modal').classList.remove('show'); state.pendingReq=null; }

function openInjectModal(){document.getElementById('inject-modal').classList.add('show')}
function closeModals(){document.querySelectorAll('.modal-overlay').forEach(e=>e.classList.remove('show'))}
async function submitInjection(){const d=document.getElementById('inject-desc').value, dp=document.getElementById('inject-deps').value; if(d) await api(`/api/ops/${state.op_id}/inject_task`,{description:d,dependencies:dp?dp.split(','):[]}); closeModals();}

function openMCPModal(){
  document.getElementById('mcp-modal').classList.add('show');
  loadMCPConfig();
}

async function loadMCPConfig(){
  try {
      const data = await api('/api/mcp/config');
      const list = document.getElementById('mcp-list');
      let h = '';
      if(data.mcpServers) {
          Object.entries(data.mcpServers).forEach(([k,v])=>{
              h += `<div class="mb-1 border-b border-slate-700 pb-1">
                      <div class="font-bold text-blue-400">${k}</div>
                      <div class="text-gray-500">${v.command} ${(v.args||[]).join(' ')}</div>
                    </div>`;
          });
      }
      list.innerHTML = h || 'No servers configured.';
  } catch(e){ console.error(e); }
}

async function addMCPServer(){
  const name = document.getElementById('mcp-name').value;
  const cmd = document.getElementById('mcp-cmd').value;
  const argsStr = document.getElementById('mcp-args').value;
  const envStr = document.getElementById('mcp-env').value;
  
  if(!name || !cmd) return alert('Name and command required');
  
  let env = {};
  try {
      if(envStr) env = JSON.parse(envStr);
  } catch(e){ return alert('Invalid JSON for Env'); }
  
  const args = argsStr ? argsStr.split(',').map(s=>s.trim()) : [];
  
  try {
      await api('/api/mcp/add', {name, command: cmd, args, env});
      alert('Server added & reloaded!');
      loadMCPConfig();
      // Clear inputs
      document.getElementById('mcp-name').value='';
      document.getElementById('mcp-cmd').value='';
      document.getElementById('mcp-args').value='';
      document.getElementById('mcp-env').value='';
  } catch(e){ alert('Error: '+e); }
}