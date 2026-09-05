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
  run = async (command, args) => {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: 'inherit' });
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
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
    if (options.dryRun) { write(`${printable}\n`); continue; }
    write(`Installing ${record.id}...\n`);
    const code = await run(args[0], args.slice(1));
    if (code !== 0) { error(`Installation failed for ${record.id}.\n`); return code || 1; }
  }
  if (!options.dryRun) write('Installation complete.\n');
  return 0;
}
