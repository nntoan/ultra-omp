import test from 'node:test';
import assert from 'node:assert/strict';
import { main, parseArgs } from '../src/installer.mjs';
import { catalog } from '../src/catalog.generated.mjs';

function harness(overrides = {}) {
  const calls = [];
  const output = [];
  const errors = [];
  return {
    calls, output, errors,
    options: {
      isTTY: false,
      env: {},
      run: async (...args) => { calls.push(args); return 0; },
      write: (text) => output.push(text),
      error: (text) => errors.push(text),
      ...overrides,
    },
  };
}

test('catalog contains the three scoped OMP packages', () => {
  assert.deepEqual(catalog.map(({ id, packageName }) => ({ id, packageName })), [
    { id: 'proflow', packageName: '@ultra-omp/proflow' },
    { id: 'pi-reasonix', packageName: '@ultra-omp/pi-reasonix' },
    { id: 'pi-deepseek-cache', packageName: '@ultra-omp/pi-deepseek-cache' },
  ]);
});

test('interactive all-selection installs catalog order', async () => {
  const h = harness({ isTTY: true, prompts: { select: async () => 'all', isCancel: () => false } });
  assert.equal(await main({ ...h.options }), 0);
  assert.deepEqual(h.calls.filter(([, args]) => args[0] === 'plugin').map(([, args]) => args), catalog.map((record) => ['plugin', 'install', record.packageName]));
});

test('custom selection and local scope install only selected IDs', async () => {
  const h = harness();
  assert.equal(await main({ ...h.options, argv: ['--only', 'pi-reasonix,proflow', '--local'] }), 0);
  assert.deepEqual(h.calls.filter(([, args]) => args[0] === 'plugin').map(([, args]) => args), [
    ['plugin', 'install', '@ultra-omp/pi-reasonix', '--local'],
    ['plugin', 'install', '@ultra-omp/proflow', '--local'],
  ]);
});

test('yes dry-run prints commands and launches nothing', async () => {
  const h = harness();
  assert.equal(await main({ ...h.options, argv: ['--yes', '--dry-run'] }), 0);
  assert.equal(h.calls.length, 0);
  assert.match(h.output.join(''), /omp plugin install @ultra-omp\/proflow/);
});

test('non-TTY defaults to an actionable error', async () => {
  const h = harness();
  assert.equal(await main({ ...h.options }), 2);
  assert.match(h.errors.join(''), /--yes or --only/);
});

test('cancellation exits without spawning', async () => {
  const h = harness({ isTTY: true, prompts: { select: async () => Symbol('cancel'), isCancel: () => true } });
  assert.equal(await main({ ...h.options }), 0);
  assert.equal(h.calls.length, 0);
  assert.match(h.output.join(''), /Nothing installed/);
});

test('unknown only ID returns usage error', async () => {
  const h = harness();
  assert.equal(await main({ ...h.options, argv: ['--only', 'missing'] }), 2);
  assert.match(h.errors.join(''), /Unknown plugin ID/);
});

test('child failure stops later installs', async () => {
  const calls = [];
  const h = harness({ run: async (...args) => { calls.push(args); return calls.length === 1 ? 7 : 0; } });
  assert.equal(await main({ ...h.options, argv: ['--yes'] }), 7);
  assert.equal(calls.length, 1);
});

test('argument parser supports the documented flags', () => {
  assert.deepEqual(parseArgs(['--local', '--yes', '--only=proflow', '--dry-run']), { command: 'install', local: true, yes: true, only: ['proflow'], dryRun: true, help: false });
});

