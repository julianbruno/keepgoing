#!/usr/bin/env bash
# Standalone checkout helper. Invoke Pi with separate arguments, never shell commands.
exec node --input-type=module - "$@" <<'NODE'
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const usage = `Usage: ./uninstall-sleeppi.sh [--apply]
Preview legacy sleeppi user packages across Pi profiles. Pass --apply to remove them.
Project packages, manual extensions, and keepgoing are not targeted.`;

function profiles() {
  const home = homedir();
  const dirs = readdirSync(home).filter(name => name === '.pi' || name.startsWith('.pi-')).sort()
    .map(name => join(home, name, 'agent')).filter(dir => statSync(dir, { throwIfNoEntry: false })?.isDirectory());
  if (process.env.PI_CODING_AGENT_DIR) dirs.push(process.env.PI_CODING_AGENT_DIR);
  return [...new Set(dirs.map(dir => realpathSync(dir)))];
}

function personalPackages(list) {
  const entries = [];
  let personal = false, entry;
  for (const line of list.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      personal = line === 'User packages:';
      entry = undefined;
    } else if (personal && /^  \S/.test(line)) {
      entry = { source: line.slice(2) };
      entries.push(entry);
    } else if (entry && line.startsWith('    /')) {
      entry.path = line.slice(4);
    }
  }
  return entries;
}

function isLegacy({ source, path }) {
  if (source.startsWith('-')) return false;
  const dir = path ?? (isAbsolute(source) ? source : undefined);
  if (dir) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      return pkg.name === 'sleeppi' && Array.isArray(pkg.pi?.extensions) && pkg.pi.extensions.includes('./extensions/inhibit.ts');
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    }
  }
  return /^npm:sleeppi(?:@[^\s]+)?$/.test(source) ||
    /^(?:git:)?(?:https:\/\/|ssh:\/\/git@)?github\.com\/julianbruno\/pi-sleeppi(?:\.git)?(?:@[^\s]+)?$/.test(source);
}

function run(apply) {
  const dirs = profiles();
  if (!dirs.length) throw new Error('No Pi profiles found.');
  const plan = [];
  for (const dir of dirs) {
    const env = { ...process.env, PI_CODING_AGENT_DIR: dir, NO_COLOR: '1' };
    const list = spawnSync('pi', ['list'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (list.error) throw list.error;
    if (list.status !== 0) throw new Error(`pi list failed for ${dir}; no package changes made`);
    const sources = personalPackages(list.stdout).filter(isLegacy).map(entry => entry.source);
    for (const source of new Set(sources)) plan.push({ dir, source, env });
  }
  if (!plan.length) return console.log('No recognized personal sleeppi packages found.');
  for (const { dir, source } of plan) console.log(`${dir}: ${source}`);
  if (!apply) return console.log('Preview only. Run again with --apply to remove these packages.');
  for (const { dir, env, source } of plan) {
    // Pi lists local sources relative to the profile but resolves remove arguments from cwd.
    const result = spawnSync('pi', ['remove', source], { cwd: dir, env, stdio: ['ignore', 'inherit', 'inherit'] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`pi remove failed in ${dir}: ${source}`);
  }
  console.log('Restart Pi to unload the old commands.');
}

const args = process.argv.slice(2);
if (args.length === 1 && ['-h', '--help'].includes(args[0])) console.log(usage);
else if (args.length && !(args.length === 1 && args[0] === '--apply')) {
  console.error(usage);
  process.exitCode = 2;
} else {
  try { run(args.length === 1); }
  catch (err) { console.error(`error: ${err.message}`); process.exitCode = 1; }
}
NODE
