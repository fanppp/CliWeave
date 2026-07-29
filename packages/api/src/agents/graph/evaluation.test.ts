import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractEvaluation, selectBest, type Candidate, type Rubric } from './evaluation.js';

const rubric: Rubric = {
  schemaVersion: 1,
  name: 'engineering',
  criteria: [
    { id: 'correct', description: 'correct', required: true, weight: 5 },
    { id: 'tested', description: 'tested', required: true, weight: 3 },
    { id: 'clear', description: 'clear', required: false, weight: 1 },
  ],
};

const scored = (candidateId: string, verdict: 'approve' | 'revise', correct: boolean, tested: boolean, score: number) => JSON.stringify({
  candidateId, verdict, score, confidence: 0.8,
  criteria: [
    { id: 'correct', passed: correct, severity: correct ? 'info' : 'blocking', evidence: 'c' },
    { id: 'tested', passed: tested, severity: tested ? 'info' : 'warning', evidence: 't' },
    { id: 'clear', passed: true, severity: 'info', evidence: 'x' },
  ], feedback: 'revise it',
});

describe('Evaluation contract', () => {
  it('normalizes approve to revise when a required criterion fails', () => {
    assert.equal(extractEvaluation(scored('c1', 'approve', true, false, 90), 'c1', rubric).verdict, 'revise');
  });

  it('rejects unknown, duplicate, and missing required criteria', () => {
    const raw = JSON.parse(scored('c1', 'approve', true, true, 90));
    raw.criteria[0].id = 'unknown';
    assert.throws(() => extractEvaluation(JSON.stringify(raw), 'c1', rubric), /unknown/);
    raw.criteria = [raw.criteria[1], raw.criteria[1]];
    assert.throws(() => extractEvaluation(JSON.stringify(raw), 'c1', rubric), /duplicate|required/);
  });

  it('excludes blocked candidates and ranks by required failures before score and revision', () => {
    const candidates: Candidate[] = [
      { id: 'blocked', branchId: 'b', workNodeId: 'w', revision: 4, artifact: 'x', evaluations: { gate: { candidateId: 'blocked', verdict: 'blocked', reason: 'no repo', missingRequirements: ['repo'] } } },
      { id: 'high-score-bad', branchId: 'b', workNodeId: 'w', revision: 2, artifact: 'bad', evaluations: { gate: extractEvaluation(scored('high-score-bad', 'revise', true, false, 99), 'high-score-bad', rubric) } },
      { id: 'lower-score-good', branchId: 'b', workNodeId: 'w', revision: 1, artifact: 'good', evaluations: { gate: extractEvaluation(scored('lower-score-good', 'approve', true, true, 80), 'lower-score-good', rubric) } },
    ];
    assert.equal(selectBest(candidates, 'gate', rubric)?.id, 'lower-score-good');
    assert.equal(selectBest(candidates.slice(0, 1), 'gate', rubric), null);
  });
});
