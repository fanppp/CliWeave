import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeTempEnv, resolveNodeCliHome } from './cli-storage.js';
import { resolveSharedStorageRoot } from './node-storage-migration.js';
import { assertNodeStorageOwnership, type NodeDescriptor } from './NodeDescriptor.js';
import { writeOpencodeConfig } from './opencode-home.js';

function descriptor(cliHome?: string): NodeDescriptor {
  return {
    schemaVersion: 2,
    id: 'storage-test',
    name: 'storage-test',
    provider: 'opencode',
    cli: { command: 'opencode', sandboxMode: 'danger-full-access', extraArgs: [], promptVia: 'stdin', cwd: '${PROJECT_ROOT}' },
    storage: {
      config: {
        identityFile: 'agents/storage-test/config/identity.md',
        rulesFiles: ['agents/storage-test/config/rules/*.md'],
      },
      runtime: {
        activeSessionFile: 'agents/storage-test/runtime/active-session.json',
        resume: true,
      },
      data: { ...(cliHome ? { cliHome } : {}) },
    },
  };
}

test('defaults CLI home inside the node private data directory', () => {
  const home = resolveNodeCliHome(descriptor(), '.opencode');
  assert.ok(home.endsWith(join('agents', 'storage-test', 'data', 'cli', '.opencode')));
});

test('rejects CLI homes outside the node private data directory', () => {
  assert.throws(
    () => resolveNodeCliHome(descriptor('C:/Users/example/.opencode'), '.opencode'),
    /must stay inside/,
  );
  assert.throws(
    () => resolveNodeCliHome(descriptor('agents/other-node/data/cli/.opencode'), '.opencode'),
    /must stay inside/,
  );
});

test('uses one per-node directory for all temporary environment variables', () => {
  const env = nodeTempEnv('D:/project/agents/a/data/cli/.opencode');
  assert.equal(env.TEMP, env.TMP);
  assert.equal(env.TEMP, env.TMPDIR);
  assert.ok(env.TEMP.endsWith(join('.opencode', 'tmp')));
});

test('keeps config, runtime, and CLI data inside their respective node roots', () => {
  assert.doesNotThrow(() => assertNodeStorageOwnership(descriptor()));
  const escaped = descriptor();
  escaped.storage.config.identityFile = 'agents/other-node/config/identity.md';
  assert.throws(() => assertNodeStorageOwnership(escaped), /identityFile must stay inside/);

  const shared = descriptor();
  shared.storage.runtime.activeSessionFile = 'shared/project/runtime/active-session.json';
  assert.throws(() => assertNodeStorageOwnership(shared), /activeSessionFile must stay inside/);
});

test('reserves project and team shared storage without creating it', () => {
  assert.ok(resolveSharedStorageRoot('project').endsWith(join('shared', 'project')));
  assert.ok(resolveSharedStorageRoot('team:reviewers').endsWith(join('shared', 'teams', 'reviewers')));
  assert.throws(() => resolveSharedStorageRoot('team:../outside'), /Invalid team scope/);
});

test('does not rewrite an unchanged OpenCode config', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentteams-opencode-'));
  try {
    const file = writeOpencodeConfig(descriptor(), home);
    const content = readFileSync(file, 'utf-8');
    const firstMtime = statSync(file).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    writeOpencodeConfig(descriptor(), home);
    assert.equal(readFileSync(file, 'utf-8'), content);
    assert.equal(statSync(file).mtimeMs, firstMtime);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
