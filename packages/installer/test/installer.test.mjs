import test from 'node:test';
import assert from 'node:assert/strict';
import { main, needsProvision, parseArgs, provisionCommands, resolveProvisionDefault } from '../src/installer.mjs';
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
    { id: 'agent-skills', packageName: '@ultra-omp/agent-skills' },
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
  assert.equal(await main({ ...h.options, argv: ['--only', 'pi-reasonix,agent-skills', '--local'] }), 0);
  assert.deepEqual(h.calls.filter(([, args]) => args[0] === 'plugin').map(([, args]) => args), [
    ['plugin', 'install', '@ultra-omp/pi-reasonix', '--local'],
    ['plugin', 'install', '@ultra-omp/agent-skills', '--local'],
  ]);
});

test('yes dry-run prints commands and launches nothing', async () => {
  const h = harness();
  assert.equal(await main({ ...h.options, argv: ['--yes', '--dry-run'] }), 0);
  assert.equal(h.calls.length, 0);
  assert.match(h.output.join(''), /omp plugin install @ultra-omp\/agent-skills/);
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
  assert.deepEqual(parseArgs(['--local', '--yes', '--only=agent-skills', '--dry-run']), { command: 'install', local: true, yes: true, only: ['agent-skills'], dryRun: true, help: false });
});

test('needsProvision is true unless spec-reflector has a non-empty value', () => {
  assert.equal(needsProvision({ 'spec-reflector': 'acme/model' }), false);
  assert.equal(needsProvision({}), true);
  assert.equal(needsProvision({ 'spec-reflector': '' }), true);
  assert.equal(needsProvision({ 'spec-reflector': '   ' }), true);
  assert.equal(needsProvision({ advisor: 'acme/model' }), true);
  assert.equal(needsProvision(null), true);
});

test('provision default resolves env override then advisor, slow, default', () => {
  const models = { advisor: 'provider/advisor', slow: 'provider/slow', default: 'provider/default' };
  assert.equal(resolveProvisionDefault({ env: {}, modelRoles: {} }), undefined);
  assert.equal(resolveProvisionDefault({ env: {}, modelRoles: models }), 'provider/advisor');
  assert.equal(resolveProvisionDefault({ env: {}, modelRoles: { slow: 'provider/slow', default: 'provider/default' } }), 'provider/slow');
  assert.equal(resolveProvisionDefault({ env: {}, modelRoles: { default: 'provider/default' } }), 'provider/default');
  assert.equal(resolveProvisionDefault({ env: {}, modelRoles: { advisor: '   ' } }), undefined);
  assert.equal(resolveProvisionDefault({ env: {}, modelRoles: { advisor: '', slow: 'provider/slow' } }), 'provider/slow');
  assert.equal(resolveProvisionDefault({ env: { ULTRA_OMP_SPEC_REFLECTOR_MODEL: 'provider/env' }, modelRoles: models }), 'provider/env');
  assert.equal(resolveProvisionDefault({ env: { ULTRA_OMP_SPEC_REFLECTOR_MODEL: '  ' }, modelRoles: models }), 'provider/advisor');
});

test('provisionCommands emits get plus conditional set and mirrors local scope', () => {
  assert.deepEqual(provisionCommands({ advisor: 'acme/model' }, { env: {} }), [
    ['omp', 'config', 'get', 'modelRoles', '--json'],
    ['omp', 'config', 'set', 'modelRoles.spec-reflector', 'acme/model'],
  ]);
  assert.deepEqual(provisionCommands({}, { env: {} }), [['omp', 'config', 'get', 'modelRoles', '--json']]);
  assert.deepEqual(provisionCommands({ 'spec-reflector': 'acme/kept' }, { env: {} }), [['omp', 'config', 'get', 'modelRoles', '--json']]);
  assert.deepEqual(provisionCommands({ advisor: 'acme/model' }, { env: { ULTRA_OMP_SPEC_REFLECTOR_MODEL: 'acme/env' }, local: true }), [
    ['omp', 'config', 'get', 'modelRoles', '--json', '--local'],
    ['omp', 'config', 'set', 'modelRoles.spec-reflector', 'acme/env', '--local'],
  ]);
});

test('no provisioning runs for non-agent-skills records', async () => {
  const calls = [];
  const h = harness({ run: async (command, args) => { calls.push([command, args]); return 0; } });
  assert.equal(await main({ ...h.options, argv: ['--only', 'pi-reasonix'] }), 0);
  assert.deepEqual(calls, [['omp', ['plugin', 'install', '@ultra-omp/pi-reasonix']]]);
  assert.ok(!h.output.join('').includes('modelRoles'));
});

test('existing spec-reflector value is never overridden', async () => {
  const calls = [];
  const h = harness({
    env: { ULTRA_OMP_SPEC_REFLECTOR_MODEL: 'acme/env' },
    run: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'config' && args[1] === 'get') return { code: 0, stdout: JSON.stringify({ key: 'modelRoles', value: { 'spec-reflector': 'acme/kept', advisor: 'acme/advisor' } }) };
      return 0;
    },
  });
  assert.equal(await main({ ...h.options, argv: ['--only', 'agent-skills'] }), 0);
  assert.ok(!calls.some(([, args]) => args[0] === 'config' && args[1] === 'set'));
  assert.match(h.output.join(''), /already configured/);
});

test('provisioning is skipped when the config exposes no usable default model', async () => {
  const fixtures = [
    { key: 'modelRoles', value: {} },
    { key: 'modelRoles', value: { theme: 'dark' } },
  ];
  for (const fixture of fixtures) {
    const calls = [];
    const h = harness({
      run: async (command, args) => {
        calls.push([command, args]);
        if (args[0] === 'config' && args[1] === 'get') return { code: 0, stdout: JSON.stringify(fixture) };
        return 0;
      },
    });
    assert.equal(await main({ ...h.options, argv: ['--only', 'agent-skills'] }), 0);
    assert.ok(!calls.some(([, args]) => args[0] === 'config' && args[1] === 'set'));
    assert.match(h.output.join(''), /Skipped modelRoles\.spec-reflector/);
  }
});

test('dry-run prints provisioning commands without executing anything', async () => {
  const calls = [];
  const h = harness({
    env: { ULTRA_OMP_SPEC_REFLECTOR_MODEL: 'acme/env' },
    run: async (command, args) => { calls.push([command, args]); return 0; },
  });
  assert.equal(await main({ ...h.options, argv: ['--only', 'agent-skills', '--local', '--dry-run'] }), 0);
  assert.equal(calls.length, 0);
  const printed = h.output.join('');
  assert.match(printed, /omp plugin install @ultra-omp\/agent-skills --local/);
  assert.match(printed, /omp config get modelRoles --json --local/);
  assert.match(printed, /omp config set modelRoles\.spec-reflector acme\/env --local/);
});

test('provisioning runs after a successful agent-skills install', async () => {
  const calls = [];
  const h = harness({
    env: {},
    run: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'config' && args[1] === 'get') return { code: 0, stdout: JSON.stringify({ key: 'modelRoles', value: { advisor: 'acme/advisor' } }) };
      return 0;
    },
  });
  assert.equal(await main({ ...h.options, argv: ['--only', 'agent-skills'] }), 0);
  const at = (match) => calls.findIndex(([, args]) => match(args));
  const install = at((args) => args[0] === 'plugin' && args[2] === '@ultra-omp/agent-skills');
  const get = at((args) => args[0] === 'config' && args[1] === 'get');
  const set = at((args) => args[0] === 'config' && args[1] === 'set');
  assert.ok(install !== -1 && get !== -1 && set !== -1 && install < get && get < set);
  assert.deepEqual(calls[set][1], ['config', 'set', 'modelRoles.spec-reflector', 'acme/advisor']);
  assert.match(h.output.join(''), /Provisioned modelRoles\.spec-reflector = acme\/advisor/);
});

test('failed agent-skills install skips provisioning', async () => {
  const calls = [];
  const h = harness({
    run: async (command, args) => { calls.push([command, args]); return calls.length === 1 ? 7 : 0; },
  });
  assert.equal(await main({ ...h.options, argv: ['--only', 'agent-skills'] }), 7);
  assert.equal(calls.length, 1);
  assert.ok(!calls.some(([, args]) => args[0] === 'config'));
});

test('plain-map config get output is accepted as a fallback shape', async () => {
  const calls = [];
  const h = harness({
    env: {},
    run: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'config' && args[1] === 'get') return { code: 0, stdout: JSON.stringify({ advisor: 'acme/plain' }) };
      return 0;
    },
  });
  assert.equal(await main({ ...h.options, argv: ['--only', 'agent-skills'] }), 0);
  assert.ok(calls.some(([, args]) => args[0] === 'config' && args[1] === 'set' && args[3] === 'acme/plain'));
  assert.match(h.output.join(''), /Provisioned modelRoles\.spec-reflector = acme\/plain/);
});
