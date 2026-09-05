#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const source = path.join(root, 'scripts/install.sh');
const target = path.join(root, 'docs/public/install');
const check = process.argv.includes('--check');
const expected = await fs.readFile(source);
let actual = null;
try { actual = await fs.readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (check) {
  if (!actual || !expected.equals(actual)) throw new Error('docs/public/install is out of sync with scripts/install.sh');
} else {
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (!actual || !expected.equals(actual)) await fs.writeFile(target, expected, { mode: 0o755 });
}
