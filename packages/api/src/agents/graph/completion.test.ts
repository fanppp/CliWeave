import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCompletion, type CompletionDiagnostic } from './completion.js';

const block = (route: string, category: string, reason = 'reason') =>
  `answer\nROUTE: ${route}\nROUTE_CATEGORY: ${category}\nROUTE_REASON: ${reason}`;
const controlOnly = (route: string, category: string, reason = 'reason') =>
  `ROUTE: ${route}\nROUTE_CATEGORY: ${category}\nROUTE_REASON: ${reason}`;

describe('extractCompletion', () => {
  it('accepts safe finish and strips the control block (ok)', () => {
    const result = extractCompletion(block('FINISH', 'simple_answer'));
    assert.equal(result.decision, 'finish');
    assert.equal(result.artifact, 'answer');
    assert.equal(result.diagnostic, 'ok' satisfies CompletionDiagnostic);
  });

  it('forces change tasks forward even when the model claims finish (unsafe_category)', () => {
    const result = extractCompletion(block('FINISH', 'change'));
    assert.equal(result.decision, 'forward');
    assert.equal(result.artifact, 'answer');
    assert.equal(result.diagnostic, 'unsafe_category' satisfies CompletionDiagnostic);
    assert.equal(result.claim?.action, 'finish');
  });

  it('defaults missing or partial blocks to forward (missing_control / malformed_control)', () => {
    assert.equal(extractCompletion('plain answer').decision, 'forward');
    assert.equal(extractCompletion('plain answer').diagnostic, 'missing_control');
    assert.equal(extractCompletion('answer\nROUTE: FINISH').decision, 'forward');
    assert.equal(extractCompletion('answer\nROUTE: FINISH').diagnostic, 'missing_control');
    // 控制块存在但 category 非法 → malformed_control
    const malformed = extractCompletion('ROUTE: FINISH\nROUTE_CATEGORY: bad_cat\nROUTE_REASON: r');
    assert.equal(malformed.decision, 'forward');
    assert.equal(malformed.diagnostic, 'malformed_control');
    assert.equal(malformed.claim, null);
  });

  it('only accepts clarify for missing_input', () => {
    assert.equal(extractCompletion(block('CLARIFY', 'missing_input')).decision, 'clarify');
    assert.equal(extractCompletion(block('CLARIFY', 'missing_input')).diagnostic, 'ok');
    assert.equal(extractCompletion(block('CLARIFY', 'complex')).decision, 'forward');
    assert.equal(extractCompletion(block('CLARIFY', 'complex')).diagnostic, 'unsafe_category');
  });

  it('marks FINISH/CLARIFY with empty artifact as empty_artifact but keeps V3 decision semantics', () => {
    // finish + 空产物：V3 行为 forward（不早结束）；claim 暴露模型意图供 V4 重试。
    const finishEmpty = extractCompletion(controlOnly('FINISH', 'simple_answer'));
    assert.equal(finishEmpty.decision, 'forward');
    assert.equal(finishEmpty.artifact, '');
    assert.equal(finishEmpty.diagnostic, 'empty_artifact');
    assert.equal(finishEmpty.claim?.action, 'finish');
    // clarify + 空产物：V3 行为 clarify（继续 needs_input）；claim 供 V4 重试。
    const clarifyEmpty = extractCompletion(controlOnly('CLARIFY', 'missing_input'));
    assert.equal(clarifyEmpty.decision, 'clarify');
    assert.equal(clarifyEmpty.artifact, '');
    assert.equal(clarifyEmpty.diagnostic, 'empty_artifact');
    assert.equal(clarifyEmpty.claim?.action, 'clarify');
  });

  it('marks FORWARD with empty artifact as empty_artifact (V4 不重试，直接 run_error)', () => {
    const forwardEmpty = extractCompletion(controlOnly('FORWARD', 'complex'));
    assert.equal(forwardEmpty.decision, 'forward');
    assert.equal(forwardEmpty.artifact, '');
    assert.equal(forwardEmpty.diagnostic, 'empty_artifact');
    assert.equal(forwardEmpty.claim?.action, 'forward');
  });
});
