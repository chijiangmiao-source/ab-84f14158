// 验收规程夹具：两个并行区域同时迁移，随后由父（根）状态迁移复位
//
// 区域 A（载荷供电）：A_OFF ──FIRE──> A_ON（复合，含嵌套初始子状态 A_ON_READY）
// 区域 B（整流罩锁）：B_LOCKED ──FIRE──> B_RELEASED
// 根复位：RESET（source/target 均为根）将两个区域退出并按初始后代重新进入
export const twoRegionResetModel = {
  name: '轨道应急载荷隔离规程-双区域复位',
  regions: [
    { id: 'R_POWER', name: '供电区域', initialStateId: 'A_OFF' },
    { id: 'R_LATCH', name: '锁扣区域', initialStateId: 'B_LOCKED' }
  ],
  states: [
    { id: 'A_OFF', name: '供电断开', parentId: null, regionId: 'R_POWER', kind: 'atomic' },
    {
      id: 'A_ON',
      name: '供电接通',
      parentId: null,
      regionId: 'R_POWER',
      kind: 'composite',
      initialChildId: 'A_ON_READY'
    },
    { id: 'A_ON_READY', name: '就绪', parentId: 'A_ON', regionId: 'R_POWER', kind: 'atomic' },
    { id: 'B_LOCKED', name: '锁扣闭合', parentId: null, regionId: 'R_LATCH', kind: 'atomic' },
    { id: 'B_RELEASED', name: '锁扣释放', parentId: null, regionId: 'R_LATCH', kind: 'atomic' }
  ],
  events: ['FIRE', 'RESET'],
  transitions: [
    { id: 'tr_power_on', event: 'FIRE', priority: 10, sourceId: 'A_OFF', targetId: 'A_ON' },
    { id: 'tr_latch_release', event: 'FIRE', priority: 20, sourceId: 'B_LOCKED', targetId: 'B_RELEASED' },
    { id: 'tr_root_reset', event: 'RESET', priority: 1, sourceId: null, targetId: null }
  ]
};

// 同优先级冲突夹具：叶迁移与祖先迁移退出集合相交
export const samePriorityConflictModel = {
  name: '同优先级冲突',
  regions: [{ id: 'R1', name: '区域一', initialStateId: 'C' }],
  states: [
    { id: 'C', name: '外层复合', parentId: null, regionId: 'R1', kind: 'composite', initialChildId: 'L' },
    { id: 'L', name: '叶', parentId: 'C', regionId: 'R1', kind: 'atomic' },
    { id: 'X', name: '旁路', parentId: null, regionId: 'R1', kind: 'atomic' }
  ],
  events: ['GO'],
  transitions: [
    { id: 'tr_leaf', event: 'GO', priority: 5, sourceId: 'L', targetId: 'X' },
    { id: 'tr_ancestor_same', event: 'GO', priority: 5, sourceId: 'C', targetId: 'X' }
  ]
};

// 不同优先级：祖先迁移优先，叶迁移应出现在候选与裁决记录中但被抢占
export const priorityArbitrationModel = {
  name: '优先级裁决',
  regions: [{ id: 'R1', name: '区域一', initialStateId: 'C' }],
  states: [
    { id: 'C', name: '外层复合', parentId: null, regionId: 'R1', kind: 'composite', initialChildId: 'L' },
    { id: 'L', name: '叶', parentId: 'C', regionId: 'R1', kind: 'atomic' },
    { id: 'X', name: '旁路', parentId: null, regionId: 'R1', kind: 'atomic' }
  ],
  events: ['GO'],
  transitions: [
    { id: 'tr_ancestor_hi', event: 'GO', priority: 1, sourceId: 'C', targetId: 'X' },
    { id: 'tr_leaf_lo', event: 'GO', priority: 9, sourceId: 'L', targetId: 'C' }
  ]
};

// 跨越并行区域边界的迁移（必须被拒绝）
export const crossRegionModel = {
  name: '跨区域目标',
  regions: [
    { id: 'RA', name: '甲', initialStateId: 'A1' },
    { id: 'RB', name: '乙', initialStateId: 'B1' }
  ],
  states: [
    { id: 'A1', name: '甲一', parentId: null, regionId: 'RA', kind: 'atomic' },
    { id: 'B1', name: '乙一', parentId: null, regionId: 'RB', kind: 'atomic' }
  ],
  events: ['JUMP'],
  transitions: [{ id: 'tr_cross', event: 'JUMP', priority: 1, sourceId: 'A1', targetId: 'B1' }]
};
