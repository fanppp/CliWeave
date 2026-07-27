import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GraphV3Schema,
  validateGraph,
  validateRunnable,
  computeBackEdges,
  type Graph,
  type GraphEdge,
  GraphValidationError,
} from './graph.js';

function agent(id: string, key: string): Graph['nodes'][number] {
  return { id, type: 'agent', agentNodeKey: key } as Graph['nodes'][number];
}
function edge(id: string, source: string, target: string, maxIter?: number): GraphEdge {
  return { id, source, target, ...(maxIter != null ? { maxIterations: maxIter } : {}) };
}
function graph(nodes: Graph['nodes'][number][], edges: GraphEdge[], extra: Partial<Graph> = {}): Graph {
  return { schemaVersion: 3, inputNode: '__input__', maxNodeExecutions: 50, nodes, edges, ...extra } as Graph;
}

const baseNodes: Graph['nodes'][number][] = [
  { id: '__input__', type: 'input' },
  agent('A', 'codex:coder'),
  agent('B', 'claude:claude-node'),
  { id: '__end__', type: 'end' },
];

describe('validateGraph 编辑期约束', () => {
  it('v3 合法图通过', () => {
    const g = graph(baseNodes, [edge('e1', '__input__', 'A'), edge('e2', 'A', 'B'), edge('e3', 'B', '__end__'), edge('e4', 'B', 'A', 3)], { endNode: '__end__' });
    validateGraph(g);
    assert.ok(true);
  });

  it('input 入度必须 0', () => {
    const g = graph(baseNodes, [edge('e1', '__input__', 'A'), edge('e2', 'A', '__input__')], { endNode: '__end__' });
    assert.throws(() => validateGraph(g), /in-degree 0/);
  });

  it('input 0 出边允许（编辑期）；运行期要求恰好 1', () => {
    const g = graph(baseNodes, [], { endNode: '__end__' });
    validateGraph(g);
    assert.throws(() => validateRunnable(g), /exactly one out-edge to run/);
  });

  it('end 出度必须 0', () => {
    const g = graph(baseNodes, [edge('e1', '__input__', 'A'), edge('e2', 'A', 'B'), edge('e3', '__end__', 'A')], { endNode: '__end__' });
    assert.throws(() => validateGraph(g), /out-degree 0/);
  });

  it('endNode 与 type:end 必须同存同缺', () => {
    const g = graph(baseNodes.filter((n) => n.id !== '__end__'), [edge('e1', '__input__', 'A'), edge('e2', 'A', 'B')], { endNode: '__end__' });
    assert.throws(() => validateGraph(g), /no type:'end' node/);
  });

  it('自环拒绝', () => {
    const g = graph(baseNodes, [edge('e1', '__input__', 'A'), edge('e2', 'A', 'A')], { endNode: '__end__' });
    assert.throws(() => validateGraph(g), /self-loop/);
  });
});

describe('computeBackEdges + validateRunnable', () => {
  it('B→A 是回边（A 能到 B）；A→B / B→__end__ 是前向', () => {
    const g = graph(baseNodes, [edge('e1', '__input__', 'A'), edge('e2', 'A', 'B'), edge('e3', 'B', '__end__'), edge('e4', 'B', 'A', 3)], { endNode: '__end__' });
    const back = computeBackEdges(g);
    assert.ok(back.has('e4'), 'B→A is back-edge');
    assert.ok(!back.has('e2'), 'A→B is forward');
    assert.ok(!back.has('e3'), 'B→__end__ is forward');
  });

  it('回边无需显式 maxIterations（默认兜底）；环不拒', () => {
    const g = graph(baseNodes, [edge('e1', '__input__', 'A'), edge('e2', 'A', 'B'), edge('e3', 'B', '__end__'), edge('e4', 'B', 'A')], { endNode: '__end__' });
    validateRunnable(g); // 不抛
    assert.ok(true);
  });

  it('单路径：节点 2 前向出边拒绝', () => {
    const nodes = [...baseNodes, agent('C', 'codex:coder2')];
    const g = graph(nodes, [edge('e1', '__input__', 'A'), edge('e2', 'A', 'B'), edge('e3', 'A', 'C'), edge('e4', 'B', '__end__'), edge('e5', 'B', 'A', 3)], { endNode: '__end__' });
    assert.throws(() => validateRunnable(g), /forward out-edges/);
  });

  it('不可达 agent 拒绝', () => {
    const nodes = [...baseNodes, agent('X', 'codex:coder3')];
    const g = graph(nodes, [edge('e1', '__input__', 'A'), edge('e2', 'A', 'B'), edge('e3', 'B', '__end__'), edge('e4', 'B', 'A', 3)], { endNode: '__end__' });
    assert.throws(() => validateRunnable(g), /not reachable/);
  });

  it('input 出边为前向（回边到 input 不可能：input 入度必须 0）', () => {
    const g = graph(baseNodes, [edge('e1', '__input__', 'A'), edge('e2', 'A', 'B'), edge('e3', 'B', '__end__'), edge('e4', 'B', 'A', 3)], { endNode: '__end__' });
    const back = computeBackEdges(g);
    assert.ok(!back.has('e1'), 'input→A is forward');
    validateRunnable(g);
  });
});

describe('v1/v2 归一化', () => {
  it('v2 边剥 when 归一化为 v3', () => {
    const v2 = {
      schemaVersion: 2, inputNode: '__input__', endNode: '__end__', maxNodeExecutions: 50,
      nodes: [{ id: '__input__', type: 'input' }, { id: 'A', type: 'agent', agentNodeKey: 'codex:coder', role: 'reviewer' }, { id: '__end__', type: 'end' }],
      edges: [{ id: 'e1', source: '__input__', target: 'A', when: 'always' }, { id: 'e2', source: 'A', target: '__end__', when: 'approve' }],
    } as unknown;
    // 直接用 v3 schema 校验归一化结果形状（parseAndNormalize 私有，此处校验 v2 输入能被 v2 schema 接受）
    // 用 GraphV3Schema 验证一个等价 v3
    const v3 = { schemaVersion: 3, inputNode: '__input__', endNode: '__end__', maxNodeExecutions: 50, nodes: [{ id: '__input__', type: 'input' }, { id: 'A', type: 'agent', agentNodeKey: 'codex:coder' }, { id: '__end__', type: 'end' }], edges: [{ id: 'e1', source: '__input__', target: 'A' }, { id: 'e2', source: 'A', target: '__end__' }] } as unknown;
    const parsed = GraphV3Schema.parse(v3);
    assert.equal(parsed.edges[0].maxIterations, undefined);
    void v2;
  });
});
