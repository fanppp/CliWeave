export type RunMode = 'auto' | 'full' | 'quick';

export type CompletionCategory =
  | 'simple_answer'
  | 'read_only_lookup'
  | 'out_of_scope'
  | 'change'
  | 'review'
  | 'test'
  | 'migration'
  | 'security'
  | 'release'
  | 'complex'
  | 'missing_input';

export interface CompletionClaim {
  action: 'finish' | 'forward' | 'clarify';
  category: CompletionCategory;
  reason: string;
}

/** extractCompletion 的失败模式分类（V4.1）。V3 legacy walker 只读 decision，忽略 diagnostic，行为不变。 */
export type CompletionDiagnostic = 'ok' | 'empty_artifact' | 'unsafe_category' | 'malformed_control' | 'missing_control';

export interface ExtractedCompletion {
  artifact: string;
  claim: CompletionClaim | null;
  decision: 'finish' | 'forward' | 'clarify';
  reason: string;
  diagnostic: CompletionDiagnostic;
}

const SAFE_FINISH = new Set<CompletionCategory>(['simple_answer', 'read_only_lookup', 'out_of_scope']);
const CATEGORIES = new Set<CompletionCategory>([
  'simple_answer', 'read_only_lookup', 'out_of_scope', 'change', 'review', 'test',
  'migration', 'security', 'release', 'complex', 'missing_input',
]);

const CONTROL_BLOCK = /(?:^|\n)ROUTE:\s*(FINISH|FORWARD|CLARIFY)\s*\r?\nROUTE_CATEGORY:\s*([a-z_]+)\s*\r?\nROUTE_REASON:\s*([^\r\n]+)\s*$/i;

export const AUTO_ROUTE_INSTRUCTION = `

【运行路由（必须放在回答末尾）】
先完成当前节点职责，再输出且只输出一个控制块：
ROUTE: FINISH | FORWARD | CLARIFY
ROUTE_CATEGORY: simple_answer | read_only_lookup | out_of_scope | change | review | test | migration | security | release | complex | missing_input
ROUTE_REASON: 一行原因

简单问答或只读查询可 FINISH；涉及代码修改、审核、测试、迁移、安全、发布或复杂任务必须 FORWARD；缺少必要信息才 CLARIFY。`;

/**
 * 解析首节点末尾控制块，并按服务端安全规则规范化；无法解析时保守 forward。
 *
 * 决策语义刻意保持与 V3 legacy runner 完全一致（finish+空 artifact → forward；clarify+空 → clarify），
 * 仅新增 `diagnostic` 与 `claim` 让 V4 harness 能识别"模型声明了 FINISH/CLARIFY 但产出为空"并定向重试。
 * 失败模式：
 * - missing_control：根本没有控制块。
 * - malformed_control：控制块存在但 category/reason 非法。
 * - unsafe_category：FINISH 声明了非安全类目（change/review/...）或 CLARIFY 声明了非 missing_input → 强制 forward（仍进 gate）。
 * - empty_artifact：控制块合法且 action 为 FINISH/CLARIFY，但 artifact 为空（V4 定向重试一次）。
 */
export function extractCompletion(text: string): ExtractedCompletion {
  const match = CONTROL_BLOCK.exec(text);
  if (!match) {
    return { artifact: text.trim(), claim: null, decision: 'forward', reason: 'missing route block', diagnostic: 'missing_control' };
  }
  const action = match[1].toLowerCase() as CompletionClaim['action'];
  const rawCategory = match[2].toLowerCase();
  const reason = match[3].trim();
  const artifact = text.slice(0, match.index).trim();
  if (!CATEGORIES.has(rawCategory as CompletionCategory) || !reason) {
    return { artifact: artifact || text.trim(), claim: null, decision: 'forward', reason: 'invalid route category or reason', diagnostic: 'malformed_control' };
  }
  const category = rawCategory as CompletionCategory;
  const claim: CompletionClaim = { action, category, reason };
  if (action === 'finish' && !SAFE_FINISH.has(category)) {
    return { artifact, claim, decision: 'forward', reason: `finish not allowed for category '${category}'`, diagnostic: 'unsafe_category' };
  }
  if (action === 'clarify' && category !== 'missing_input') {
    return { artifact, claim, decision: 'forward', reason: `clarify requires missing_input category`, diagnostic: 'unsafe_category' };
  }
  if (!artifact) {
    // 保留 V3 决策语义：finish+空 → forward（V3 不早结束）；clarify+空 → clarify。V4 用 claim+diagnostic 触发重试。
    const decision = action === 'finish' ? 'forward' : action;
    return { artifact, claim, decision, reason: `empty artifact for ${action}`, diagnostic: 'empty_artifact' };
  }
  return { artifact, claim, decision: action, reason, diagnostic: 'ok' };
}

/** V4.1 定向重试：模型只输出控制块、缺少实质答案时，要求补完整答案 + 控制块。 */
export function completionRetryPrompt(originalPrompt: string): string {
  return `【原始需求】\n${originalPrompt}\n\n你上一版只输出了路由控制块，缺少实质答案。请先输出完整答案，再在回答末尾输出且只输出一个控制块：\nROUTE: FINISH | FORWARD | CLARIFY\nROUTE_CATEGORY: simple_answer | read_only_lookup | out_of_scope | change | review | test | migration | security | release | complex | missing_input\nROUTE_REASON: 一行原因`;
}
