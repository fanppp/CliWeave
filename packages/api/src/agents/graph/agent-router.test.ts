import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkGraph, type ExecNode, type ExecuteOptions } from './AgentRouter.js';
import type { Graph, GraphAgentNode } from './graph.js';
import type { GraphEvent } from '../../infrastructure/websocket/SocketManager.js';

/**
 * V3 legacy runner 测试：回边 B→A = "不满意→回 A"；前向 = "满意→下一节点"。
 * B 是决策点（有回边出边）→ emit VERDICT：APPROVE=满意→前向；REJECT/无=不满意→回边。
 * 回边覆盖达 maxIter → best-effort（发 gate_exhausted，改走前向，不硬终止）；分支终态 best_effort 跟随至聚合。
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
      { id: 'e3', source: 'B', target: '__end__' },
      { id: 'e4', source: 'B', target: 'A', ...(maxIter != null ? { maxIterations: maxIter } : {}) },
    ],
  };
}

function makeExec(aQueue: string[], bQueue: string[]): ExecNode {
  let callNo = 0;
  return async (node, _prompt, opts, _context) => {
    callNo++;
    opts.emit({ type: 'node_started', runId: opts.runId, nodeId: node.id });
    const finalText = node.id === 'B' ? `review\nVERDICT: ${bQueue.shift() ?? 'REJECT'}` : `A-output-${aQueue.shift() ?? 'x'}`;
    opts.emit({ type: 'node_message', runId: opts.runId, nodeId: node.id, message: { type: 'text', nodeId: node.id, content: finalText, timestamp: Date.now() } });
    opts.emit({ type: 'node_done', runId: opts.runId, nodeId: node.id });
    return { status: 'ok', finalText };
  };
}

/** 通用脚本式 exec：按 nodeId 取下一句 finalText；捕获每个节点收到的 prompt 列表。 */
function makeScriptedExec(scripts: Record<string, string[]>): { exec: ExecNode; prompts: Record<string, string[]> } {
  const prompts: Record<string, string[]> = {};
  const exec: ExecNode = async (node, prompt, opts, _context) => {
    (prompts[node.id] ??= []).push(prompt);
    opts.emit({ type: 'node_started', runId: opts.runId, nodeId: node.id });
    const finalText = (scripts[node.id] ?? []).shift() ?? `${node.id}-out`;
    opts.emit({ type: 'node_message', runId: opts.runId, nodeId: node.id, message: { type: 'text', nodeId: node.id, content: finalText, timestamp: Date.now() } });
    opts.emit({ type: 'node_done', runId: opts.runId, nodeId: node.id });
    return { status: 'ok', finalText };
  };
  return { exec, prompts };
}

async function runWalkAsync(g: Graph, exec: ExecNode, signal?: AbortSignal): Promise<GraphEvent[]> {
  const events: GraphEvent[] = [];
  const opts: ExecuteOptions = {
    runId: 'test-run',
    projectId: 'default',
    emit: (e) => events.push(e),
    record: () => undefined,
    ...(signal ? { signal } : {}),
  };
  await walkGraph('需求', g, opts, exec);
  return events;
}

function terminal(events: GraphEvent[]): GraphEvent | undefined {
  return events.find((e) => e.type === 'run_done' || e.type === 'run_error' || e.type === 'run_aborted');
}

/** 提取 prompt 的【区段名】内容（到下一个【...】tag 或空行 \n\n 为止）。仅测试用。 */
function region(prompt: string, name: string): string {
  const tag = `【${name}】`;
  const start = prompt.indexOf(tag);
  if (start < 0) return '';
  const rest = prompt.slice(start + tag.length);
  const nextTag = rest.search(/【[^】]+】/);
  const blankLine = rest.indexOf('\n\n');
  let end: number;
  if (nextTag < 0 && blankLine < 0) end = rest.length;
  else if (nextTag < 0) end = blankLine;
  else if (blankLine < 0) end = nextTag;
  else end = Math.min(nextTag, blankLine);
  return rest.slice(0, end).trim();
}

describe('walkGraph V3 legacy runner', () => {
  it('满意 → run_done completed', async () => {
    const ev = await runWalkAsync(makeGraph(3), makeExec(['1'], ['APPROVE']));
    const t = terminal(ev) as { type: string; termination: string };
    assert.equal(t.type, 'run_done');
    assert.equal(t.termination, 'completed');
  });

  it('不满意两次后满意 → run_done completed（A 跑 3 次）', async () => {
    const exec = makeExec(['1', '2', '3'], ['REJECT', 'REJECT', 'APPROVE']);
    const calls: string[] = [];
    const wrapped: ExecNode = async (n, p, o, c) => { calls.push(n.id); return exec(n, p, o, c); };
    const ev = await runWalkAsync(makeGraph(3), wrapped);
    const t = terminal(ev) as { type: string; termination: string };
    assert.equal(t.type, 'run_done');
    assert.equal(t.termination, 'completed');
    assert.equal(calls.filter((c) => c === 'A').length, 3);
  });

  it('回边覆盖次数达 maxIter=2 → best_effort（A 跑 3 次，采用最后生产者版本，继续前向到 end）', async () => {
    const ev = await runWalkAsync(makeGraph(2), makeExec(['1', '2', '3'], ['REJECT', 'REJECT', 'REJECT']));
    const t = terminal(ev) as { type: string; termination: string; finalText: string };
    assert.equal(t.type, 'run_done');
    assert.equal(t.termination, 'best_effort');
    assert.equal(t.finalText, 'A-output-3');
    // gate_exhausted 事件已发（含最后产物 + reviewer feedback）
    const gx = ev.find((e) => e.type === 'gate_exhausted') as Extract<GraphEvent, { type: 'gate_exhausted' }>;
    assert.ok(gx, 'gate_exhausted emitted');
    assert.equal(gx.lastProducerArtifact, 'A-output-3');
    assert.ok(gx.reviewerFeedback);
  });

  it('缺 verdict（非 APPROVE/REJECT）→ 当不满意走回边；预算耗尽 → best_effort', async () => {
    const ev = await runWalkAsync(makeGraph(2), makeExec(['1', '2', '3'], ['XXX', 'XXX', 'XXX']));
    const t = terminal(ev) as { type: string; termination: string };
    assert.equal(t.type, 'run_done');
    assert.equal(t.termination, 'best_effort');
  });

  it('决策点满意但无前向边 → run_done completed', async () => {
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
    const exec: ExecNode = async (node, _prompt, opts, _context) => {
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

  it('默认 maxIter=1（回边未配 maxIterations）→ best_effort，reason 含 maxIterations 1', async () => {
    const g = makeGraph(undefined);
    const ev = await runWalkAsync(g, makeExec(['1', '2'], ['REJECT', 'REJECT']));
    const t = terminal(ev) as { type: string; termination: string; reason?: string };
    assert.equal(t.type, 'run_done');
    assert.equal(t.termination, 'best_effort');
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
    const exec: ExecNode = async (node, _p, opts, _context) => {
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

  it('多分支：一分支 best_effort + 一分支 completed → 聚合 best_effort（下游成功不抹掉降级事实）', async () => {
    // 分支1：A1→B1(decision, back→A1, forward→end) 全 REJECT → best_effort
    // 分支2：A2→end 直通 → completed
    const g: Graph = {
      schemaVersion: 3, inputNode: '__input__', endNode: '__end__', maxNodeExecutions: 50,
      nodes: [
        { id: '__input__', type: 'input' },
        { id: 'A1', type: 'agent', agentNodeKey: 'codex:coder' },
        { id: 'B1', type: 'agent', agentNodeKey: 'claude:claude-node' },
        { id: 'A2', type: 'agent', agentNodeKey: 'codex:coder2' },
        { id: '__end__', type: 'end' },
      ],
      edges: [
        { id: '__input__->A1', source: '__input__', target: 'A1' },
        { id: '__input__->A2', source: '__input__', target: 'A2' },
        { id: 'A1->B1', source: 'A1', target: 'B1' },
        { id: 'B1->__end__', source: 'B1', target: '__end__' },
        { id: 'B1->A1', source: 'B1', target: 'A1', maxIterations: 1 },
        { id: 'A2->__end__', source: 'A2', target: '__end__' },
      ],
    };
    const { exec } = makeScriptedExec({
      A1: ['A1-v1', 'A1-v2'],
      B1: ['review\nVERDICT: REJECT', 'review\nVERDICT: REJECT'],
      A2: ['A2-v1'],
    });
    const ev = await runWalkAsync(g, exec);
    const t = terminal(ev) as { type: string; termination: string };
    assert.equal(t.type, 'run_done');
    assert.equal(t.termination, 'best_effort');
  });

  it('prompt 稳定分区：rework 时【上游产物】只含 producer artifact，reviewer 文本不入此区；【审核元数据】含 verdict/feedback', async () => {
    const { exec, prompts } = makeScriptedExec({
      A: ['A-output-1', 'A-output-2'],
      B: ['review\nVERDICT: REJECT', 'review\nVERDICT: APPROVE'],
    });
    await runWalkAsync(makeGraph(3), exec);
    // A 跑了 2 次（初稿 + rework）；第 2 次 prompt 是 rework
    const aPrompts = prompts['A'] ?? [];
    assert.equal(aPrompts.length, 2, 'A runs twice');
    const reworkPrompt = aPrompts[1];
    const upstream = region(reworkPrompt, '上游产物');
    const review = region(reworkPrompt, '审核元数据');
    assert.equal(upstream, 'A-output-1', '上游产物 = producer 上一版');
    assert.ok(!upstream.includes('VERDICT'), 'reviewer 文本不入【上游产物】');
    assert.ok(!upstream.includes('review'), 'reviewer raw output 不入【上游产物】');
    assert.ok(review.includes('REJECT'), '【审核元数据】含 REJECT');
    // B（decision）prompt：含【待裁定内容】=A 产出，不含【审核元数据】
    const bPrompt = (prompts['B'] ?? [])[0];
    const toJudge = region(bPrompt, '待裁定内容');
    assert.equal(toJudge, 'A-output-1');
    assert.ok(!bPrompt.includes('【审核元数据】'), 'decision 不消费旧 review metadata');
  });

  it('metadata 生命周期：C 消费 B 的 approve 元数据；C 产出后 D 不再收到过期 metadata', async () => {
    // input→A→B(decision, back→A, forward→C)→C→D→end
    const g: Graph = {
      schemaVersion: 3, inputNode: '__input__', endNode: '__end__', maxNodeExecutions: 50,
      nodes: [
        { id: '__input__', type: 'input' },
        { id: 'A', type: 'agent', agentNodeKey: 'codex:coder' },
        { id: 'B', type: 'agent', agentNodeKey: 'claude:claude-node' },
        { id: 'C', type: 'agent', agentNodeKey: 'codex:coder2' },
        { id: 'D', type: 'agent', agentNodeKey: 'codex:coder3' },
        { id: '__end__', type: 'end' },
      ],
      edges: [
        { id: '__input__->A', source: '__input__', target: 'A' },
        { id: 'A->B', source: 'A', target: 'B' },
        { id: 'B->C', source: 'B', target: 'C' },
        { id: 'C->D', source: 'C', target: 'D' },
        { id: 'D->__end__', source: 'D', target: '__end__' },
        { id: 'B->A', source: 'B', target: 'A', maxIterations: 3 },
      ],
    };
    const { exec, prompts } = makeScriptedExec({
      A: ['A-artifact'],
      B: ['review\nVERDICT: APPROVE'],
      C: ['C-artifact'],
      D: ['D-artifact'],
    });
    const ev = await runWalkAsync(g, exec);
    const t = terminal(ev) as { type: string; termination: string };
    assert.equal(t.termination, 'completed');
    // C 收到 B 的 approve 元数据 + A 的产物
    const cPrompt = (prompts['C'] ?? [])[0];
    assert.equal(region(cPrompt, '上游产物'), 'A-artifact');
    assert.ok(region(cPrompt, '审核元数据').includes('APPROVE'), 'C 拿到 B 的 approve metadata');
    // C 产出后 D 不再收到 C 的（或 B 的）过期 metadata
    const dPrompt = (prompts['D'] ?? [])[0];
    assert.equal(region(dPrompt, '上游产物'), 'C-artifact');
    assert.ok(!dPrompt.includes('【审核元数据】'), 'D 不收到过期 metadata（C 产出已清）');
  });

  it('convergence：多前向上游的 join 节点等齐再跑一次、聚合所有上游产物（不再每来一个上游跑一次）', async () => {
    // input→A→B(decision, back→A, forward→C) + input→C(直连)
    // C 有两条前向入边（input 直连 + B approve 前向）：应等齐两上游再跑一次，聚合产物
    const g: Graph = {
      schemaVersion: 3, inputNode: '__input__', maxNodeExecutions: 50,
      nodes: [
        { id: '__input__', type: 'input' },
        { id: 'A', type: 'agent', agentNodeKey: 'codex:coder' },
        { id: 'B', type: 'agent', agentNodeKey: 'claude:claude-node' },
        { id: 'C', type: 'agent', agentNodeKey: 'codex:coder2' },
      ],
      edges: [
        { id: '__input__->A', source: '__input__', target: 'A' },
        { id: 'A->B', source: 'A', target: 'B' },
        { id: 'B->A', source: 'B', target: 'A', maxIterations: 3 }, // 回边：B 决策点
        { id: 'B->C', source: 'B', target: 'C' },                   // B approve→C
        { id: '__input__->C', source: '__input__', target: 'C' },   // input 直连 C（join 第二入边）
      ],
    };
    const { exec, prompts } = makeScriptedExec({
      A: ['A-artifact'],
      B: ['review\nVERDICT: APPROVE'],
      C: ['C-artifact'],
    });
    const ev = await runWalkAsync(g, exec);
    const t = terminal(ev) as { type: string; termination: string; finalText: string };
    assert.equal(t.termination, 'completed');
    assert.equal(t.finalText, 'C-artifact');
    // C 只跑一次（不再每来一个上游跑一次）
    const cPrompts = prompts['C'] ?? [];
    assert.equal(cPrompts.length, 1, 'C runs exactly once (join)');
    // C 的【上游产物】聚合两上游：input 直连产物(需求) + B 路径的 producer 产物(A-artifact)
    const upstream = region(cPrompts[0], '上游产物');
    assert.ok(upstream.includes('需求'), 'C 聚合 input 直连产物');
    assert.ok(upstream.includes('A-artifact'), 'C 聚合 B 路径的 producer 产物');
  });

  it('walk 策略：producer 首执行 fresh，rework resume(producerSid)，decision/join fresh；全程无 active', async () => {
    // A→B(decision, back→A)：B reject 一次后 approve → A 跑 2 次（fresh + resume），B 每次 fresh
    const bQueue = ['REJECT', 'APPROVE'];
    const aSid = 'A-session-id';
    const policies: { node: string; mode: string; sid?: string }[] = [];
    const exec: ExecNode = async (node, _prompt, opts, context) => {
      policies.push({
        node: node.id,
        mode: context.sessionPolicy.mode,
        ...(context.sessionPolicy.mode === 'resume' ? { sid: context.sessionPolicy.sessionId } : {}),
      });
      opts.emit({ type: 'node_started', runId: opts.runId, nodeId: node.id });
      const finalText = node.id === 'B' ? `review\nVERDICT: ${bQueue.shift()}` : 'A-out';
      opts.emit({ type: 'node_message', runId: opts.runId, nodeId: node.id, message: { type: 'text', nodeId: node.id, content: finalText, timestamp: Date.now() } });
      opts.emit({ type: 'node_done', runId: opts.runId, nodeId: node.id });
      return { status: 'ok', finalText, ...(node.id === 'A' ? { sessionId: aSid } : {}) };
    };
    await runWalkAsync(makeGraph(3), exec);
    const aPolicies = policies.filter((p) => p.node === 'A');
    const bPolicies = policies.filter((p) => p.node === 'B');
    assert.equal(aPolicies.length, 2, 'A 跑 2 次（初稿 + rework）');
    assert.equal(aPolicies[0].mode, 'fresh', 'A 初稿 fresh');
    assert.equal(aPolicies[1].mode, 'resume', 'A rework resume');
    assert.equal(aPolicies[1].sid, aSid, 'rework resume 用 producer 的 sessionId');
    assert.ok(bPolicies.every((p) => p.mode === 'fresh'), 'decision 每次 fresh');
    assert.ok(policies.every((p) => p.mode !== 'active'), '图运行全程不传 active → 不触碰 active-session.json');
  });
});

// 防止未用 import 报错
void (null as unknown as GraphAgentNode);
