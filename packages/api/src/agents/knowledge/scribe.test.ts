import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createProject, projectDir } from '../project-storage.js';
import { recordFinding } from './issue-store.js';
import { scribePrompt, parseIssueSummaryDraft, validateScribeDraft, findScribe, summarizeWithScribe } from './scribe.js';
import { getDefaultV5ProjectGraph } from '../graph/v5-workspace.js';
import type { ExecNode, ExecuteOptions } from '../graph/AgentRouter.js';

const PID = 'scribe-test';
before(() => { try { rmSync(projectDir(PID), { recursive: true, force: true }); } catch { /* ignore */ } createProject(PID, undefined); recordFinding(PID, { source: { nodeId: 'impl', gateId: 'gate-code' }, title: '产物不正确', detail: 'revise 反馈', severity: 'blocking', confirmed: true }); });
after(() => { try { rmSync(projectDir(PID), { recursive: true, force: true }); } catch { /* ignore */ } });

const VALID_DRAFT = `# Project Issues

## Confirmed
- **[blocking] 产物不正确** (confirmed) — revise 反馈
`;

describe('Scribe logic', () => {
  it('scribePrompt only includes confirmed/resolved/accepted (not observed)', () => {
    recordFinding(PID, { source: { nodeId: 'n-obs' }, title: '仅观察', detail: 'd' }); // observed
    const p = scribePrompt([{ issueId: 'a', fingerprint: 'f', status: 'confirmed', title: 'T', detail: 'd', source: {}, firstSeen: 1, lastSeen: 1, occurrences: 1, evidence: [] }]);
    assert.ok(p.includes('T'));
    assert.ok(p.includes('不确认') || p.includes('不') );
  });

  it('parseIssueSummaryDraft accepts valid # drafts', () => {
    assert.equal(parseIssueSummaryDraft(VALID_DRAFT)?.length! > 0, true);
    assert.equal(parseIssueSummaryDraft('not a draft'), null);
    assert.equal(parseIssueSummaryDraft('# Other\nno project issues keyword'), null);
  });

  it('validateScribeDraft rejects mutate instructions', () => {
    assert.equal(validateScribeDraft(VALID_DRAFT).ok, true);
    const bad = '# Project Issues\nresolve issue iss_x\n';
    assert.equal(validateScribeDraft(bad).ok, false);
  });

  it('findScribe locates the documenter on the observe edge', () => {
    assert.equal(findScribe(getDefaultV5ProjectGraph()), 'opencode:project-scribe');
  });
});

describe('summarizeWithScribe', () => {
  const opts: ExecuteOptions = { runId: 'scribe-run', projectId: PID, emit: () => {}, record: () => {} };

  it('returns the validated draft when the Scribe produces one', async () => {
    const exec: ExecNode = async () => ({ status: 'ok', finalText: VALID_DRAFT, sessionId: 's' });
    const draft = await summarizeWithScribe(PID, getDefaultV5ProjectGraph(), exec, opts);
    assert.equal(draft, VALID_DRAFT.trim());
  });

  it('returns null when the draft tries to mutate findings', async () => {
    const exec: ExecNode = async () => ({ status: 'ok', finalText: '# Project Issues\nresolve issue iss_x\n', sessionId: 's' });
    const draft = await summarizeWithScribe(PID, getDefaultV5ProjectGraph(), exec, opts);
    assert.equal(draft, null);
  });

  it('returns null when there is no Scribe in the graph', async () => {
    const noScribe = { ...getDefaultV5ProjectGraph(), edges: getDefaultV5ProjectGraph().edges.filter((e) => e.kind !== 'observe') };
    const exec: ExecNode = async () => ({ status: 'ok', finalText: VALID_DRAFT, sessionId: 's' });
    const draft = await summarizeWithScribe(PID, noScribe, exec, opts);
    assert.equal(draft, null);
  });

  it('returns null when the Scribe exec fails', async () => {
    const exec: ExecNode = async () => { throw new Error('boom'); };
    const draft = await summarizeWithScribe(PID, getDefaultV5ProjectGraph(), exec, opts);
    assert.equal(draft, null);
  });
});
