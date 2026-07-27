import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkGraph, type ExecNode, type ExecuteOptions } from './AgentRouter.js';
import type { Graph, GraphAgentNode } from './graph.js';
import type { GraphEvent } from '../../infrastructure/websocket/SocketManager.js';

/**
 * v3 简化模型测试：回边 B→A = "不满意→回 A"；前向边 B→__end__ = "满意→结束"。
 * B 是决策点（有回边出边）→ emit VERDICT：APPROVE=满意→前向；REJECT/无=不满意→回边。
 */
function makeGraph(maxIter: number | undefined): Graph {
  return {
    schemaVersion: 3,
    inputNode: '__input__',
    endNode: '__end__',
    maxNodeExecutions: 50,
    nodes: [
      { id: '__input__', type: 'input' },
      { id: 'A', type: 'agent', agentNodeKey: 'codex:coder' },
      { id: 'B', type: 'agent', agentNodeKey: 'claude:claude-node' },
      { id: '__end__', type: 'end' },
    ],
    edges: [
      { id: 'e1', source: '__input__', target: 'A' },
      { id: 'e2', source: 'A', target: 'B' },
      { id: 'e3', source: 'B', target: '__end__' }, // 前向：满意→结束
      { id: 'e4', source: 'B', target: 'A', ...(maxIter != null ? { maxIterations: maxIter } : {}) }, // 回边：不满意→回 A
    ],
  };
}

function makeExec(aQueue: string[], bQueue: string[]): ExecNode {
  let callNo = 0;
  return async (node, _prompt, opts) => {
    callNo++;
    opts.emit({ type: 'node_started', runId: opts.runId, nodeId: node.id });
    const finalText = node.id === 'B' ? `review\nVERDICT: ${bQueue.shift() ?? 'REJECT'}` : `A-output-${aQueue.shift() ?? 'x'}`;
    opts.emit({ type: 'node_message', runId: opts.runId, nodeId: node.id, message: { type: 'text', nodeId: node.id, content: finalText, timestamp: Date.now() } });
    opts.emit({ type: 'node_done', runId: opts.runId, nodeId: node.id });
    return { status: 'ok', finalText };
  };
}

async function runWalkAsync(g: Graph, exec: ExecNode, signal?: AbortSignal): Promise<GraphEvent[]> {
  const events: GraphEvent[] = [];
  const opts: ExecuteOptions = { runId: 'test-run', emit: (e) => events.push(e), ...(signal ? { signal } : {}) };
  await walkGraph('需求', g, opts, exec);
  return events;
}

function terminal(events: GraphEvent[]): GraphEvent | undefined {
  return events.find((e) => e.type === 'run_done' || e.type === 'run_error' || e.type === 'run_aborted');
}

describe('walkGraph 纯方向驱动', () => {
  it('满意 → run_done completed', async () => {
    const ev = await runWalkAsync(makeGraph(3), makeExec(['1'], ['APPROVE']));
    const t = terminal(ev) as { type: string; termination: string };
    assert.equal(t.type, 'run_done');
    assert.equal(t.termination, 'completed');
  });

  it('不满意两次后满意 → run_done completed（A 跑 3 次）', async () => {
    const exec = makeExec(['1', '2', '3'], ['REJECT', 'REJECT', 'APPROVE']);
    const calls: string[] = [];
    const wrapped: ExecNode = async (n, p, o) => { calls.push(n.id); return exec(n, p, o); };
    const ev = await runWalkAsync(makeGraph(3), wrapped);
    const t = terminal(ev) as { type: string; termination: string };
    assert.equal(t.type, 'run_done');
    assert.equal(t.termination, 'completed');
    assert.equal(calls.filter((c) => c === 'A').length, 3);
  });

  it('回边覆盖次数达 maxIter=2 → run_done edge_limit（A 跑 1+2=3 次，采用最后生产者版本）', async () => {
    const ev = await runWalkAsync(makeGraph(2), makeExec(['1', '2', '3'], ['REJECT', 'REJECT', 'REJECT']));
    const t = terminal(ev) as { type: string; termination: string; finalText: string };
    assert.equal(t.type, 'run_done');
    assert.equal(t.termination, 'edge_limit');
    assert.equal(t.finalText, 'A-output-3');
  });

  it('缺 verdict（非 APPROVE/REJECT）→ 当不满意走回边', async () => {
    const ev = await runWalkAsync(makeGraph(2), makeExec(['1', '2', '3'], ['XXX', 'XXX', 'XXX']));
    const t = terminal(ev) as { type: string; termination: string };
    assert.equal(t.type, 'run_done');
    assert.equal(t.termination, 'edge_limit'); // 覆盖 2 次后达上限
  });

  it('决策点满意但无前向边 → run_done completed', async () => {
    // B 只有回边 e4，无前向 e3 → 满意时无前向→completed
    const g: Graph = {
      schemaVersion: 3, inputNode: '__input__', maxNodeExecutions: 50,
      nodes: [{ id: '__input__', type: 'input' }, { id: 'A', type: 'agent', agentNodeKey: 'codex:coder' }, { id: 'B', type: 'agent', agentNodeKey: 'claude:claude-node' }],
      edges: [{ id: 'e1', source: '__input__', target: 'A' }, { id: 'e2', source: 'A', target: 'B' }, { id: 'e4', source: 'B', target: 'A', maxIterations: 3 }],
    };
    const ev = await runWalkAsync(g, makeExec(['1'], ['APPROVE']));
    const t = terminal(ev);
    assert.equal(t?.type, 'run_done');
  });

  it('abort 循环中只发一次 run_aborted', async () => {
    const g = makeGraph(3);
    const controller = new AbortController();
    let callNo = 0;
    const aQ = ['1', '2', '3'];
    const bQ = ['REJECT', 'REJECT', 'APPROVE'];
    const exec: ExecNode = async (node, _prompt, opts) => {
      callNo++;
      if (callNo === 3) { controller.abort(); return { status: 'aborted' as const }; }
      opts.emit({ type: 'node_started', runId: opts.runId, nodeId: node.id });
      const finalText = node.id === 'B' ? `review\nVERDICT: ${bQ.shift()}` : `A-output-${aQ.shift()}`;
      opts.emit({ type: 'node_message', runId: opts.runId, nodeId: node.id, message: { type: 'text', nodeId: node.id, content: finalText, timestamp: Date.now() } });
      opts.emit({ type: 'node_done', runId: opts.runId, nodeId: node.id });
      return { status: 'ok' as const, finalText };
    };
    const ev = await runWalkAsync(g, exec, controller.signal);
    assert.equal(ev.filter((e) => e.type === 'run_aborted').length, 1);
  });

  it('node_iteration + 带 termination 的 run_done', async () => {
    const ev = await runWalkAsync(makeGraph(3), makeExec(['1', '2'], ['REJECT', 'APPROVE']));
    assert.ok(ev.some((e) => e.type === 'node_iteration'));
    const done = ev.find((e) => e.type === 'run_done') as { termination: string; finalText: string };
    assert.ok(done.termination);
    assert.ok(done.finalText !== undefined);
  });

  it('默认 maxIter=1（回边未配 maxIterations）', async () => {
    const g = makeGraph(undefined); // e4 无 maxIterations → 默认 1
    const ev = await runWalkAsync(g, makeExec(['1', '2'], ['REJECT', 'REJECT']));
    const t = terminal(ev) as { type: string; termination: string; reason?: string };
    assert.equal(t.type, 'run_done');
    assert.equal(t.termination, 'edge_limit');
    assert.match(t.reason ?? '', /maxIterations 1/);
  });

  it('input 扇出 → A/B 并行各跑一次，finalText 含两者产出', async () => {
    const g: Graph = {
      schemaVersion: 3, inputNode: '__input__', endNode: '__end__', maxNodeExecutions: 50,
      nodes: [
        { id: '__input__', type: 'input' },
        { id: 'A', type: 'agent', agentNodeKey: 'codex:coder' },
        { id: 'B', type: 'agent', agentNodeKey: 'claude:claude-node' },
        { id: '__end__', type: 'end' },
      ],
      edges: [
        { id: '__input__->A', source: '__input__', target: 'A' },
        { id: '__input__->B', source: '__input__', target: 'B' },
        { id: 'A->__end__', source: 'A', target: '__end__' },
        { id: 'B->__end__', source: 'B', target: '__end__' },
      ],
    };
    const calls: string[] = [];
    const exec: ExecNode = async (node, _p, opts) => {
      calls.push(node.id);
      opts.emit({ type: 'node_started', runId: opts.runId, nodeId: node.id });
      const finalText = `${node.id}-out`;
      opts.emit({ type: 'node_message', runId: opts.runId, nodeId: node.id, message: { type: 'text', nodeId: node.id, content: finalText, timestamp: Date.now() } });
      opts.emit({ type: 'node_done', runId: opts.runId, nodeId: node.id });
      return { status: 'ok', finalText };
    };
    const ev = await runWalkAsync(g, exec);
    const done = ev.find((e) => e.type === 'run_done') as { termination: string; finalText: string };
    assert.equal(done.termination, 'completed');
    assert.equal(calls.filter((c) => c === 'A').length, 1);
    assert.equal(calls.filter((c) => c === 'B').length, 1);
    assert.ok(done.finalText.includes('A-out'));
    assert.ok(done.finalText.includes('B-out'));
  });
});

// 防止未用 import 报错
void (null as unknown as GraphAgentNode);
