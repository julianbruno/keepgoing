import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Copy only the executable into an empty checkout: an adjacent helper must not be required.
test('standalone Bash cleanup previews and removes only personal legacy declarations', { skip: process.platform === 'win32' }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sleeppi-cleanup-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'uninstall-sleeppi.sh');
  copyFileSync(new URL('../uninstall-sleeppi.sh', import.meta.url), script);
  const home = join(root, 'home'), bin = join(root, 'bin');
  const first = join(home, '.pi', 'agent'), second = join(home, '.pi-work', 'agent'), active = join(root, 'active');
  const old = join(root, 'old checkout'), current = join(root, 'sleeppi');
  for (const dir of [bin, first, second, active, old, current]) mkdirSync(dir, { recursive: true });
  symlinkSync(second, join(home, '.pi-work', 'alias'));
  writeFileSync(join(old, 'package.json'), JSON.stringify({ name: 'sleeppi', pi: { extensions: ['./extensions/inhibit.ts'] } }));
  writeFileSync(join(current, 'package.json'), '{"name":"pi-keepgoing"}');
  const relative = '../previous checkout', git = 'git:github.com/julianbruno/pi-sleeppi', npm = 'npm:sleeppi@1.0.0';
  writeFileSync(join(first, 'list'), `User packages:\n  ${old}\n  ${relative}\n    ${old}\n  ${current}\n  ${join(root, 'missing', 'sleeppi')}\n  npm:pi-keepgoing\nProject packages:\n  npm:sleeppi\n`);
  writeFileSync(join(second, 'list'), `User packages:\n  ${git}\n  ${git}\n  git:github.com/other/pi-sleeppi\n`);
  writeFileSync(join(active, 'list'), `User packages:\n  ${npm}\n`);
  const log = join(root, 'calls');
  writeFileSync(join(bin, 'pi'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), dir = process.env.PI_CODING_AGENT_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify([dir, ...args]) + '\\n');
if (args[0] === 'list') {
  if (!fs.existsSync(path.join(dir, 'list'))) process.exit(7);
  process.stdout.write(fs.readFileSync(path.join(dir, 'list')));
} else if (args[0] !== 'remove' || args.length !== 2) process.exit(9);\n`, { mode: 0o755 });
  const run = (dir: string, ...args: string[]) => {
    writeFileSync(log, '');
    const result = spawnSync(script, args, { cwd: root, encoding: 'utf8', timeout: 10000,
      env: { HOME: home, PATH: bin + delimiter + process.env.PATH, PI_CODING_AGENT_DIR: dir, CALLS: log } });
    assert.ifError(result.error);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr,
      calls: readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) };
  };
  const listed = [first, second, active].map(dir => [dir, 'list']);
  const targets = [[first, old], [first, relative], [second, git], [active, npm]];
  const pairs = targets.map(([dir, source]) => `${dir}: ${source}\n`).join('');
  const preview = 'Preview only. Run again with --apply to remove these packages.\n';
  assert.deepEqual(run(active), { status: 0, stdout: pairs + preview, stderr: '', calls: listed });
  assert.deepEqual(run(join(home, '.pi-work', 'alias')), { status: 0,
    stdout: pairs.slice(0, pairs.lastIndexOf(`${active}:`)) + preview, stderr: '', calls: listed.slice(0, 2) });
  assert.deepEqual(run(active, '--apply'), { status: 0, stdout: pairs + 'Restart Pi to unload the old commands.\n',
    stderr: '', calls: [...listed, ...targets.map(([dir, source]) => [dir, 'remove', source])] });
  rmSync(join(active, 'list'));
  assert.deepEqual(run(active, '--apply'), { status: 1, stdout: '', stderr: `error: pi list failed for ${active}; no package changes made\n`, calls: listed });
  const help = run(active, '--help');
  assert.equal(help.status, 0); assert.match(help.stdout, /--apply/); assert.equal(help.stderr, ''); assert.deepEqual(help.calls, []);
  assert.deepEqual(run(active, '--apply', '--all'), { status: 2, stdout: '', stderr: help.stdout, calls: [] });
  assert.ok(existsSync(join(current, 'package.json')));
});

test('real Pi removes profile-relative legacy packages when cleanup runs from another directory', { skip: process.platform !== 'linux' }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sleeppi-pi-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const profiles = ['.pi', '.pi-work'].map(name => join(home, name, 'agent'));
  const old = join(root, 'old'), keep = join(root, 'other');
  for (const dir of [...profiles, old, keep]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(old, 'package.json'), JSON.stringify({ name: 'sleeppi', pi: { extensions: ['./extensions/inhibit.ts'] } }));
  writeFileSync(join(keep, 'package.json'), JSON.stringify({ name: 'other' }));
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    PI_OFFLINE: '1', NO_COLOR: '1' };
  const run = (cmd: string, args: string[], dir: string) => spawnSync(cmd, args, { cwd: root,
    env: { ...env, PI_CODING_AGENT_DIR: dir }, encoding: 'utf8', timeout: 30000 });
  const version = run('pi', ['--version'], profiles[0]);
  if ((version.error as NodeJS.ErrnoException)?.code === 'ENOENT') return t.skip('Pi CLI not installed');
  const output = (result: typeof version) => {
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  output(version);
  const packages = (dir: string) => output(run('pi', ['list'], dir)).split(/\r?\n/)
    .filter(line => /^  \S/.test(line)).map(line => line.slice(2)).sort();
  for (const dir of profiles) {
    for (const pkg of [old, keep]) output(run('pi', ['install', pkg], dir));
  }
  const script = fileURLToPath(new URL('../uninstall-sleeppi.sh', import.meta.url));
  const preview = output(run(script, [], profiles[0]));
  for (const dir of profiles) {
    assert.ok(preview.includes(`${dir}: ${relative(dir, old)}\n`));
    assert.deepEqual(packages(dir), [relative(dir, old), relative(dir, keep)].sort());
  }
  output(run(script, ['--apply'], profiles[0]));
  for (const dir of profiles) assert.deepEqual(packages(dir), [relative(dir, keep)]);
});
