/**
 * instanceKey —— 画布作用域的节点实例身份键。
 *
 * instanceKey = `${projectId}:${nodeKey}`，其中 nodeKey = `${provider}:${localId}`。
 * 例：`default:codex:codex-node`。含两个冒号，因此 parseInstanceKey 只切第一个冒号
 * 得到 projectId，余下作为 nodeKey 再单独校验。
 *
 * mutex、WS room、日志、事件过滤、RunRegistry 一律用 formatInstanceKey/parseInstanceKey，
 * 禁止各处手写 split(':')。
 */
import { z } from 'zod';

/** projectId 字符集（与 node-key 同源；default 为保留常量）。 */
export const ProjectIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, 'invalid project id');

/**
 * nodeKey 完整正则。与 NodeDescriptor 的 ProviderIdSchema/LocalIdSchema 组合等价，
 * 此处独立定义以打破 instance-key ↔ NodeDescriptor 的循环依赖。
 * 改动任一处时须同步另一处。
 */
const NodeKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9_-]*$/, 'invalid node key (expected provider:localId)');

/** 概念上的实例键（运行时即 string，便于透传）。 */
export type InstanceKey = string;

/** 拼接 projectId + nodeKey 为 instanceKey（校验两者合法性）。 */
export function formatInstanceKey(projectId: string, nodeKey: string): InstanceKey {
  ProjectIdSchema.parse(projectId);
  NodeKeySchema.parse(nodeKey);
  return `${projectId}:${nodeKey}`;
}

/** 解析 instanceKey：只切第一个冒号 → { projectId, nodeKey }；重新校验 nodeKey。 */
export function parseInstanceKey(s: string): { projectId: string; nodeKey: string } {
  const i = s.indexOf(':');
  if (i <= 0) throw new Error(`invalid instanceKey: ${s}`);
  const projectId = s.slice(0, i);
  const nodeKey = s.slice(i + 1);
  ProjectIdSchema.parse(projectId);
  NodeKeySchema.parse(nodeKey); // 重新校验 nodeKey
  return { projectId, nodeKey };
}

/** 校验某字符串是否为合法 instanceKey（用于 WS join_node 等入口拒绝任意字符串）。 */
export function isInstanceKey(s: string): boolean {
  try {
    parseInstanceKey(s);
    return true;
  } catch {
    return false;
  }
}
