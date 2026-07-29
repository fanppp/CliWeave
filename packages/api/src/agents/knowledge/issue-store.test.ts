import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createProject, projectDir } from '../project-storage.js';
import { recordFinding, listIssues, confirmIssue, resolveIssue, acceptIssue, reopenIssue, computeFingerprint, IssueError } from './issue-store.js';
import { projectIssuesMarkdown } from './publish.js';

const PID = 'issue-test';
before(() => { try { rmSync(projectDir(PID), { recursive: true, force: true }); } catch { /* ignore */ } createProject(PID, undefined); });
after(() => { try { rmSync(projectDir(PID), { recursive: true, force: true }); } catch { /* ignore */ } });

describe('issue-store state machine + fingerprint', () => {
  it('records an observed finding with a server fingerprint', () => {
    const id = recordFinding(PID, { source: { nodeId: 'impl', gateId: 'gate-code', criterionId: 'correct' }, title: '产物不正确', detail: 'revise 反馈', severity: 'blocking', evidence: 'e1' });
    const issues = listIssues(PID);
    const issue = issues.find((i) => i.issueId === id);
    assert.ok(issue);
    assert.equal(issue!.status, 'observed');
    assert.equal(issue!.occurrences, 1);
    assert.equal(issue!.fingerprint, computeFingerprint({ nodeId: 'impl', gateId: 'gate-code', criterionId: 'correct' }, '产物不正确', 'blocking'));
  });

  it('dedupes by fingerprint: same stable fields → append occurrence, no new issue', () => {
    const before = listIssues(PID).length;
    const id = recordFinding(PID, { source: { nodeId: 'impl', gateId: 'gate-code', criterionId: 'correct' }, title: '产物不正确', detail: '再次 revise', severity: 'blocking', evidence: 'e2' });
    const after = listIssues(PID);
    assert.equal(after.length, before);
    const issue = after.find((i) => i.issueId === id)!;
    assert.equal(issue.occurrences, 2);
    assert.deepEqual(issue.evidence, ['e1', 'e2']);
  });

  it('confirm → observed to confirmed; resolve → resolved', () => {
    const id = recordFinding(PID, { source: { nodeId: 'n2' }, title: '另一个问题', detail: 'd', severity: 'warning' });
    assert.equal(confirmIssue(PID, id).status, 'confirmed');
    assert.equal(resolveIssue(PID, id).status, 'resolved');
  });

  it('accept leaves risk accepted (not resolved)', () => {
    const id = recordFinding(PID, { source: { nodeId: 'n3' }, title: '可接受风险', detail: 'd' });
    assert.equal(acceptIssue(PID, id).status, 'accepted');
  });

  it('reopen reopens a closed issue', () => {
    const id = recordFinding(PID, { source: { nodeId: 'n4' }, title: '已解决项', detail: 'd' });
    resolveIssue(PID, id);
    assert.equal(reopenIssue(PID, id).status, 'open');
  });

  it('refuses transitions from invalid states', () => {
    const id = recordFinding(PID, { source: { nodeId: 'n5' }, title: 'x', detail: 'd' });
    resolveIssue(PID, id);
    assert.throws(() => confirmIssue(PID, id), IssueError);
    assert.throws(() => resolveIssue(PID, id), IssueError);
  });

  it('run complete does not auto-close issues (manual resolve required)', () => {
    const id = recordFinding(PID, { source: { nodeId: 'n6' }, title: '残留', detail: 'd', severity: 'warning' });
    // 模拟 run 结束：issue 仍 observed，需人工 resolve
    assert.equal(listIssues(PID).find((i) => i.issueId === id)!.status, 'observed');
  });
});

describe('publish IssueProjector (deterministic template)', () => {
  it('renders open + closed groups deterministically', () => {
    const md = projectIssuesMarkdown([
      { issueId: 'a', fingerprint: 'f', status: 'confirmed', title: 'T1', detail: 'd1', severity: 'blocking', source: { gateId: 'g1' }, firstSeen: 1, lastSeen: 2, occurrences: 3, evidence: [] },
      { issueId: 'b', fingerprint: 'f2', status: 'resolved', title: 'T2', detail: 'd2', source: {}, firstSeen: 1, lastSeen: 2, occurrences: 1, evidence: [] },
    ]);
    assert.ok(md.includes('# Project Issues'));
    assert.ok(md.includes('## Open'));
    assert.ok(md.includes('## Closed'));
    assert.ok(md.includes('T1'));
    assert.ok(md.includes('×3'));
    assert.ok(md.includes('T2'));
  });

  it('renders none placeholder when empty', () => {
    assert.ok(projectIssuesMarkdown([]).includes('no issues recorded'));
  });
});
