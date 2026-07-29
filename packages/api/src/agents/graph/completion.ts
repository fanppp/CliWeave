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

export interface ExtractedCompletion {
  artifact: string;
  claim: CompletionClaim | null;
  decision: 'finish' | 'forward' | 'clarify';
  reason: string;
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

/** 解析首节点末尾控制块，并按服务端安全规则规范化；无法解析时保守 forward。 */
export function extractCompletion(text: string): ExtractedCompletion {
  const match = CONTROL_BLOCK.exec(text);
  if (!match) return { artifact: text.trim(), claim: null, decision: 'forward', reason: 'missing or malformed route block' };
  const action = match[1].toLowerCase() as CompletionClaim['action'];
  const category = match[2].toLowerCase() as CompletionCategory;
  const reason = match[3].trim();
  const artifact = text.slice(0, match.index).trim();
  if (!CATEGORIES.has(category) || !reason) {
    return { artifact: artifact || text.trim(), claim: null, decision: 'forward', reason: 'invalid route category or reason' };
  }
  const claim: CompletionClaim = { action, category, reason };
  if (action === 'finish' && (!SAFE_FINISH.has(category) || !artifact)) {
    return { artifact, claim, decision: 'forward', reason: `finish not allowed for category '${category}'` };
  }
  if (action === 'clarify' && category !== 'missing_input') {
    return { artifact, claim, decision: 'forward', reason: 'clarify requires missing_input category' };
  }
  return { artifact, claim, decision: action, reason };
}
