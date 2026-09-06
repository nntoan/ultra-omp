import { catalog } from './catalog.generated.mjs';

export function parseArgs(argv) {
  const options = { command: 'install', local: false, yes: false, only: null, dryRun: false, help: false };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) options.command = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--local') options.local = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--only') options.only = (args[++i] ?? '').split(',').map((value) => value.trim());
    else if (arg.startsWith('--only=')) options.only = arg.slice(7).split(',').map((value) => value.trim());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.command !== 'install') throw new Error(`Unknown command: ${options.command}`);
  if (options.only && options.only.some((id) => !id)) throw new Error('--only requires at least one plugin ID');
  return options;
}

export function selectCatalog(ids, records = catalog) {
  if (!ids) return records;
  const selected = ids.map((id) => records.find((record) => record.id === id));
  if (selected.some((record) => !record)) throw new Error(`Unknown plugin ID: ${ids.find((id) => !records.some((record) => record.id === id))}`);
  return selected;
}

export function needsProvision(modelRoles) {
  const value = modelRoles && typeof modelRoles === 'object' ? modelRoles['spec-reflector'] : undefined;
  return !(typeof value === 'string' && value.trim() !== '');
}

export function resolveProvisionDefault({ env = {}, modelRoles = {} } = {}) {
  const chain = [env.ULTRA_OMP_SPEC_REFLECTOR_MODEL, modelRoles.advisor, modelRoles.slow, modelRoles.default];
  return chain.find((value) => typeof value === 'string' && value.trim() !== '');
}

export function provisionCommands(modelRoles, { env = {}, local = false } = {}) {
  const scope = local ? ['--local'] : [];
  const commands = [['omp', 'config', 'get', 'modelRoles', '--json', ...scope]];
  if (needsProvision(modelRoles)) {
    const value = resolveProvisionDefault({ env, modelRoles });
    if (value !== undefined) commands.push(['omp', 'config', 'set', 'modelRoles.spec-reflector', value, ...scope]);
  }
  return commands;
}

async function provisionModelRole({ env, local, run, write, error }) {
  const getCommand = ['omp', 'config', 'get', 'modelRoles', '--json', ...(local ? ['--local'] : [])];
  const result = await run(getCommand[0], getCommand.slice(1), { capture: true });
  const getCode = typeof result === 'number' ? result : result && typeof result === 'object' ? Number(result.code ?? 0) : 0;
  if (getCode !== 0) { error('Could not read modelRoles; skipped spec-reflector provisioning.\n'); return 0; }
  let modelRoles = {};
  if (result && typeof result === 'object' && typeof result.stdout === 'string') {
    try {
      const parsed = JSON.parse(result.stdout.trim() || '{}');
      const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      modelRoles = root.value && typeof root.value === 'object' && !Array.isArray(root.value) ? root.value : root;
    } catch { modelRoles = {}; }
  }
  if (!needsProvision(modelRoles)) { write('modelRoles.spec-reflector already configured.\n'); return 0; }
  const value = resolveProvisionDefault({ env, modelRoles });
  if (value === undefined) { write('Skipped modelRoles.spec-reflector provisioning (no default model configured).\n'); return 0; }
  const setCommand = ['omp', 'config', 'set', 'modelRoles.spec-reflector', value, ...(local ? ['--local'] : [])];
  const setCode = await run(setCommand[0], setCommand.slice(1));
  if (setCode !== 0) { error('Role provisioning failed for agent-skills.\n'); return setCode || 1; }
  write(`Provisioned modelRoles.spec-reflector = ${value}.\n`);
  return 0;
}

export function usage() {
  return `Usage: npx @nntoan/ultra-omp [options]\n   or: bunx @nntoan/ultra-omp [options]\n\nOptions:\n  --local             Install into the current project's OMP configuration\n  --yes               Install all plugins without prompting\n  --only <id,id>      Install only the listed plugin IDs\n  --dry-run           Print commands without running them\n  --help              Show this help\n`;
}

function commandFor(record, local) {
  return ['omp', 'plugin', 'install', record.packageName, ...(local ? ['--local'] : [])];
}

export async function main({
  argv = process.argv.slice(2),
  catalogRecords = catalog,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompts = {},
  env = process.env,
  run = async (command, args, { capture = false } = {}) => {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve) => {
      if (!capture) {
        const child = spawn(command, args, { stdio: 'inherit' });
        child.on('close', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(1));
        return;
      }
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
      child.on('error', () => resolve({ code: 1, stdout }));
    });
  },
  write = (text) => process.stdout.write(text),
  error = (text) => process.stderr.write(text),
} = {}) {
  let options;
  try { options = parseArgs(argv); }
  catch (cause) { error(`${cause.message}\n${usage()}`); return 2; }
  if (options.help) { write(usage()); return 0; }

  let selected;
  try {
    selected = options.only ? selectCatalog(options.only, catalogRecords) : null;
    if (!selected && options.yes) selected = catalogRecords;
    if (!selected && !isTTY) {
      error('No interactive terminal detected. Rerun with --yes or --only <id,id>.\n');
      return 2;
    }
    if (!selected) {
      const mode = await prompts.select({ message: 'What would you like to install?', options: [
        { label: 'Install all (recommended)', value: 'all' },
        { label: 'Choose plugins', value: 'choose' },
      ] });
      if (prompts.isCancel?.(mode) || mode === undefined || mode === null) { write('Nothing installed.\n'); return 0; }
      if (mode === 'all') selected = catalogRecords;
      else {
        const values = await prompts.multiselect({ message: 'Select plugins', options: catalogRecords.map((record) => ({ label: record.id, hint: record.description, value: record.id })), initialValues: catalogRecords.map((record) => record.id) });
        if (prompts.isCancel?.(values) || values === undefined || values === null) { write('Nothing installed.\n'); return 0; }
        selected = selectCatalog(values, catalogRecords);
      }
    }
  } catch (cause) { error(`${cause.message}\n`); return 2; }

  if (selected.length === 0) { write('Nothing installed.\n'); return 0; }
  for (const record of selected) {
    const args = commandFor(record, options.local);
    const printable = [args[0], ...args.slice(1)].join(' ');
    if (options.dryRun) {
      write(`${printable}\n`);
      if (record.id === 'agent-skills') {
        for (const command of provisionCommands({}, { env, local: options.local })) write(`${command.join(' ')}\n`);
      }
      continue;
    }
    write(`Installing ${record.id}...\n`);
    const code = await run(args[0], args.slice(1));
    if (code !== 0) { error(`Installation failed for ${record.id}.\n`); return code || 1; }
    if (record.id === 'agent-skills') {
      const provisionCode = await provisionModelRole({ env, local: options.local, run, write, error });
      if (provisionCode !== 0) return provisionCode;
    }
  }
  if (!options.dryRun) write('Installation complete.\n');
  return 0;
}
