/**
 * 并行状态图引擎 —— 轨道应急载荷隔离规程
 *
 * 语义要点：
 *  - 配置（活动状态集合）始终按文档顺序（深度优先先序）规范存储；
 *  - 事件到达时，仅源状态处于配置中的迁移成为候选（即活动状态或其祖先上的迁移）；
 *  - 迁移的退出集合 = 源/目标最近公共祖先（LCA，真祖先）之下的活动真后代；
 *  - 退出集合相交的迁移不可并行：优先级高者胜出；同优先级相交则拒绝本次事件；
 *  - 目标跨越并行区域边界、或执行后无法形成“每区域一个活动叶”的稳定配置 → 拒绝；
 *  - 选中迁移先退出（文档逆序）至各自最近公共祖先，再按文档顺序进入目标及其初始后代；
 *  - 全部遍历基于文档顺序与优先级排序，重复运行产出完全一致的证据。
 */

export const LIMITS = Object.freeze({
  MAX_STATES: 24,          // 至多 24 个状态（不含隐式根）
  MAX_NESTING_DEPTH: 2,    // 顶层状态之下至多再嵌套 2 层
  MAX_PARALLEL_REGIONS: 4, // 全部并行状态的区域总数至多 4
  MAX_EVENTS: 32,          // 至多 32 个外部事件
});

const ROOT = '«root»'; // 隐式根状态哨兵，不出现在任何配置中

/** 模型载入期错误（结构/约束不合法）。 */
export class ModelError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 回放期拒绝（同优先级冲突 / 跨越并行区域 / 无法形成稳定配置）。 */
export class Rejection extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'Rejection';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const KINDS = new Set(['leaf', 'composite', 'parallel']);

/**
 * 载入并校验规程模型，返回不可变的机 machine。
 * model = { states: [{id,label?,kind,parent,initial?}], transitions: [{id,source,target,event,priority}], events: [string] }
 */
export function createMachine(model) {
  if (model === null || typeof model !== 'object' || Array.isArray(model)) {
    throw new ModelError('invalid-model', '规程模型必须是对象');
  }
  const { states, transitions = [], events } = model;

  // ---- 状态数量与基本字段 ----
  if (!Array.isArray(states) || states.length === 0) {
    throw new ModelError('no-states', '至少声明一个状态');
  }
  if (states.length > LIMITS.MAX_STATES) {
    throw new ModelError('too-many-states', `状态数量 ${states.length} 超过上限 ${LIMITS.MAX_STATES}`, { count: states.length });
  }

  const byId = new Map();
  for (const s of states) {
    if (!s || typeof s.id !== 'string' || s.id.trim() === '') {
      throw new ModelError('invalid-state-id', '每个状态必须具有非空字符串 id');
    }
    const id = s.id.trim();
    if (byId.has(id)) throw new ModelError('duplicate-state', `状态 ${id} 重复定义`, { id });
    if (!KINDS.has(s.kind)) {
      throw new ModelError('invalid-kind', `状态 ${id} 的类型 ${JSON.stringify(s.kind)} 非法（应为 leaf/composite/parallel）`, { id });
    }
    byId.set(id, {
      id,
      label: typeof s.label === 'string' && s.label.trim() ? s.label.trim() : id,
      kind: s.kind,
      parent: s.parent ?? null,
      initial: s.initial ?? null,
    });
  }

  // ---- 父引用 ----
  for (const s of byId.values()) {
    if (s.parent !== null) {
      if (typeof s.parent !== 'string' || !byId.has(s.parent.trim())) {
        throw new ModelError('unknown-parent', `状态 ${s.id} 的父状态 ${JSON.stringify(s.parent)} 不存在`, { id: s.id });
      }
      s.parent = s.parent.trim();
    }
  }

  const childrenOf = new Map([...byId.keys()].map((id) => [id, []]));
  const topLevel = [];
  for (const s of byId.values()) {
    if (s.parent === null) topLevel.push(s.id);
    else childrenOf.get(s.parent).push(s.id);
  }
  if (topLevel.length === 0) throw new ModelError('no-top-level', '缺少顶层状态（parent 为空的状态）');

  // ---- 嵌套层级与环检测（顶层深度 1，允许到 1+MAX_NESTING_DEPTH）----
  const depthOf = new Map();
  const visit = (id, depth, stack) => {
    if (stack.has(id)) throw new ModelError('cycle', `状态 ${id} 的父子关系成环`, { id });
    stack.add(id);
    depthOf.set(id, depth);
    if (depth > 1 + LIMITS.MAX_NESTING_DEPTH) {
      throw new ModelError('nesting-too-deep', `状态 ${id} 的嵌套层级超过 ${LIMITS.MAX_NESTING_DEPTH} 层`, { id });
    }
    for (const c of childrenOf.get(id)) visit(c, depth + 1, stack);
    stack.delete(id);
  };
  for (const t of topLevel) visit(t, 1, new Set());
  for (const id of byId.keys()) {
    if (!depthOf.has(id)) throw new ModelError('cycle', `状态 ${id} 的父子关系成环或不可达`, { id });
  }

  // ---- 结构约束：每个复合状态必须声明初始子状态；并行区域 2..4 且为复合状态 ----
  const parallelStates = [];
  let totalRegions = 0;
  for (const s of byId.values()) {
    const kids = childrenOf.get(s.id);
    if (s.kind === 'leaf') {
      if (kids.length) throw new ModelError('leaf-has-children', `叶状态 ${s.id} 不能有子状态`, { id: s.id });
    } else if (s.kind === 'composite') {
      if (kids.length === 0) throw new ModelError('composite-no-children', `复合状态 ${s.id} 至少需要一个子状态`, { id: s.id });
      if (typeof s.initial !== 'string' || !kids.includes(s.initial.trim())) {
        throw new ModelError('missing-initial', `复合状态 ${s.id} 必须声明初始子状态（且为其直接子状态）`, { id: s.id });
      }
      s.initial = s.initial.trim();
    } else {
      // parallel
      if (kids.length < 2) throw new ModelError('too-few-regions', `并行状态 ${s.id} 至少需要 2 个区域`, { id: s.id });
      if (kids.length > LIMITS.MAX_PARALLEL_REGIONS) {
        throw new ModelError('too-many-regions', `并行状态 ${s.id} 的区域数 ${kids.length} 超过上限 ${LIMITS.MAX_PARALLEL_REGIONS}`, { id: s.id });
      }
      for (const r of kids) {
        if (byId.get(r).kind !== 'composite') {
          throw new ModelError('invalid-region', `并行状态 ${s.id} 的区域 ${r} 必须是复合状态`, { id: s.id, region: r });
        }
      }
      totalRegions += kids.length;
      parallelStates.push(s.id);
    }
  }
  if (totalRegions > LIMITS.MAX_PARALLEL_REGIONS) {
    throw new ModelError('too-many-regions', `并行区域总数 ${totalRegions} 超过上限 ${LIMITS.MAX_PARALLEL_REGIONS}`, { count: totalRegions });
  }

  // ---- 外部事件目录 ----
  if (!Array.isArray(events) || events.length === 0) throw new ModelError('no-events', '至少声明一个外部事件');
  if (events.length > LIMITS.MAX_EVENTS) {
    throw new ModelError('too-many-events', `外部事件数量 ${events.length} 超过上限 ${LIMITS.MAX_EVENTS}`, { count: events.length });
  }
  const eventList = [];
  const eventSet = new Set();
  for (const e of events) {
    if (typeof e !== 'string' || e.trim() === '') throw new ModelError('invalid-event', '事件名必须是非空字符串');
    const ev = e.trim();
    if (eventSet.has(ev)) throw new ModelError('duplicate-event', `事件 ${ev} 重复声明`, { event: ev });
    eventSet.add(ev);
    eventList.push(ev);
  }

  // ---- 迁移：触发事件、目标状态、同一源状态内唯一优先级 ----
  const trans = [];
  const tIds = new Set();
  const prioBySource = new Map();
  for (const t of transitions) {
    if (!t || typeof t.id !== 'string' || t.id.trim() === '') {
      throw new ModelError('invalid-transition-id', '每个迁移必须具有非空字符串 id');
    }
    const id = t.id.trim();
    if (tIds.has(id)) throw new ModelError('duplicate-transition', `迁移 ${id} 重复定义`, { id });
    tIds.add(id);
    const source = typeof t.source === 'string' ? t.source.trim() : '';
    const target = typeof t.target === 'string' ? t.target.trim() : '';
    if (!byId.has(source)) throw new ModelError('unknown-source', `迁移 ${id} 的源状态 ${JSON.stringify(t.source)} 不存在`, { id });
    if (!byId.has(target)) throw new ModelError('unknown-target', `迁移 ${id} 的目标状态 ${JSON.stringify(t.target)} 不存在`, { id });
    const event = typeof t.event === 'string' ? t.event.trim() : '';
    if (!eventSet.has(event)) throw new ModelError('unknown-event', `迁移 ${id} 的触发事件 ${JSON.stringify(t.event)} 未在事件目录中声明`, { id });
    if (!Number.isInteger(t.priority)) throw new ModelError('invalid-priority', `迁移 ${id} 的优先级必须是整数`, { id });
    const used = prioBySource.get(source) ?? new Set();
    if (used.has(t.priority)) {
      throw new ModelError('duplicate-priority', `源状态 ${source} 上的迁移优先级 ${t.priority} 不唯一`, { source, priority: t.priority });
    }
    used.add(t.priority);
    prioBySource.set(source, used);
    trans.push(Object.freeze({ id, source, target, event, priority: t.priority, order: trans.length }));
  }

  // ---- 文档顺序（深度优先先序），一切确定性排序的基准 ----
  const docIndex = new Map();
  let counter = 0;
  const walk = (id) => {
    docIndex.set(id, counter++);
    for (const c of childrenOf.get(id)) walk(c);
  };
  for (const t of topLevel) walk(t);

  // ---- 祖先集（含隐式根）----
  const parentOf = new Map([...byId.keys()].map((id) => [id, byId.get(id).parent ?? ROOT]));
  const ancestorsOf = new Map();
  for (const id of byId.keys()) {
    const set = new Set();
    let cur = parentOf.get(id);
    while (cur !== ROOT) {
      set.add(cur);
      cur = parentOf.get(cur);
    }
    set.add(ROOT);
    ancestorsOf.set(id, set);
  }
  const isProperAncestor = (a, s) => ancestorsOf.get(s).has(a);

  /** 最近公共祖先（真祖先）；source===target 时为其父状态。 */
  const lca = (a, b) => {
    let cur = parentOf.get(a);
    while (cur !== ROOT) {
      if (ancestorsOf.get(b).has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return ROOT;
  };

  // ---- 并行区域归属：parallelId -> (后代状态 -> 区域) ----
  const regionOf = new Map();
  for (const p of parallelStates) {
    const m = new Map();
    for (const r of childrenOf.get(p)) {
      const mark = (id) => {
        m.set(id, r);
        for (const c of childrenOf.get(id)) mark(c);
      };
      mark(r);
    }
    regionOf.set(p, m);
  }

  const kindOf = new Map([...byId.values()].map((s) => [s.id, s.kind]));
  const initialOf = new Map([...byId.values()].map((s) => [s.id, s.initial]));
  const byDoc = (ids) => [...ids].sort((a, b) => docIndex.get(a) - docIndex.get(b));

  return Object.freeze({
    limits: LIMITS,
    rootId: ROOT,
    stateIds: Object.freeze(byDoc([...byId.keys()])),
    topLevel: Object.freeze([...topLevel]),
    events: Object.freeze(eventList),
    transitions: Object.freeze(trans),
    labels: Object.freeze(Object.fromEntries([...byId.values()].map((s) => [s.id, s.label]))),
    parallelStates: Object.freeze([...parallelStates]),
    kind: (id) => kindOf.get(id),
    children: (id) => childrenOf.get(id) ?? [],
    parent: (id) => parentOf.get(id),
    initial: (id) => initialOf.get(id),
    depth: (id) => depthOf.get(id),
    docIndexOf: (id) => docIndex.get(id),
    docOrder: (a, b) => docIndex.get(a) - docIndex.get(b),
    byDoc,
    isProperAncestor,
    lca,
    regionOf: (p, s) => regionOf.get(p)?.get(s),
  });
}

/** 进入某状态时的初始后代闭包（含自身，按文档顺序）。 */
function descendInto(machine, id, acc) {
  acc.push(id);
  const k = machine.kind(id);
  if (k === 'composite') descendInto(machine, machine.initial(id), acc);
  else if (k === 'parallel') for (const r of machine.children(id)) descendInto(machine, r, acc);
}

/** 初始稳定配置：隐式根视为复合状态，初始子状态为文档顺序的第一个顶层状态。 */
export function initialConfiguration(machine) {
  const acc = [];
  descendInto(machine, machine.topLevel[0], acc);
  return acc;
}

/** 迁移的退出集合：LCA（真祖先）之下的活动真后代，按文档顺序。 */
function computeExitSet(machine, config, t) {
  const domain = machine.lca(t.source, t.target);
  return config.filter((s) => machine.isProperAncestor(domain, s));
}

/** 迁移的进入集合：LCA 之下到目标的路径 + 目标的初始后代闭包，按文档顺序。 */
function computeEntrySet(machine, t) {
  const domain = machine.lca(t.source, t.target);
  const chain = [];
  let cur = t.target;
  while (cur !== domain) {
    chain.push(cur);
    cur = machine.parent(cur);
  }
  chain.reverse();
  const out = [];
  for (const id of chain) {
    if (id === t.target) descendInto(machine, id, out);
    else out.push(id);
  }
  return out;
}

/**
 * 目标跨越并行区域边界检测：
 * 目标严格位于并行状态 P 的某区域内，而源不在同一区域内
 * （源在 P 之外/之上，或位于 P 的另一区域）→ 违规。
 */
function findParallelCrossing(machine, t) {
  for (const p of machine.parallelStates) {
    if (!machine.isProperAncestor(p, t.target)) continue;
    const rt = machine.regionOf(p, t.target);
    if (!machine.isProperAncestor(p, t.source)) return { parallel: p, region: rt };
    const rs = machine.regionOf(p, t.source);
    if (rs !== rt) return { parallel: p, region: rt };
  }
  return null;
}

/** 稳定配置完整性校验：每区域恰好一个活动叶。返回违规描述列表（空 = 稳定）。 */
export function validateConfiguration(machine, config) {
  const set = new Set(config);
  const violations = [];
  const tops = machine.topLevel.filter((t) => set.has(t));
  if (tops.length !== 1) violations.push(`顶层活动状态数=${tops.length}（应为 1）`);
  for (const id of config) {
    const k = machine.kind(id);
    if (k === 'composite') {
      const active = machine.children(id).filter((c) => set.has(c));
      if (active.length !== 1) violations.push(`复合状态 ${id} 的活动子状态数=${active.length}（应为 1）`);
    } else if (k === 'parallel') {
      for (const r of machine.children(id)) {
        if (!set.has(r)) violations.push(`并行状态 ${id} 的区域 ${r} 未激活`);
      }
    }
    const p = machine.parent(id);
    if (p !== machine.rootId && !set.has(p)) violations.push(`状态 ${id} 的祖先 ${p} 未激活`);
  }
  for (const p of machine.parallelStates) {
    if (!set.has(p)) continue;
    for (const r of machine.children(p)) {
      const leaves = config.filter((s) => machine.kind(s) === 'leaf' && (s === r || machine.isProperAncestor(r, s)));
      if (leaves.length !== 1) violations.push(`区域 ${r} 的活动叶状态数=${leaves.length}（应为 1）`);
    }
  }
  return violations;
}

/** 描述配置：活动叶状态、各并行区域的活动叶。 */
export function describeConfiguration(machine, config) {
  const set = new Set(config);
  const leaves = config.filter((id) => machine.kind(id) === 'leaf');
  const regionLeaves = [];
  for (const p of machine.parallelStates) {
    if (!set.has(p)) continue;
    for (const r of machine.children(p)) {
      const leaf = leaves.find((l) => l === r || machine.isProperAncestor(r, l)) ?? null;
      regionLeaves.push({ parallel: p, region: r, leaf });
    }
  }
  return { config: [...config], leaves, regionLeaves };
}

const intersects = (a, b) => {
  const set = new Set(a);
  return b.some((x) => set.has(x));
};

/**
 * 处理单个外部事件，返回 { config, evidence }。
 * 发生拒绝时抛出 Rejection（由 replay 定位首个失败事件）。
 */
export function step(machine, config, event) {
  if (!machine.events.includes(event)) {
    throw new ModelError('unknown-event', `事件 ${JSON.stringify(event)} 未在事件目录中声明`, { event });
  }
  const configSet = new Set(config);

  // 候选：活动状态或其祖先上、由该事件触发的迁移；按优先级降序、文档顺序升序裁决
  const candidates = machine.transitions
    .filter((t) => t.event === event && configSet.has(t.source))
    .sort((a, b) => b.priority - a.priority || a.order - b.order);
  const candidateInfo = candidates.map((t) => ({
    id: t.id,
    source: t.source,
    target: t.target,
    priority: t.priority,
    domain: machine.lca(t.source, t.target),
    exitSet: computeExitSet(machine, config, t),
  }));

  const selected = [];
  const selectedExitSets = [];
  const dropped = [];
  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i];
    const exitSet = candidateInfo[i].exitSet;
    let winner = null;
    for (let j = 0; j < selected.length; j++) {
      if (intersects(exitSet, selectedExitSets[j])) {
        winner = selected[j];
        break;
      }
    }
    if (winner) {
      if (winner.priority === t.priority) {
        throw new Rejection(
          'same-priority-conflict',
          `迁移 ${winner.id} 与 ${t.id} 优先级相同（${t.priority}）且退出集合相交，无法裁决`,
          { transitions: [winner.id, t.id], priority: t.priority },
        );
      }
      dropped.push({ id: t.id, reason: 'lower-priority-conflict', lostTo: winner.id });
      continue;
    }
    const crossing = findParallelCrossing(machine, t);
    if (crossing) {
      throw new Rejection(
        'crosses-parallel-region',
        `迁移 ${t.id} 的目标 ${t.target} 跨越并行状态 ${crossing.parallel} 的区域边界（区域 ${crossing.region}）`,
        { transition: t.id, ...crossing },
      );
    }
    selected.push(t);
    selectedExitSets.push(exitSet);
  }

  // 退出：先退至各自最近公共祖先（并集按文档逆序，深者优先）
  const exitUnion = new Set();
  for (const es of selectedExitSets) for (const s of es) exitUnion.add(s);
  const exitSequence = [...exitUnion].sort((a, b) => machine.docOrder(b, a));

  // 进入：目标及其初始后代（并集按文档顺序）
  const entryUnion = new Set();
  for (const t of selected) for (const s of computeEntrySet(machine, t)) entryUnion.add(s);
  const entrySequence = [...entryUnion].sort((a, b) => machine.docOrder(a, b));

  const next = machine.byDoc([...config.filter((s) => !exitUnion.has(s)), ...entryUnion]);
  const violations = validateConfiguration(machine, next);
  if (violations.length) {
    throw new Rejection('invalid-configuration', `事件 ${event} 执行后无法形成每区域一个活动叶的稳定配置`, { violations });
  }

  const desc = describeConfiguration(machine, next);
  const evidence = {
    index: -1,
    event,
    status: selected.length ? 'ok' : 'idle',
    before: [...config],
    candidates: candidateInfo,
    selected: selected.map((t) => t.id),
    dropped,
    exitSequence,
    entrySequence,
    after: [...next],
    leaves: desc.leaves,
    regionLeaves: desc.regionLeaves,
  };
  return { config: next, evidence };
}

/**
 * 依序回放外部事件。
 * 成功：{ status:'ok', initial, steps, final }
 * 拒绝：{ status:'rejected', failedAt, event, reason, message, detail, initial, steps }（failedAt 为首个失败事件下标）
 */
export function replay(machine, events) {
  if (!Array.isArray(events)) throw new ModelError('invalid-replay', '回放事件序列必须是数组');
  for (const e of events) {
    if (!machine.events.includes(e)) {
      throw new ModelError('unknown-event', `回放事件 ${JSON.stringify(e)} 未在事件目录中声明`, { event: e });
    }
  }
  let config = initialConfiguration(machine);
  const initViolations = validateConfiguration(machine, config);
  if (initViolations.length) {
    throw new ModelError('invalid-initial', '初始配置不稳定', { violations: initViolations });
  }
  const initial = describeConfiguration(machine, config);
  const steps = [];
  for (let i = 0; i < events.length; i++) {
    try {
      const r = step(machine, config, events[i]);
      r.evidence.index = i;
      steps.push(r.evidence);
      config = r.config;
    } catch (err) {
      if (err instanceof Rejection) {
        return {
          status: 'rejected',
          failedAt: i,
          event: events[i],
          reason: err.code,
          message: err.message,
          detail: err.detail ?? null,
          initial,
          steps,
        };
      }
      throw err;
    }
  }
  return { status: 'ok', initial, steps, final: describeConfiguration(machine, config) };
}
