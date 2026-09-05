import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { generateCatalog, syncCatalog } from '../../../scripts/sync-installer-catalog.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function runScript(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'scripts/sync-installer-catalog.mjs'), ...args]);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ultra-omp-catalog-'));
  await fs.mkdir(path.join(root, 'packages/a'), { recursive: true });
  await fs.mkdir(path.join(root, 'packages/b'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  await fs.writeFile(path.join(root, 'packages/a/package.json'), JSON.stringify({ name: '@test/a', description: 'A', omp: { extensions: ['./extensions/index.ts'] } }));
  await fs.writeFile(path.join(root, 'packages/b/package.json'), JSON.stringify({ name: '@test/b', description: 'B' }));
  return root;
}

test('generator selects only OMP leaf manifests', async () => {
  const root = await fixture();
  assert.deepEqual(await generateCatalog(root), [{ id: 'a', packageName: '@test/a', description: 'A' }]);
});

test('check detects fixture drift without changing output', async () => {
  const root = await fixture();
  const output = path.join(root, 'catalog.mjs');
  await syncCatalog({ workspaceRoot: root, output });
  const before = await fs.readFile(output, 'utf8');
  await fs.writeFile(path.join(root, 'packages/a/package.json'), JSON.stringify({ name: '@test/a', description: 'Changed', omp: { extensions: ['./extensions/index.ts'] } }));
  await assert.rejects(syncCatalog({ workspaceRoot: root, output, check: true }), /stale/);
  assert.equal(await fs.readFile(output, 'utf8'), before);
});

test('CLI accepts temporary workspace and output paths', async () => {
  const root = await fixture();
  const output = path.join(root, 'generated.mjs');
  const result = await runScript(['--workspace-root', root, '--output', output]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await fs.readFile(output, 'utf8'), /@test\/a/);
});
