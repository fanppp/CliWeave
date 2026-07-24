/**
 * NodeDescriptor —— 节点配置（数据，不是代码）
 * 存于 agents/<id>.json。加任意 CLI 节点 = 加一份 JSON + provider 类。
 * 借鉴 clowder-ai cat-catalog.json (breeds/variants) 模型。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { getProjectRoot, resolvePathVars } from '../utils/project-root.js';

export const NodeDescriptorSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  cli: z.object({
    command: z.string(),
    sandboxMode: z.string().default('danger-full-access'),
    extraArgs: z.array(z.string()).default([]),
    promptVia: z.enum(['stdin', 'argv']).default('stdin'),
    cwd: z.string().default('${PROJECT_ROOT}'),
  }),
  model: z.string().optional(),
  prompt: z.object({ identity: z.string() }).optional(),
  rules: z.object({ files: z.array(z.string()).default([]) }).optional(),
  skills: z.object({ mcp: z.array(z.record(z.unknown())).default([]) }).optional(),
  memory: z
    .object({
      session: z
        .object({
          resume: z.boolean().default(true),
          dir: z.string(),
        })
        .optional(),
      /** CLI 的 home 目录（项目内，per-node）。codex→CODEX_HOME，claude→CLAUDE_CONFIG_DIR */
      cliHome: z.string().optional(),
    })
    .optional(),
});

export type NodeDescriptor = z.infer<typeof NodeDescriptorSchema>;

function agentsDir(): string {
  return join(getProjectRoot(), 'agents');
}

/** 读取一个节点配置 */
export function readNodeDescriptor(id: string): NodeDescriptor {
  const filePath = join(agentsDir(), `${id}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Node descriptor not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  return NodeDescriptorSchema.parse(parsed);
}

/** 写入一个节点配置（codex 自增/改节点走这） */
export function writeNodeDescriptor(id: string, descriptor: NodeDescriptor): void {
  const dir = agentsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${id}.json`);
  writeFileSync(filePath, JSON.stringify(descriptor, null, 2) + '\n', 'utf-8');
}

/** 列出所有节点 id */
export function listNodeDescriptors(): NodeDescriptor[] {
  const dir = agentsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'graph.json')
    .map((f) => {
      const raw = readFileSync(join(dir, f), 'utf-8');
      return NodeDescriptorSchema.parse(JSON.parse(raw));
    });
}

/** 解析节点配置里的 ${PROJECT_ROOT} 等路径变量 */
export function resolveDescriptorPaths(descriptor: NodeDescriptor): NodeDescriptor {
  return {
    ...descriptor,
    cli: {
      ...descriptor.cli,
      cwd: resolvePathVars(descriptor.cli.cwd),
    },
    memory: descriptor.memory && {
      ...descriptor.memory,
      session: descriptor.memory.session && {
        ...descriptor.memory.session,
        dir: resolvePathVars(descriptor.memory.session.dir),
      },
      ...(descriptor.memory.cliHome ? { cliHome: resolvePathVars(descriptor.memory.cliHome) } : {}),
    },
  };
}
