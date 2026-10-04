import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  ModelError,
  createMachine,
  initialConfiguration,
  describeConfiguration,
  validateConfiguration,
  step,
  replay,
} from './statechart.mjs';
import { EXAMPLE_MODEL, EXAMPLE_EVENTS } from './example.mjs';

// ---------- 验收场景：两个并行区域同时迁移，随后由父状态迁移复位 ----------

test('初始配置：每区域一个活动叶，按文档顺序', () => {
  const m = createMachine(EXAMPLE_MODEL);
  assert.deepEqual(initialConfiguration(m), ['P', 'Power', 'PowerOn', 'Link', 'LinkUp']);
  const desc = describeConfiguration(m, initialConfiguration(m));
  assert.deepEqual(desc.leaves, ['PowerOn', 'LinkUp']);
  assert.deepEqual(desc.regionLeaves, [
    { parallel: 'P', region: 'Power', leaf: 'PowerOn' },
    { parallel: 'P', region: 'Link', leaf: 'LinkUp' },
  ]);
});

test('两个并行区域由同一事件同时迁移（退出集合不相交可并行）', () => {
  const m = createMachine(EXAMPLE_MODEL);
  const r = replay(m, ['ISOLATE']);
  assert.equal(r.status, 'ok');
  const s0 = r.steps[0];
  assert.deepEqual(s0.before, ['P', 'Power', 'PowerOn', 'Link', 'LinkUp']);
  // 候选按优先级降序
  assert.deepEqual(s0.candidates.map((c) => c.id), ['t-link', 't-power']);
  assert.deepEqual(s0.selected, ['t-link', 't-power']);
  // 退出：文档逆序；进入：文档顺序
  assert.deepEqual(s0.exitSequence, ['LinkUp', 'PowerOn']);
  assert.deepEqual(s0.entrySequence, ['PowerCut', 'LinkDown']);
  assert.deepEqual(s0.after, ['P', 'Power', 'PowerCut', 'Link', 'LinkDown']);
  assert.deepEqual(s0.regionLeaves, [
    { parallel: 'P', region: 'Power', leaf: 'PowerCut' },
    { parallel: 'P', region: 'Link', leaf: 'LinkDown' },
  ]);
});

test('父状态迁移复位：退出至最近公共祖先（根）并回到初始配置', () => {
  const m = createMachine(EXAMPLE_MODEL);
  const r = replay(m, EXAMPLE_EVENTS);
  assert.equal(r.status, 'ok');
  const s1 = r.steps[1];
  assert.deepEqual(s1.selected, ['t-reset']);
  assert.deepEqual(s1.exitSequence, ['LinkDown', 'Link', 'PowerCut', 'Power', 'P']);
  assert.deepEqual(s1.entrySequence, ['P', 'Power', 'PowerOn', 'Link', 'LinkUp']);
  assert.deepEqual(s1.after, r.initial.config);
  assert.deepEqual(r.final.config, r.initial.config);
  assert.deepEqual(r.final.regionLeaves, [
    { parallel: 'P', region: 'Power', leaf: 'PowerOn' },
    { parallel: 'P', region: 'Link', leaf: 'LinkUp' },
  ]);
});

test('重复运行给出完全相同的证据', () => {
  const m = createMachine(EXAMPLE_MODEL);
  const first = JSON.stringify(replay(m, EXAMPLE_EVENTS));
  for (let i = 0; i < 10; i++) {
    assert.equal(JSON.stringify(replay(m, EXAMPLE_EVENTS)), first);
  }
});

// ---------- 候选匹配与优先级裁决 ----------

const ANCESTOR_MODEL = {
  events: ['GO', 'NOOP'],
  states: [
    { id: 'S', kind: 'composite', parent: null, initial: 'A' },
    { id: 'A', kind: 'leaf', parent: 'S' },
    { id: 'B', kind: 'leaf', parent: 'S' },
    { id: 'C', kind: 'leaf', parent: 'S' },
  ],
  transitions: [
    { id: 't1', source: 'A', target: 'B', event: 'GO', priority: 1 },
    { id: 't2', source: 'S', target: 'C', event: 'GO', priority: 2 },
  ],
};

test('活动状态祖先上的迁移参与匹配；退出集合相交时高优先级胜出', () => {
  const m = createMachine(ANCESTOR_MODEL);
  const r = replay(m, ['GO']);
  assert.equal(r.status, 'ok');
  const s0 = r.steps[0];
  assert.deepEqual(s0.candidates.map((c) => c.id), ['t2', 't1']);
  assert.deepEqual(s0.selected, ['t2']);
  assert.deepEqual(s0.dropped, [{ id: 't1', reason: 'lower-priority-conflict', lostTo: 't2' }]);
  assert.deepEqual(s0.exitSequence, ['A', 'S']);
  assert.deepEqual(s0.entrySequence, ['S', 'C']);
  assert.deepEqual(s0.after, ['S', 'C']);
});

test('无匹配迁移的事件：配置不变，状态为 idle', () => {
  const m = createMachine(ANCESTOR_MODEL);
  const r = replay(m, ['NOOP']);
  assert.equal(r.status, 'ok');
  assert.equal(r.steps[0].status, 'idle');
  assert.deepEqual(r.steps[0].after, r.steps[0].before);
  assert.deepEqual(r.steps[0].exitSequence, []);
  assert.deepEqual(r.steps[0].entrySequence, []);
});

// ---------- 三类拒绝，均定位首个失败事件 ----------

test('同优先级冲突：拒绝并定位首个事件', () => {
  const model = {
    ...EXAMPLE_MODEL,
    events: ['X'],
    transitions: [
      { id: 't1', source: 'PowerOn', target: 'PowerCut', event: 'X', priority: 5 },
      { id: 't2', source: 'P', target: 'P', event: 'X', priority: 5 }, // 不同源状态允许同优先级
    ],
  };
  const m = createMachine(model);
  const r = replay(m, ['X']);
  assert.equal(r.status, 'rejected');
  assert.equal(r.failedAt, 0);
  assert.equal(r.event, 'X');
  assert.equal(r.reason, 'same-priority-conflict');
  assert.equal(r.steps.length, 0);
});

test('目标跨越并行区域边界：拒绝并定位首个失败事件（非首个事件）', () => {
  const model = {
    ...EXAMPLE_MODEL,
    events: ['ISOLATE', 'SNEAK'],
    transitions: [
      ...EXAMPLE_MODEL.transitions.filter((t) => t.event === 'ISOLATE'),
      { id: 't-sneak', source: 'PowerCut', target: 'LinkUp', event: 'SNEAK', priority: 40 },
    ],
  };
  const m = createMachine(model);
  const r = replay(m, ['ISOLATE', 'SNEAK']);
  assert.equal(r.status, 'rejected');
  assert.equal(r.failedAt, 1); // 首个失败事件是第 2 个
  assert.equal(r.event, 'SNEAK');
  assert.equal(r.reason, 'crosses-parallel-region');
  assert.equal(r.steps.length, 1); // 首个事件已成功展开
  assert.deepEqual(r.steps[0].after, ['P', 'Power', 'PowerCut', 'Link', 'LinkDown']);
});

test('无法形成每区域一个活动叶的配置：拒绝', () => {
  const model = {
    ...EXAMPLE_MODEL,
    events: ['BAD'],
    transitions: [
      // 目标为区域自身：退出整个并行状态却只进入一个区域
      { id: 't-bad', source: 'PowerOn', target: 'Power', event: 'BAD', priority: 40 },
    ],
  };
  const m = createMachine(model);
  const r = replay(m, ['BAD']);
  assert.equal(r.status, 'rejected');
  assert.equal(r.failedAt, 0);
  assert.equal(r.reason, 'invalid-configuration');
  assert.ok(Array.isArray(r.detail.violations) && r.detail.violations.length > 0);
});

// ---------- 模型校验 ----------

const baseModel = () => ({
  events: ['E'],
  states: [
    { id: 'S', kind: 'composite', parent: null, initial: 'A' },
    { id: 'A', kind: 'leaf', parent: 'S' },
  ],
  transitions: [],
});

test('模型校验：状态数量上限 24', () => {
  const model = baseModel();
  model.states = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, kind: 'leaf', parent: null }));
  assert.throws(() => createMachine(model), (e) => e instanceof ModelError && e.code === 'too-many-states');
  model.states = model.states.slice(0, 24);
  assert.ok(createMachine(model));
});

test('模型校验：嵌套层级至多 2 层（顶层之下）', () => {
  const model = baseModel();
  model.states = [
    { id: 'a', kind: 'composite', parent: null, initial: 'b' },
    { id: 'b', kind: 'composite', parent: 'a', initial: 'c' },
    { id: 'c', kind: 'composite', parent: 'b', initial: 'd' },
    { id: 'd', kind: 'leaf', parent: 'c' },
  ];
  assert.throws(() => createMachine(model), (e) => e.code === 'nesting-too-deep');
  model.states[2] = { id: 'c', kind: 'leaf', parent: 'b' };
  model.states.pop();
  assert.ok(createMachine(model));
});

test('模型校验：并行区域总数至多 4，且每个并行状态至少 2 个区域', () => {
  const mk = (regions) => ({
    events: ['E'],
    states: [
      { id: 'P', kind: 'parallel', parent: null },
      ...regions.flatMap((r) => [
        { id: r, kind: 'composite', parent: 'P', initial: `${r}x` },
        { id: `${r}x`, kind: 'leaf', parent: r },
      ]),
    ],
    transitions: [],
  });
  assert.throws(() => createMachine(mk(['R1', 'R2', 'R3', 'R4', 'R5'])), (e) => e.code === 'too-many-regions');
  assert.throws(() => createMachine(mk(['R1'])), (e) => e.code === 'too-few-regions');
  assert.ok(createMachine(mk(['R1', 'R2', 'R3', 'R4'])));
});

test('模型校验：外部事件至多 32 个', () => {
  const model = baseModel();
  model.events = Array.from({ length: 33 }, (_, i) => `e${i}`);
  assert.throws(() => createMachine(model), (e) => e.code === 'too-many-events');
  model.events = model.events.slice(0, 32);
  assert.ok(createMachine(model));
});

test('模型校验：复合状态必须声明初始子状态', () => {
  const model = baseModel();
  delete model.states[0].initial;
  assert.throws(() => createMachine(model), (e) => e.code === 'missing-initial');
  model.states[0].initial = 'B'; // 非直接子状态
  assert.throws(() => createMachine(model), (e) => e.code === 'missing-initial');
});

test('模型校验：同一源状态的迁移优先级必须唯一；不同源状态可相同', () => {
  const model = baseModel();
  model.states.push({ id: 'B', kind: 'leaf', parent: 'S' });
  model.transitions = [
    { id: 't1', source: 'A', target: 'B', event: 'E', priority: 1 },
    { id: 't2', source: 'A', target: 'B', event: 'E', priority: 1 },
  ];
  assert.throws(() => createMachine(model), (e) => e.code === 'duplicate-priority');
  model.transitions[1] = { id: 't2', source: 'S', target: 'B', event: 'E', priority: 1 };
  assert.ok(createMachine(model));
});

test('模型校验：引用与结构错误', () => {
  const unknownParent = baseModel();
  unknownParent.states[1].parent = 'ZZZ';
  assert.throws(() => createMachine(unknownParent), (e) => e.code === 'unknown-parent');

  const unknownTarget = baseModel();
  unknownTarget.transitions = [{ id: 't', source: 'A', target: 'ZZZ', event: 'E', priority: 1 }];
  assert.throws(() => createMachine(unknownTarget), (e) => e.code === 'unknown-target');

  const unknownEvent = baseModel();
  unknownEvent.transitions = [{ id: 't', source: 'A', target: 'A', event: 'ZZZ', priority: 1 }];
  assert.throws(() => createMachine(unknownEvent), (e) => e.code === 'unknown-event');

  const leafKids = baseModel();
  leafKids.states.push({ id: 'B', kind: 'leaf', parent: 'A' });
  assert.throws(() => createMachine(leafKids), (e) => e.code === 'leaf-has-children');

  const badRegion = baseModel();
  badRegion.states = [
    { id: 'P', kind: 'parallel', parent: null },
    { id: 'R1', kind: 'composite', parent: 'P', initial: 'x' },
    { id: 'x', kind: 'leaf', parent: 'R1' },
    { id: 'R2', kind: 'leaf', parent: 'P' },
  ];
  assert.throws(() => createMachine(badRegion), (e) => e.code === 'invalid-region');

  const cyclic = baseModel();
  cyclic.states = [
    { id: 'T', kind: 'leaf', parent: null },
    { id: 'a', kind: 'leaf', parent: 'b' },
    { id: 'b', kind: 'leaf', parent: 'a' },
  ];
  assert.throws(() => createMachine(cyclic), (e) => e.code === 'cycle');
});

test('回放序列中的事件必须在事件目录中', () => {
  const m = createMachine(EXAMPLE_MODEL);
  assert.throws(() => replay(m, ['ISOLATE', 'BOGUS']), (e) => e instanceof ModelError && e.code === 'unknown-event');
  assert.throws(() => step(m, initialConfiguration(m), 'BOGUS'), (e) => e.code === 'unknown-event');
});

test('validateConfiguration：初始配置稳定', () => {
  const m = createMachine(EXAMPLE_MODEL);
  assert.deepEqual(validateConfiguration(m, initialConfiguration(m)), []);
});
