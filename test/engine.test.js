import test from 'node:test';
import assert from 'node:assert/strict';
import { replay, validateModel, initialConfiguration, LIMITS } from '../src/engine/engine.js';
import {
  twoRegionResetModel,
  samePriorityConflictModel,
  priorityArbitrationModel,
  crossRegionModel
} from './fixtures/models.js';
import { nestedOrthogonalModel } from './fixtures/nested-orthogonal.js';

test('初始配置：每区域一个活动叶，并沿初始后代下行', () => {
  const r = replay(twoRegionResetModel, []);
  assert.ok(r.ok);
  assert.deepEqual(r.finalLeaves, ['A_OFF', 'B_LOCKED']);
  assert.deepEqual(r.initial.entered, ['A_OFF', 'B_LOCKED']);
  assert.equal(r.finalRegions.length, 2);
  assert.equal(r.finalRegions[0].activeStateId, 'A_OFF');
  assert.equal(r.finalRegions[1].activeStateId, 'B_LOCKED');
});

test('验收规程：两个并行区域在同一事件下同时迁移', () => {
  const r = replay(twoRegionResetModel, ['FIRE']);
  assert.ok(r.ok, r.message);
  assert.equal(r.evidence.length, 1);
  const e = r.evidence[0];
  assert.equal(e.eventIndex, 0);
  assert.deepEqual(e.selected.sort(), ['tr_latch_release', 'tr_power_on']);
  // 候选包含两个活动叶上的匹配迁移
  assert.equal(e.candidates.length, 2);
  // 两个迁移退出集合不相交，可以并行
  const sets = e.candidates.map((c) => c.exitSet);
  assert.ok(!sets[0].some((s) => sets[1].includes(s)));
  // 退出序列：旧叶退出
  assert.deepEqual([...e.exits].sort(), ['A_OFF', 'B_LOCKED']);
  // 进入序列按文档顺序：先供电区域目标及其初始后代，再锁扣区域
  assert.deepEqual(e.entries, ['A_ON', 'A_ON_READY', 'B_RELEASED']);
  // 各区域活动叶
  const leafByRegion = Object.fromEntries(e.regions.map((x) => [x.regionId, x.activeStateId]));
  assert.equal(leafByRegion.R_POWER, 'A_ON');
  assert.equal(leafByRegion.R_LATCH, 'B_RELEASED');
  assert.deepEqual(e.configAfter.sort(), ['A_ON_READY', 'B_RELEASED']);
});

test('验收规程：随后由父（根）状态迁移复位，已退出区域不遗留动作', () => {
  const r = replay(twoRegionResetModel, ['FIRE', 'RESET']);
  assert.ok(r.ok, r.message);
  const reset = r.evidence[1];
  assert.equal(reset.event, 'RESET');
  assert.deepEqual(reset.selected, ['tr_root_reset']);
  // 复位退出 FIRE 后进入的全部状态（含嵌套叶），不留残余
  assert.deepEqual([...reset.exits].sort(), ['A_ON', 'A_ON_READY', 'B_RELEASED']);
  // 重新进入根初始配置
  assert.deepEqual(reset.entries, ['A_OFF', 'B_LOCKED']);
  assert.deepEqual(reset.configAfter.sort(), ['A_OFF', 'B_LOCKED']);
  const leafByRegion = Object.fromEntries(reset.regions.map((x) => [x.regionId, x.activeStateId]));
  assert.equal(leafByRegion.R_POWER, 'A_OFF');
  assert.equal(leafByRegion.R_LATCH, 'B_LOCKED');
});

test('复位后状态与初始配置逐证据一致（可重复性）', () => {
  const run = () => replay(twoRegionResetModel, ['FIRE', 'RESET']);
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
});

test('重复运行给出相同证据（JSON 序列化一致）', () => {
  const run = () => JSON.stringify(replay(twoRegionResetModel, ['FIRE', 'RESET', 'FIRE']));
  assert.equal(run(), run());
});

test('同优先级且退出集合相交：拒绝并定位首个事件', () => {
  const r = replay(samePriorityConflictModel, ['GO']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SAME_PRIORITY_CONFLICT');
  assert.equal(r.eventIndex, 0);
  assert.match(r.message, /优先级 5/);
});

test('同事件两个同优先级候选但不在此前冲突序列中：定位到首个触发冲突的事件', () => {
  const m = {
    ...samePriorityConflictModel,
    events: ['IDLE_EV', 'GO'],
    transitions: samePriorityConflictModel.transitions.map((t) => ({ ...t, event: 'GO' }))
  };
  m.events = ['IDLE_EV', 'GO'];
  const r = replay(m, ['IDLE_EV', 'GO']);
  assert.equal(r.ok, false);
  assert.equal(r.eventIndex, 1);
  assert.equal(r.event, 'GO');
  // 首个事件无匹配迁移，配置不变
  assert.equal(r.evidence[0].selected.length, 0);
});

test('优先级裁决：高优先级祖先迁移选中，低优先级叶迁移被抢占并记录原因', () => {
  const r = replay(priorityArbitrationModel, ['GO']);
  assert.ok(r.ok, r.message);
  assert.deepEqual(r.evidence[0].selected, ['tr_ancestor_hi']);
  const loser = r.evidence[0].arbitration.find((a) => a.transitionId === 'tr_leaf_lo');
  assert.equal(loser.selected, false);
  assert.equal(loser.preemptedBy, 'tr_ancestor_hi');
});

test('跨越并行区域边界的目标：拒绝并定位首个事件', () => {
  const r = replay(crossRegionModel, ['JUMP']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CROSS_REGION_TARGET');
  assert.equal(r.eventIndex, 0);
});

test('复合状态缺少初始子状态：模型校验拒绝', () => {
  const bad = {
    name: '缺初始',
    regions: [{ id: 'R', name: 'r', initialStateId: 'C' }],
    states: [{ id: 'C', name: 'c', parentId: null, regionId: 'R', kind: 'composite' }],
    events: [],
    transitions: []
  };
  const v = validateModel(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'INITIAL'));
});

test('根迁移目标指向区域内状态：拒绝跨边界', () => {
  const m = {
    name: '根越界',
    regions: [
      { id: 'RA', name: 'a', initialStateId: 'A1' },
      { id: 'RB', name: 'b', initialStateId: 'B1' }
    ],
    states: [
      { id: 'A1', name: '', parentId: null, regionId: 'RA', kind: 'atomic' },
      { id: 'B1', name: '', parentId: null, regionId: 'RB', kind: 'atomic' }
    ],
    events: ['BOOT'],
    transitions: [{ id: 't', event: 'BOOT', priority: 1, sourceId: null, targetId: 'A1' }]
  };
  const r = replay(m, ['BOOT']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CROSS_REGION_TARGET');
});

test('上限：24 状态 / 32 事件 / 4 区域', () => {
  assert.equal(LIMITS.MAX_STATES, 24);
  assert.equal(LIMITS.MAX_EVENTS, 32);
  assert.equal(LIMITS.MAX_REGIONS_TOTAL, 4);
  const states = [];
  for (let i = 0; i < 25; i++) states.push({ id: `S${i}`, name: '', parentId: null, regionId: 'R', kind: 'atomic' });
  const v = validateModel({
    name: 'too many',
    regions: [{ id: 'R', name: 'r', initialStateId: 'S0' }],
    states,
    events: [],
    transitions: []
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'STATES'));
});

test('两层嵌套上限：第 3 层嵌套（深度 4）不得继续；深度 3 再放复合状态即拒绝', () => {
  const m = {
    name: '嵌套过深',
    regions: [{ id: 'R', name: 'r', initialStateId: 'C1' }],
    states: [
      { id: 'C1', name: '', parentId: null, regionId: 'R', kind: 'composite', initialChildId: 'C2' },
      { id: 'C2', name: '', parentId: 'C1', regionId: 'R', kind: 'composite', initialChildId: 'C3' },
      { id: 'C3', name: '', parentId: 'C2', regionId: 'R', kind: 'composite', initialChildId: 'L' },
      { id: 'L', name: '', parentId: 'C3', regionId: 'R', kind: 'atomic' }
    ],
    events: [],
    transitions: []
  };
  const v = validateModel(m);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'DEPTH'));
});

test('嵌套两层（顶层复合 + 原子子状态）合法并能沿初始进入', () => {
  const cfg = initialConfiguration({
    name: '两层',
    regions: [{ id: 'R', name: 'r', initialStateId: 'C' }],
    states: [
      { id: 'C', name: 'c', parentId: null, regionId: 'R', kind: 'composite', initialChildId: 'L' },
      { id: 'L', name: 'l', parentId: 'C', regionId: 'R', kind: 'atomic' }
    ],
    events: [],
    transitions: []
  });
  assert.deepEqual(cfg.leaves, ['L']);
});

test('未知事件：拒绝并给出序号', () => {
  const r = replay(twoRegionResetModel, ['NOPE']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_EVENT');
  assert.equal(r.eventIndex, 0);
});

test('只考虑活动状态或其祖先的匹配迁移', () => {
  const r = replay(twoRegionResetModel, ['FIRE', 'FIRE']);
  assert.ok(r.ok, r.message);
  // 第二次 FIRE：A_OFF/B_LOCKED 已退出，其迁移不再是候选
  const second = r.evidence[1];
  assert.deepEqual(second.candidates, []);
  assert.deepEqual(second.selected, []);
  assert.deepEqual(second.exits, []);
  assert.deepEqual(second.entries, []);
});

test('嵌套正交状态：每个嵌套区域一个活动叶，同事件两区域并行迁移', () => {
  const init = replay(nestedOrthogonalModel, []);
  assert.ok(init.ok);
  assert.deepEqual(init.finalLeaves.sort(), ['A1', 'B1']);
  const activeRegion = Object.fromEntries(init.finalRegions.map((r) => [r.regionId, r.activeStateId]));
  assert.equal(activeRegion.ROOT, 'O');
  assert.equal(activeRegion.NA, 'A1');
  assert.equal(activeRegion.NB, 'B1');

  const armed = replay(nestedOrthogonalModel, ['ARM']);
  assert.ok(armed.ok, armed.message);
  assert.deepEqual(armed.evidence[0].selected.sort(), ['t_a', 't_b']);
  assert.deepEqual(armed.finalLeaves.sort(), ['A2', 'B2']);
});

test('嵌套正交：正交状态自迁移(复位)退出并重新进入两区域初始叶，不留残余', () => {
  const r = replay(nestedOrthogonalModel, ['ARM', 'RESET']);
  assert.ok(r.ok, r.message);
  const reset = r.evidence[1];
  assert.deepEqual(reset.selected, ['t_o_reset']);
  assert.deepEqual(reset.exits.slice().sort(), ['A2', 'B2', 'O']);
  assert.deepEqual(reset.entries, ['O', 'A1', 'B1']);
  assert.deepEqual(reset.configAfter.slice().sort(), ['A1', 'B1']);
});

test('同优先级但分属不同并行区域（退出集合不相交）：可同时迁移', () => {
  const m = {
    name: '同优先级并行',
    regions: [
      { id: 'RA', name: '甲', initialStateId: 'A1' },
      { id: 'RB', name: '乙', initialStateId: 'B1' }
    ],
    states: [
      { id: 'A1', name: '', parentId: null, regionId: 'RA', kind: 'atomic' },
      { id: 'A2', name: '', parentId: null, regionId: 'RA', kind: 'atomic' },
      { id: 'B1', name: '', parentId: null, regionId: 'RB', kind: 'atomic' },
      { id: 'B2', name: '', parentId: null, regionId: 'RB', kind: 'atomic' }
    ],
    events: ['GO'],
    transitions: [
      { id: 'ta', event: 'GO', priority: 7, sourceId: 'A1', targetId: 'A2' },
      { id: 'tb', event: 'GO', priority: 7, sourceId: 'B1', targetId: 'B2' }
    ]
  };
  const r = replay(m, ['GO']);
  assert.ok(r.ok, r.message);
  assert.deepEqual(r.evidence[0].selected.sort(), ['ta', 'tb']);
  assert.deepEqual(r.finalLeaves.sort(), ['A2', 'B2']);
});
