// engine.js — 并行层级状态机（正交区域）确定性回放引擎
// 纯 ESM，无第三方依赖，浏览器与 Node 共用。
//
// 模型（JSON）：
// {
//   name: string,
//   regions: [ { id, name, initialStateId } ],        // 根区域，1..4 个；1 个即非正交机器
//   states:  [ { id, name, parentId, regionId,
//                kind: 'atomic'|'composite'|'orthogonal',
//                initialChildId?,        // composite 必填
//                regions?: [ {id,name,initialStateId} ] } ], // orthogonal 必填，2..4
//   events:  [ string ],                              // 至多 32 个外部事件（文档顺序=到达顺序）
//   transitions: [ { id, event, priority(小者优先, 全局唯一),
//                     sourceId(null=根), targetId(null=根) } ]
// }

export const LIMITS = Object.freeze({
  MAX_STATES: 24,
  MAX_EVENTS: 32,
  MAX_REGIONS_TOTAL: 4,
  MAX_NESTING: 2 // 嵌套层数 = 状态深度 - 1（顶层状态位于区域内，不计入嵌套）
});

function indexModel(m) {
  const states = new Map();
  const stateOrder = new Map();
  (m.states || []).forEach((s, i) => {
    states.set(s.id, s);
    stateOrder.set(s.id, i);
  });

  const allRegions = []; // {id,name,initialStateId,containerId(null=root),docOrder}
  (m.regions || []).forEach((r) =>
    allRegions.push({ ...r, containerId: null })
  );
  for (const s of m.states || []) {
    for (const r of s.regions || []) {
      allRegions.push({ ...r, containerId: s.id });
    }
  }
  const regions = new Map();
  const regionOrder = new Map();
  allRegions.forEach((r, i) => {
    regions.set(r.id, r);
    regionOrder.set(r.id, i);
  });

  const transitions = (m.transitions || []).map((t, i) => ({ ...t, _doc: i }));
  const transById = new Map(transitions.map((t) => [t.id, t]));

  return { m, states, stateOrder, regions, regionOrder, allRegions, transitions, transById };
}

function statePath(idx, sid) {
  // 自根向下的状态 id 链（不含虚拟根 null）
  const path = [];
  let cur = sid;
  const guard = new Set();
  while (cur != null) {
    if (guard.has(cur)) throw new Error(`状态层级存在环: ${cur}`);
    guard.add(cur);
    path.push(cur);
    const s = idx.states.get(cur);
    if (!s) throw new Error(`引用了不存在的状态: ${cur}`);
    cur = s.parentId ?? null;
  }
  return path.reverse();
}

function lca(idx, a, b) {
  if (a == null && b == null) return null;
  const pa = a == null ? [] : statePath(idx, a);
  const pb = b == null ? [] : statePath(idx, b);
  let common = null;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) break;
    common = pa[i];
  }
  return common; // null 表示虚拟根
}

// 判断 sourceId -> targetId 是否跨越正交区域边界。
// 返回 null 表示合法，否则返回冲突描述。
function crossingBoundary(idx, sourceId, targetId) {
  if (sourceId == null) {
    // 根迁移只允许以根为目标（整体复位）
    if (targetId != null) {
      return '根（父）状态迁移只允许以根自身为目标执行整体复位，不能直接指向某区域内状态';
    }
    return null;
  }
  const ps = statePath(idx, sourceId);
  const pt = statePath(idx, targetId);
  let i = 0;
  while (i < Math.min(ps.length, pt.length) && ps[i] === pt[i]) i++;
  if (i === ps.length || i === pt.length) return null; // 祖先↔后代，合法
  // 在第 i 层分叉：ps[i-1] 是共同容器（可能为虚拟根）
  const container = i === 0 ? null : ps[i - 1];
  const inRegionA = idx.states.get(ps[i]).regionId;
  const inRegionB = idx.states.get(pt[i]).regionId;
  const rootOrthogonal = (idx.m.regions || []).length > 1;
  const containerIsOrtho =
    container == null ? rootOrthogonal : idx.states.get(container).kind === 'orthogonal';
  if (containerIsOrtho && inRegionA !== inRegionB) {
    return `目标跨越并行区域边界（${inRegionA} → ${inRegionB}）：迁移不得直接穿越“${
      container == null ? '根' : container
    }”的两个并行区域`;
  }
  return null;
}

// 某状态当前是否活动（自身是活动叶或其后代存在活动叶）
function isActive(idx, leaves, sid) {
  if (sid == null) return true;
  for (const leaf of leaves) {
    if (leaf === sid || statePath(idx, leaf).includes(sid)) return true;
  }
  return false;
}

// 从给定已进入状态沿初始后代下行，返回 { entered:[...], leaves:[...] }
function initialDescent(idx, sid) {
  const entered = [];
  const leaves = [];
  const walk = (id) => {
    const s = idx.states.get(id);
    if (s.kind === 'atomic') {
      leaves.push(id);
      return;
    }
    if (s.kind === 'composite') {
      if (!s.initialChildId) throw new Error(`复合状态 ${id} 未声明初始子状态`);
      entered.push(s.initialChildId);
      walk(s.initialChildId);
      return;
    }
    // orthogonal：按文档顺序进入每个区域的初始状态
    for (const r of s.regions || []) {
      if (!r.initialStateId) throw new Error(`区域 ${r.id} 未声明初始状态`);
      entered.push(r.initialStateId);
      walk(r.initialStateId);
    }
  };
  walk(sid);
  return { entered, leaves };
}

// 根进入：按文档顺序进入每个根区域初始状态
function enterRoot(idx) {
  const entered = [];
  const leaves = [];
  for (const r of idx.m.regions || []) {
    if (!r.initialStateId) throw new Error(`根区域 ${r.id} 未声明初始状态`);
    entered.push(r.initialStateId);
    const d = initialDescent(idx, r.initialStateId);
    entered.push(...d.entered);
    leaves.push(...d.leaves);
  }
  return { entered, leaves };
}

// 稳定配置校验：每个已激活区域恰有一个活动顶点；返回区域活动映射
function regionSnapshot(idx, leaves) {
  const snap = [];
  for (const r of idx.allRegions) {
    // 容器活动时该区域才需要活动顶点
    if (r.containerId != null && !isActive(idx, leaves, r.containerId)) continue;
    // 直接位于该区域内的活动状态：叶本身，或叶在该区域内某复合状态之下
    const activeHere = [];
    for (const leaf of leaves) {
      const path = statePath(idx, leaf);
      // 找 leaf 祖先链中“直接归属该区域”的那个状态（parentId 为容器且 regionId 匹配）
      for (let k = path.length - 1; k >= 0; k--) {
        const st = idx.states.get(path[k]);
        if ((st.parentId ?? null) === r.containerId && st.regionId === r.id) {
          if (!activeHere.includes(path[k])) activeHere.push(path[k]);
          break;
        }
      }
    }
    // 该区域活动顶点之下的终端活动叶（可能位于嵌套区域内）
    const activeLeavesHere = leaves.filter((leaf) => {
      const path = statePath(idx, leaf);
      return path.some((id) => activeHere.includes(id));
    });
    snap.push({
      regionId: r.id,
      regionName: r.name,
      containerId: r.containerId,
      activeStateId: activeHere.length === 1 ? activeHere[0] : null,
      activeStateIds: activeHere,
      activeLeafIds: activeLeavesHere,
      docOrder: idx.regionOrder.get(r.id)
    });
  }
  snap.sort((a, b) => a.docOrder - b.docOrder);
  return snap;
}

function assertStable(idx, leaves) {
  const snap = regionSnapshot(idx, leaves);
  for (const row of snap) {
    if (row.activeStateIds.length === 0) {
      return `区域 ${row.regionId} 没有活动状态，无法形成每区域一个活动分支`;
    }
    if (row.activeStateIds.length > 1) {
      return `区域 ${row.regionId} 存在多个活动状态 ${row.activeStateIds.join(
        ', '
      )}，无法形成每区域一个活动叶`;
    }
  }
  return null;
}

/* ----------------------------- 模型校验 ----------------------------- */

export function validateModel(raw) {
  const errors = [];
  const push = (code, message, ref = null) => errors.push({ code, message, ref });

  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: [{ code: 'MODEL', message: '模型必须是对象' }] };
  }
  const m = raw;
  if (!Array.isArray(m.regions) || m.regions.length < 1) {
    push('REGIONS', '至少声明一个根区域');
  }
  if (Array.isArray(m.regions) && m.regions.length > LIMITS.MAX_REGIONS_TOTAL) {
    push('REGIONS', `根区域不得超过 ${LIMITS.MAX_REGIONS_TOTAL} 个`);
  }
  const states = Array.isArray(m.states) ? m.states : [];
  if (states.length > LIMITS.MAX_STATES) {
    push('STATES', `状态数 ${states.length} 超过上限 ${LIMITS.MAX_STATES}`);
  }
  const events = Array.isArray(m.events) ? m.events : [];
  if (events.length > LIMITS.MAX_EVENTS) {
    push('EVENTS', `外部事件数 ${events.length} 超过上限 ${LIMITS.MAX_EVENTS}`);
  }

  const ids = new Set();
  for (const s of states) {
    if (!s || typeof s.id !== 'string' || !s.id) {
      push('STATE_ID', '存在缺少 id 的状态');
      continue;
    }
    if (ids.has(s.id)) push('DUP_ID', `状态/区域 id 重复: ${s.id}`, s.id);
    ids.add(s.id);
  }
  const regionIds = new Set();
  const collectRegion = (r, containerLabel) => {
    if (!r || typeof r.id !== 'string' || !r.id) {
      push('REGION_ID', `${containerLabel} 下存在缺少 id 的区域`);
      return;
    }
    if (regionIds.has(r.id) || ids.has(r.id)) {
      push('DUP_ID', `区域 id 重复: ${r.id}`, r.id);
    }
    regionIds.add(r.id);
    if (!r.initialStateId) {
      push('INITIAL', `区域 ${r.id} 必须声明初始状态`, r.id);
    }
  };
  (m.regions || []).forEach((r) => collectRegion(r, '根'));

  let totalRegions = (m.regions || []).length;
  for (const s of states) {
    if (!s || !s.id) continue;
    if (s.kind === 'orthogonal') {
      if (!Array.isArray(s.regions) || s.regions.length < 2) {
        push('ORTHO', `正交状态 ${s.id} 至少需要 2 个区域`, s.id);
      }
      for (const r of s.regions || []) collectRegion(r, `状态 ${s.id}`);
      totalRegions += (s.regions || []).length;
    } else if (s.kind === 'composite') {
      if (!s.initialChildId) {
        push('INITIAL', `复合状态 ${s.id} 必须声明初始子状态`, s.id);
      }
    }
    if (!['atomic', 'composite', 'orthogonal'].includes(s.kind)) {
      push('KIND', `状态 ${s.id} 的 kind 非法`, s.id);
    }
  }
  if (totalRegions > LIMITS.MAX_REGIONS_TOTAL) {
    push('REGIONS', `并行区域总数 ${totalRegions} 超过上限 ${LIMITS.MAX_REGIONS_TOTAL}`);
  }

  // 结构性检查需要可用索引；id 问题太多时放弃后续
  let idx = null;
  try {
    idx = indexModel(m);
  } catch (e) {
    push('MODEL', e.message);
    return { ok: false, errors };
  }

  // 父子关系 / 深度 / 区域归属
  for (const s of states) {
    if (!s || !s.id) continue;
    if (s.parentId != null) {
      const p = idx.states.get(s.parentId);
      if (!p) {
        push('PARENT', `状态 ${s.id} 的父状态 ${s.parentId} 不存在`, s.id);
        continue;
      }
      const depth = statePath(idx, s.id).length;
      if (depth - 1 > LIMITS.MAX_NESTING) {
        push('DEPTH', `状态 ${s.id} 嵌套层数为 ${depth - 1}，超过两层上限`, s.id);
      }
      if (p.kind === 'orthogonal') {
        if (!s.regionId || !idx.regions.has(s.regionId)) {
          push('REGION', `状态 ${s.id} 必须归属于父正交状态 ${p.id} 的某个区域`, s.id);
        } else {
          const belongs = (p.regions || []).some((r) => r.id === s.regionId);
          if (!belongs) push('REGION', `状态 ${s.id} 的区域 ${s.regionId} 不属于父状态 ${p.id}`, s.id);
        }
      } else if (p.kind === 'composite') {
        if (s.regionId != null && s.regionId !== p.regionId) {
          push('REGION', `复合状态 ${p.id} 的子状态 ${s.id} 区域归属不一致`, s.id);
        }
      } else {
        push('PARENT', `原子状态 ${p.id} 不能拥有子状态 ${s.id}`, s.id);
      }
      // 处于第二层嵌套（深度 3）的状态不得再容纳子状态
      if (depth - 1 >= LIMITS.MAX_NESTING && (s.kind === 'composite' || s.kind === 'orthogonal')) {
        push('DEPTH', `第 ${depth - 1} 层嵌套状态 ${s.id} 不允许再嵌套子状态（两层上限）`, s.id);
      }
    } else {
      if (!s.regionId || !idx.regions.has(s.regionId)) {
        push('REGION', `顶层状态 ${s.id} 必须归属于某个根区域`, s.id);
      } else if (!(m.regions || []).some((r) => r.id === s.regionId)) {
        push('REGION', `顶层状态 ${s.id} 的区域 ${s.regionId} 不是根区域`, s.id);
      }
    }
  }

  // 初始指针必须指向对应容器内的直接子状态
  for (const r of idx.allRegions) {
    if (!r.initialStateId) continue;
    const init = idx.states.get(r.initialStateId);
    if (!init) {
      push('INITIAL', `区域 ${r.id} 的初始状态 ${r.initialStateId} 不存在`, r.id);
      continue;
    }
    if ((init.parentId ?? null) !== r.containerId || init.regionId !== r.id) {
      push('INITIAL', `区域 ${r.id} 的初始状态 ${init.id} 不是该区域内的直接子状态`, r.id);
    }
  }
  for (const s of states) {
    if (s.kind === 'composite' && s.initialChildId) {
      const c = idx.states.get(s.initialChildId);
      if (!c) {
        push('INITIAL', `复合状态 ${s.id} 的初始子状态 ${s.initialChildId} 不存在`, s.id);
      } else if ((c.parentId ?? null) !== s.id) {
        push('INITIAL', `复合状态 ${s.id} 的初始子状态 ${c.id} 不是其直接子状态`, s.id);
      }
    }
  }

  // 事件
  const evSet = new Set();
  for (const e of events) {
    if (typeof e !== 'string' || !e.trim()) push('EVENTS', '存在空事件名');
    if (evSet.has(e)) push('EVENTS', `事件重复: ${e}`, e);
    evSet.add(e);
  }

  // 迁移
  const trans = Array.isArray(m.transitions) ? m.transitions : [];
  const tIds = new Set();
  for (const t of trans) {
    if (!t || typeof t.id !== 'string' || !t.id) {
      push('TRANSITION', '存在缺少 id 的迁移');
      continue;
    }
    if (tIds.has(t.id)) push('DUP_ID', `迁移 id 重复: ${t.id}`, t.id);
    tIds.add(t.id);
    if (!evSet.has(t.event)) push('TRANSITION', `迁移 ${t.id} 的触发事件 ${t.event} 未在事件表中声明`, t.id);
    if (t.sourceId != null && !idx.states.has(t.sourceId)) {
      push('TRANSITION', `迁移 ${t.id} 的源状态 ${t.sourceId} 不存在`, t.id);
    }
    if (t.targetId != null && !idx.states.has(t.targetId)) {
      push('TRANSITION', `迁移 ${t.id} 的目标状态 ${t.targetId} 不存在`, t.id);
    }
    // 优先级为整数；“唯一优先级”在事件仲裁时强制：
    // 同优先级且退出集合相交的迁移构成冲突，回放至该事件时拒绝（见 step 仲裁）。
    if (!Number.isInteger(t.priority)) {
      push('TRANSITION', `迁移 ${t.id} 必须携带整数优先级`, t.id);
    }
  }

  if (errors.length) return { ok: false, errors };

  // 初始稳定配置必须可达且每区域一个活动分支
  let initial;
  try {
    initial = enterRoot(idx);
  } catch (e) {
    push('INITIAL_CONFIG', e.message);
    return { ok: false, errors };
  }
  const unstable = assertStable(idx, initial.leaves);
  if (unstable) push('INITIAL_CONFIG', unstable);
  if (errors.length) return { ok: false, errors };

  return { ok: true, idx, initial };
}

/* ----------------------------- 单步推演 ----------------------------- */

// 退出锚点：普通迁移为 source/target 的最近公共祖先；
// 自迁移（source === target）须退出并重新进入源状态本身，锚点上移到其父（或根）。
function exitAnchor(idx, t) {
  if (t.sourceId != null && t.sourceId === t.targetId) {
    const s = idx.states.get(t.sourceId);
    return s.parentId ?? null;
  }
  return lca(idx, t.sourceId, t.targetId);
}

function exitStateSet(idx, leaves, t) {
  // 迁移将退出的全部状态（含中间复合状态，不含退出锚点本身）
  const ancestor = t.sourceId;
  const affectedLeaves =
    ancestor == null ? [...leaves] : leaves.filter((l) => l === ancestor || statePath(idx, l).includes(ancestor));
  const set = new Set();
  const anchor = exitAnchor(idx, t);
  for (const leaf of affectedLeaves) {
    const path = statePath(idx, leaf); // 自上而下
    const ai = anchor == null ? -1 : path.indexOf(anchor);
    for (let k = ai + 1; k < path.length; k++) set.add(path[k]);
  }
  return [...set];
}

export function initialConfiguration(model) {
  const v = validateModel(model);
  if (!v.ok) {
    const err = new Error('模型校验失败');
    err.errors = v.errors;
    throw err;
  }
  return { leaves: v.initial.leaves, entered: v.initial.entered, regions: regionSnapshot(v.idx, v.initial.leaves) };
}

// 单步：输入当前叶集合与事件，返回证据；冲突/越界时 { ok:false, code,message }
function step(idx, leaves, event, eventIndex) {
  const candidates = idx.transitions
    .filter((t) => t.event === event)
    .filter((t) => isActive(idx, leaves, t.sourceId))
    .map((t) => ({
      transitionId: t.id,
      sourceId: t.sourceId,
      targetId: t.targetId,
      priority: t.priority,
      docOrder: t._doc,
      exitSet: exitStateSet(idx, leaves, t)
    }));

  const arbitration = [];
  const accepted = [];
  const acceptedExitUnion = new Set();

  // 边界检查（按文档顺序，定位首个事件即整体回放的首个失败事件）
  for (const c of [...candidates].sort((a, b) => a.docOrder - b.docOrder)) {
    const t = idx.transById.get(c.transitionId);
    const bad = crossingBoundary(idx, t.sourceId, t.targetId);
    if (bad) {
      return {
        ok: false,
        code: 'CROSS_REGION_TARGET',
        eventIndex,
        event,
        message: `迁移 ${t.id}（${t.event}）${bad}`,
        candidates,
        arbitration
      };
    }
  }

  // 优先级裁决：优先级数值小者优先；退出集合相交不可并行
  const ordered = [...candidates].sort((a, b) =>
    a.priority !== b.priority ? a.priority - b.priority : a.docOrder - b.docOrder
  );
  for (const c of ordered) {
    const hit = c.exitSet.find((s) => acceptedExitUnion.has(s));
    if (hit != null) {
      const owner = accepted.find((a) => a.exitSet.includes(hit));
      if (owner && owner.priority === c.priority) {
        return {
          ok: false,
          code: 'SAME_PRIORITY_CONFLICT',
          eventIndex,
          event,
          message: `迁移 ${c.transitionId} 与 ${owner.transitionId} 在事件 ${event} 下退出集合相交且同优先级 ${c.priority}，冲突无法裁决`,
          conflictAt: hit,
          candidates,
          arbitration
        };
      }
      arbitration.push({
        transitionId: c.transitionId,
        selected: false,
        preemptedBy: owner ? owner.transitionId : null,
        reason: `退出集合与已选中迁移在状态 ${hit} 相交，优先级 ${c.priority} 低于 ${
          owner ? owner.priority : '?'
        }，让出`
      });
      continue;
    }
    accepted.push(c);
    c.exitSet.forEach((s) => acceptedExitUnion.add(s));
    arbitration.push({ transitionId: c.transitionId, selected: true });
  }

  // 无匹配迁移：稳定配置不变
  if (accepted.length === 0) {
    return {
      ok: true,
      eventIndex,
      event,
      configBefore: [...leaves],
      candidates,
      arbitration,
      selected: [],
      exits: [],
      entries: [],
      configAfter: [...leaves],
      regions: regionSnapshot(idx, leaves),
      stable: true
    };
  }

  // 退出序列：每个选中迁移退出至各自 LCA（不含 LCA/根）；深者先退，去重保序
  const exitOrder = [];
  const exitSeen = new Set();
  for (const c of [...accepted].sort((a, b) =>
    a.priority !== b.priority ? a.priority - b.priority : a.docOrder - b.docOrder
  )) {
    const anchor = exitAnchor(idx, idx.transById.get(c.transitionId));
    const depthOf = (id) => statePath(idx, id).length;
    const ids = c.exitSet
      .filter((s) => s !== anchor)
      .sort((a, b) =>
        depthOf(b) !== depthOf(a)
          ? depthOf(b) - depthOf(a)
          : idx.stateOrder.get(a) - idx.stateOrder.get(b)
      );
    for (const id of ids) {
      if (!exitSeen.has(id)) {
        exitSeen.add(id);
        exitOrder.push(id);
      }
    }
  }

  // 进入序列：按迁移文档顺序，自 LCA 之下进入目标，再沿初始后代下行
  const entryOrder = [];
  let newLeaves = leaves.filter((l) => !exitSeen.has(l));
  for (const c of [...accepted].sort((a, b) => a.docOrder - b.docOrder)) {
    const t = idx.transById.get(c.transitionId);
    if (t.sourceId == null && t.targetId == null) {
      // 根复位：全部已退出，按根启动进入
      const root = enterRoot(idx);
      for (const id of root.entered) if (!entryOrder.includes(id)) entryOrder.push(id);
      newLeaves = root.leaves;
      continue;
    }
    const anchor = exitAnchor(idx, t);
    const targetPath = statePath(idx, t.targetId);
    const startAt = anchor == null ? 0 : targetPath.indexOf(anchor) + 1;
    const pathDown = targetPath.slice(startAt);
    for (const id of pathDown) {
      if (!entryOrder.includes(id)) entryOrder.push(id);
    }
    const d = initialDescent(idx, t.targetId);
    for (const id of d.entered) if (!entryOrder.includes(id)) entryOrder.push(id);
    newLeaves.push(...d.leaves);
  }

  const uniqueLeaves = [...new Set(newLeaves)];
  const unstable = assertStable(idx, uniqueLeaves);
  if (unstable) {
    return {
      ok: false,
      code: 'UNSTABLE_CONFIG',
      eventIndex,
      event,
      message: `事件 ${event} 后${unstable}`,
      candidates,
      arbitration,
      exits: exitOrder,
      entries: entryOrder
    };
  }

  return {
    ok: true,
    eventIndex,
    event,
    configBefore: [...leaves],
    candidates,
    arbitration,
    selected: [...accepted].sort((a, b) => a.docOrder - b.docOrder).map((c) => c.transitionId),
    exits: exitOrder,
    entries: entryOrder,
    configAfter: uniqueLeaves,
    regions: regionSnapshot(idx, uniqueLeaves),
    stable: true
  };
}

/* ----------------------------- 回放 ----------------------------- */

export function replay(model, eventSequence) {
  const v = validateModel(model);
  if (!v.ok) {
    return { ok: false, stage: 'VALIDATION', errors: v.errors, evidence: [] };
  }
  const idx = v.idx;
  const init = {
    entered: v.initial.entered,
    regions: regionSnapshot(idx, v.initial.leaves)
  };
  const evidence = [];
  let leaves = [...v.initial.leaves];

  if (!Array.isArray(eventSequence)) {
    return { ok: false, stage: 'INPUT', errors: [{ code: 'INPUT', message: '事件序列必须是数组' }], evidence };
  }

  for (let i = 0; i < eventSequence.length; i++) {
    const event = eventSequence[i];
    if (!((model.events || []).includes(event))) {
      return {
        ok: false,
        stage: 'REPLAY',
        code: 'UNKNOWN_EVENT',
        eventIndex: i,
        event,
        message: `第 ${i + 1} 个事件 ${event} 未在事件表中声明`,
        initial: init,
        evidence
      };
    }
    const r = step(idx, leaves, event, i);
    evidence.push(r);
    if (!r.ok) {
      return {
        ok: false,
        stage: 'REPLAY',
        code: r.code,
        eventIndex: i,
        event: r.event,
        message: r.message,
        initial: init,
        evidence
      };
    }
    leaves = r.configAfter;
  }

  return {
    ok: true,
    initial: init,
    finalLeaves: leaves,
    finalRegions: regionSnapshot(idx, leaves),
    evidence
  };
}

export { indexModel, regionSnapshot, statePath };
