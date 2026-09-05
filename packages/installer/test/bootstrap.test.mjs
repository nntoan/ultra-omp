import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const script = path.join(repoRoot, 'scripts/install.sh');

async function runBootstrap({ bun = true }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultra-omp-bootstrap-'));
  const log = path.join(dir, 'args');
  const writeCommand = async (name, body) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  };
  await writeCommand('omp', 'exit 0');
  await writeCommand('curl', 'exit 0');
  await writeCommand('bunx', bun ? `printf "%s\\n" "$*" > "${log}"` : 'exit 127');
  await writeCommand('npx', `printf "%s\\n" "$*" > "${log}"`);
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [script, '--yes', '--local'], { env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', async (code) => resolve({ code, stderr, args: await fs.readFile(log, 'utf8') }));
  });
}

test('bootstrap prefers bunx and forwards arguments', async () => {
  const result = await runBootstrap({ bun: true });
  assert.equal(result.code, 0);
  assert.equal(result.args.trim(), '@nntoan/ultra-omp -- --yes --local');
});

test('bootstrap falls back to npx when bunx is absent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultra-omp-bootstrap-npx-'));
  const log = path.join(dir, 'args');
  for (const [name, body] of [
    ['omp', 'exit 0'],
    ['curl', 'exit 0'],
    ['npx', `printf "%s\\n" "$*" > "${log}"`],
  ]) await fs.writeFile(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [script, '--dry-run'], { env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', async (code) => resolve({ code, stderr, args: await fs.readFile(log, 'utf8') }));
  });
  assert.equal(result.code, 0);
  assert.equal(result.args.trim(), '@nntoan/ultra-omp -- --dry-run');
});
