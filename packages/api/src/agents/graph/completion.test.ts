import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCompletion } from './completion.js';

const block = (route: string, category: string, reason = 'reason') =>
  `answer\nROUTE: ${route}\nROUTE_CATEGORY: ${category}\nROUTE_REASON: ${reason}`;

describe('extractCompletion', () => {
  it('accepts safe finish and strips the control block', () => {
    const result = extractCompletion(block('FINISH', 'simple_answer'));
    assert.equal(result.decision, 'finish');
    assert.equal(result.artifact, 'answer');
  });

  it('forces change tasks forward even when the model claims finish', () => {
    const result = extractCompletion(block('FINISH', 'change'));
    assert.equal(result.decision, 'forward');
    assert.equal(result.artifact, 'answer');
  });

  it('defaults malformed or missing blocks to forward', () => {
    assert.equal(extractCompletion('plain answer').decision, 'forward');
    assert.equal(extractCompletion('answer\nROUTE: FINISH').decision, 'forward');
  });

  it('only accepts clarify for missing_input', () => {
    assert.equal(extractCompletion(block('CLARIFY', 'missing_input')).decision, 'clarify');
    assert.equal(extractCompletion(block('CLARIFY', 'complex')).decision, 'forward');
  });
});
