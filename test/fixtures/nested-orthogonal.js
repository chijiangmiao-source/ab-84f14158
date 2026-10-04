export const nestedOrthogonalModel = {
  name: '嵌套正交',
  regions: [{ id: 'ROOT', name: '根区域', initialStateId: 'O' }],
  states: [
    {
      id: 'O',
      name: '隔离执行器',
      parentId: null,
      regionId: 'ROOT',
      kind: 'orthogonal',
      regions: [
        { id: 'NA', name: '阀门', initialStateId: 'A1' },
        { id: 'NB', name: '管路', initialStateId: 'B1' }
      ]
    },
    { id: 'A1', name: '阀关', parentId: 'O', regionId: 'NA', kind: 'atomic' },
    { id: 'A2', name: '阀开', parentId: 'O', regionId: 'NA', kind: 'atomic' },
    { id: 'B1', name: '管断', parentId: 'O', regionId: 'NB', kind: 'atomic' },
    { id: 'B2', name: '管通', parentId: 'O', regionId: 'NB', kind: 'atomic' }
  ],
  events: ['ARM', 'RESET'],
  transitions: [
    { id: 't_a', event: 'ARM', priority: 1, sourceId: 'A1', targetId: 'A2' },
    { id: 't_b', event: 'ARM', priority: 2, sourceId: 'B1', targetId: 'B2' },
    { id: 't_o_reset', event: 'RESET', priority: 1, sourceId: 'O', targetId: 'O' }
  ]
};
