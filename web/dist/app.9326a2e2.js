import { LIMITS, ModelError, createMachine, replay } from './statechart.e5d10980.js';
import { EXAMPLE_MODEL, EXAMPLE_EVENTS } from './example.bbbb8c94.js';

const $ = (sel) => document.querySelector(sel);

// ---------- 录入状态（表格行模型） ----------

const stateRows = []; // {id,label,kind,parent,initial}
const transRows = []; // {id,source,target,event,priority}

function cellInput(value, onInput, placeholder = '') {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function cellSelect(options, value, onChange) {
  const sel = document.createElement('select');
  for (const [v, text] of options) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = text;
    sel.appendChild(opt);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function deleteBtn(onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'danger';
  btn.textContent = '✕';
  btn.addEventListener('click', onClick);
  return btn;
}

function renderStateTable() {
  const tbody = $('#states tbody');
  tbody.innerHTML = '';
  stateRows.forEach((row, i) => {
    const tr = document.createElement('tr');
    const td = () => tr.appendChild(document.createElement('td'));
    td().appendChild(cellInput(row.id, (v) => (row.id = v), 'PowerOn'));
    td().appendChild(cellInput(row.label, (v) => (row.label = v), '供电正常'));
    td().appendChild(
      cellSelect(
        [['leaf', 'leaf 叶'], ['composite', 'composite 复合'], ['parallel', 'parallel 并行']],
        row.kind,
        (v) => (row.kind = v),
      ),
    );
    td().appendChild(cellInput(row.parent, (v) => (row.parent = v), '（空=顶层）'));
    td().appendChild(cellInput(row.initial, (v) => (row.initial = v), '复合状态必填'));
    td().appendChild(deleteBtn(() => { stateRows.splice(i, 1); renderStateTable(); }));
    tbody.appendChild(tr);
  });
  $('#add-state').disabled = stateRows.length >= LIMITS.MAX_STATES;
  $('#state-count').textContent = `${stateRows.length}/${LIMITS.MAX_STATES}`;
}

function renderTransTable() {
  const tbody = $('#transitions tbody');
  tbody.innerHTML = '';
  transRows.forEach((row, i) => {
    const tr = document.createElement('tr');
    const td = () => tr.appendChild(document.createElement('td'));
    td().appendChild(cellInput(row.id, (v) => (row.id = v), 't-power'));
    td().appendChild(cellInput(row.source, (v) => (row.source = v), 'PowerOn'));
    td().appendChild(cellInput(row.target, (v) => (row.target = v), 'PowerCut'));
    td().appendChild(cellInput(row.event, (v) => (row.event = v), 'ISOLATE'));
    td().appendChild(cellInput(row.priority, (v) => (row.priority = v), '10'));
    td().appendChild(deleteBtn(() => { transRows.splice(i, 1); renderTransTable(); }));
    tbody.appendChild(tr);
  });
  $('#trans-count').textContent = `${transRows.length} 条`;
}

// ---------- 模型收集 ----------

const parseList = (text) => text.split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean);

function collectModel() {
  const states = stateRows
    .filter((r) => r.id.trim())
    .map((r) => ({
      id: r.id.trim(),
      label: r.label.trim() || undefined,
      kind: r.kind,
      parent: r.parent.trim() || null,
      initial: r.initial.trim() || undefined,
    }));
  const transitions = transRows
    .filter((r) => r.id.trim())
    .map((r) => ({
      id: r.id.trim(),
      source: r.source.trim(),
      target: r.target.trim(),
      event: r.event.trim(),
      priority: r.priority.trim() === '' ? NaN : Number(r.priority),
    }));
  const events = parseList($('#events').value);
  return { states, transitions, events };
}

// ---------- 渲染工具 ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chip(text, cls = '') {
  return el('span', `chip ${cls}`.trim(), text);
}

function chips(node, ids, cls, labels) {
  const wrap = el('div', 'chips');
  ids.forEach((id, i) => {
    if (i > 0 && cls === 'seq') wrap.appendChild(el('span', 'arrow', '→'));
    wrap.appendChild(chip(labels ? `${labels[id] ?? id}〈${id}〉` : id, cls === 'seq' ? '' : cls));
  });
  if (!ids.length) wrap.appendChild(el('span', 'hint', '（空）'));
  node.appendChild(wrap);
}

function kvRow(grid, key) {
  grid.appendChild(el('div', 'k', key));
  const v = el('div');
  grid.appendChild(v);
  return v;
}

function regionTable(node, regionLeaves, labels) {
  if (!regionLeaves.length) return;
  const table = el('table', 'region-table');
  const head = el('tr');
  head.appendChild(el('th', null, '并行状态'));
  head.appendChild(el('th', null, '区域'));
  head.appendChild(el('th', null, '活动叶状态'));
  table.appendChild(head);
  for (const { parallel, region, leaf } of regionLeaves) {
    const tr = el('tr');
    tr.appendChild(el('td', 'mono', `${labels[parallel] ?? parallel}〈${parallel}〉`));
    tr.appendChild(el('td', 'mono', `${labels[region] ?? region}〈${region}〉`));
    tr.appendChild(el('td', 'mono', leaf ? `${labels[leaf] ?? leaf}〈${leaf}〉` : '—'));
    table.appendChild(tr);
  }
  node.appendChild(table);
}

// ---------- 回放结果渲染 ----------

function renderConfigCard(title, desc, labels) {
  const card = el('section', 'card');
  card.appendChild(el('h2', null, title));
  const grid = el('div', 'kv');
  chips(kvRow(grid, '稳定配置'), desc.config, 'cfg', labels);
  chips(kvRow(grid, '活动叶状态'), desc.leaves, 'cfg', labels);
  const regionCell = kvRow(grid, '各区域活动叶状态');
  regionTable(regionCell, desc.regionLeaves, labels);
  card.appendChild(grid);
  return card;
}

function renderStep(stepData, labels, open) {
  const det = el('details', 'step');
  det.open = open;
  const summary = el('summary');
  summary.appendChild(chip(`#${stepData.index}`, 'event'));
  summary.appendChild(el('span', null, `事件 ${stepData.event}`));
  summary.appendChild(el('span', `badge ${stepData.status === 'ok' ? 'ok' : 'idle'}`,
    stepData.status === 'ok' ? `选中 ${stepData.selected.length} 条迁移` : '无匹配迁移'));
  det.appendChild(summary);

  const body = el('div', 'step-body');
  const grid = el('div', 'kv');

  chips(kvRow(grid, '稳定配置（前）'), stepData.before, 'cfg', labels);

  // 候选迁移表
  const candCell = kvRow(grid, '候选迁移');
  if (stepData.candidates.length) {
    const table = el('table', 'cand');
    const head = el('tr');
    for (const h of ['迁移', '源 → 目标', '优先级', '最近公共祖先', '退出集合', '裁决']) head.appendChild(el('th', null, h));
    table.appendChild(head);
    for (const c of stepData.candidates) {
      const tr = el('tr');
      tr.appendChild(el('td', 'mono', c.id));
      tr.appendChild(el('td', 'mono', `${c.source} → ${c.target}`));
      tr.appendChild(el('td', 'mono', String(c.priority)));
      tr.appendChild(el('td', 'mono', c.domain));
      const exitTd = el('td');
      chips(exitTd, c.exitSet, 'exit', labels);
      tr.appendChild(exitTd);
      const verdict = el('td');
      if (stepData.selected.includes(c.id)) verdict.appendChild(el('span', 'badge ok', '选中'));
      else {
        const d = stepData.dropped.find((x) => x.id === c.id);
        verdict.appendChild(el('span', 'badge bad', d ? `丢弃（与 ${d.lostTo} 冲突，优先级低）` : '丢弃'));
      }
      tr.appendChild(verdict);
      table.appendChild(tr);
    }
    candCell.appendChild(table);
  } else {
    candCell.appendChild(el('span', 'hint', '（无候选：活动状态及其祖先上无该事件触发的迁移）'));
  }

  chips(kvRow(grid, '选中迁移'), stepData.selected, 'sel');
  const exitCell = kvRow(grid, '退出序列（至 LCA）');
  chips(exitCell, stepData.exitSequence, 'seq', labels);
  exitCell.querySelectorAll('.chip').forEach((c) => c.classList.add('exit'));
  const entryCell = kvRow(grid, '进入序列（文档顺序）');
  chips(entryCell, stepData.entrySequence, 'seq', labels);
  entryCell.querySelectorAll('.chip').forEach((c) => c.classList.add('entry'));
  chips(kvRow(grid, '稳定配置（后）'), stepData.after, 'cfg', labels);
  const regionCell = kvRow(grid, '各区域活动叶状态');
  regionTable(regionCell, stepData.regionLeaves, labels);

  body.appendChild(grid);
  det.appendChild(body);
  return det;
}

function renderReplay(result, deterministic, labels) {
  const out = $('#output');
  out.innerHTML = '';

  const banner = el('div', `banner ${result.status === 'ok' ? 'ok' : 'bad'}`);
  if (result.status === 'ok') {
    banner.appendChild(el('div', null, `回放完成：${result.steps.length} 个事件全部展开，配置始终稳定。`));
  } else {
    banner.appendChild(el('div', null,
      `已在首个失败事件 #${result.failedAt}（${result.event}）拒绝执行。`));
    banner.appendChild(el('div', null, `原因：${result.message}`));
    banner.appendChild(el('div', null, `代码：`)).appendChild(el('span', 'code', result.reason));
  }
  const det = el('div');
  det.appendChild(el('span', `badge ${deterministic ? 'ok' : 'bad'}`,
    deterministic ? '✓ 重复运行证据一致（确定性）' : '✗ 重复运行证据不一致'));
  banner.appendChild(det);
  out.appendChild(banner);

  out.appendChild(renderConfigCard('初始稳定配置', result.initial, labels));

  result.steps.forEach((s, i) => {
    out.appendChild(renderStep(s, labels, i === result.steps.length - 1));
  });

  if (result.status === 'ok') {
    out.appendChild(renderConfigCard('最终稳定配置', result.final, labels));
  }
}

function renderError(err) {
  const out = $('#output');
  out.innerHTML = '';
  const banner = el('div', 'banner bad');
  banner.appendChild(el('div', null, '模型校验失败'));
  banner.appendChild(el('div', 'err', `[${err.code ?? err.name}] ${err.message}`));
  out.appendChild(banner);
}

function renderValidation(machine) {
  const out = $('#output');
  out.innerHTML = '';
  const banner = el('div', 'banner ok');
  banner.appendChild(el('div', null,
    `模型校验通过：状态 ${machine.stateIds.length}/${LIMITS.MAX_STATES} · ` +
    `事件 ${machine.events.length}/${LIMITS.MAX_EVENTS} · ` +
    `并行状态 ${machine.parallelStates.length} 个 · 迁移 ${machine.transitions.length} 条`));
  out.appendChild(banner);
}

// ---------- 事件绑定 ----------

$('#add-state').addEventListener('click', () => {
  stateRows.push({ id: '', label: '', kind: 'leaf', parent: '', initial: '' });
  renderStateTable();
});

$('#add-trans').addEventListener('click', () => {
  transRows.push({ id: '', source: '', target: '', event: '', priority: '' });
  renderTransTable();
});

$('#load-example').addEventListener('click', () => {
  stateRows.length = 0;
  for (const s of EXAMPLE_MODEL.states) {
    stateRows.push({
      id: s.id, label: s.label ?? '', kind: s.kind,
      parent: s.parent ?? '', initial: s.initial ?? '',
    });
  }
  transRows.length = 0;
  for (const t of EXAMPLE_MODEL.transitions) {
    transRows.push({ id: t.id, source: t.source, target: t.target, event: t.event, priority: String(t.priority) });
  }
  $('#events').value = EXAMPLE_MODEL.events.join(' ');
  $('#sequence').value = EXAMPLE_EVENTS.join(' ');
  renderStateTable();
  renderTransTable();
});

$('#validate').addEventListener('click', () => {
  try {
    renderValidation(createMachine(collectModel()));
  } catch (err) {
    renderError(err);
  }
});

$('#replay').addEventListener('click', () => {
  try {
    const machine = createMachine(collectModel());
    const events = parseList($('#sequence').value);
    const first = replay(machine, events);
    // 确定性核验：重复运行必须给出相同证据
    const second = replay(machine, events);
    const deterministic = JSON.stringify(first) === JSON.stringify(second);
    renderReplay(first, deterministic, machine.labels);
  } catch (err) {
    renderError(err);
  }
});

$('#clear').addEventListener('click', () => { $('#output').innerHTML = ''; });

// 初始：载入示例，便于直接回放
$('#load-example').click();
