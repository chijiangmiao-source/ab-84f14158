/**
 * 验收示例规程：轨道应急载荷隔离。
 * 两个并行区域（电源 / 链路）由同一事件 ISOLATE 同时迁移，
 * 随后由父状态（并行状态 P）上的 RESET 迁移整体复位回初始配置。
 */
export const EXAMPLE_MODEL = Object.freeze({
  events: ['ISOLATE', 'RESET'],
  states: [
    { id: 'P',        label: '隔离规程', kind: 'parallel',  parent: null },
    { id: 'Power',    label: '电源区域', kind: 'composite', parent: 'P', initial: 'PowerOn' },
    { id: 'PowerOn',  label: '供电正常', kind: 'leaf',      parent: 'Power' },
    { id: 'PowerCut', label: '供电切断', kind: 'leaf',      parent: 'Power' },
    { id: 'Link',     label: '链路区域', kind: 'composite', parent: 'P', initial: 'LinkUp' },
    { id: 'LinkUp',   label: '链路正常', kind: 'leaf',      parent: 'Link' },
    { id: 'LinkDown', label: '链路静默', kind: 'leaf',      parent: 'Link' },
  ],
  transitions: [
    { id: 't-power', source: 'PowerOn', target: 'PowerCut', event: 'ISOLATE', priority: 10 },
    { id: 't-link',  source: 'LinkUp',  target: 'LinkDown', event: 'ISOLATE', priority: 20 },
    { id: 't-reset', source: 'P',       target: 'P',        event: 'RESET',   priority: 30 },
  ],
});

export const EXAMPLE_EVENTS = Object.freeze(['ISOLATE', 'RESET']);
