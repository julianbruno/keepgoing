import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';

const win = process.platform === 'win32';
const onPath = (names: string[]) => (process.env.PATH ?? '').split(delimiter).flatMap(dir => names.map(name => join(dir, name))).find(existsSync);
const ps = onPath(win ? ['pwsh.exe', 'powershell.exe'] : ['pwsh']);
const pi = onPath(win ? ['pi.exe', 'pi.cmd'] : ['pi']);

function fixture(t: TestContext, powershell: boolean, name = 'keepgoing checkout') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'checkout removal-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, name), home = join(dir, 'home'), agent = join(home, '.pi', 'agent');
  // From this cwd the stored relative declaration names a different real package.
  const cwd = join(dir, 'caller/home/.pi/agent'), other = join(dir, 'caller', name), bin = join(dir, 'bin');
  for (const path of [join(root, 'extensions'), agent, cwd, other, bin]) mkdirSync(path, { recursive: true });
  const ext = powershell ? 'ps1' : 'sh';
  for (const s of ['install', 'uninstall']) copyFileSync(new URL(`../${s}.${ext}`, import.meta.url), join(root, `${s}.${ext}`));
  writeFileSync(join(root, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
  const files = [join(root, 'extensions/keepgoing.ts'), join(other, 'original.txt')];
  const original = '// original bytes\n';
  files.forEach(path => writeFileSync(path, original));
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PATH: bin + delimiter + process.env.PATH,
    SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT, ComSpec: process.env.ComSpec, TMP: dir, TEMP: dir,
    PI_OFFLINE: '1', NO_COLOR: '1', npm_config_offline: 'true' };
  function run(cmd: string, args: string[]) {
    // Batch shims used here are only invoked for `pi list` with fixed switches.
    const batch = win && cmd.endsWith('.cmd');
    const r = spawnSync(batch ? 'cmd.exe' : cmd, batch ? ['/d', '/c', 'pi.cmd', ...args] : args, { env, cwd, encoding: 'utf8', timeout: 30000 });
    assert.ifError(r.error);
    return { status: r.status, stdout: r.stdout.replaceAll('\r\n', '\n'), stderr: r.stderr.replaceAll('\r\n', '\n') };
  }
  return { root, other, home, agent, bin, cwd, env, run, verifyFiles() { files.forEach(path => assert.equal(readFileSync(path, 'utf8'), original)); },
    uninstall(wrapper: boolean, ...args: string[]) {
      const script = join(root, `${wrapper ? 'uninstall' : 'install'}.${ext}`);
      return run(powershell ? ps! : 'bash', [...(powershell ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'] : []), script,
        ...(wrapper ? [] : ['uninstall']), ...args]);
    } };
}

for (const powershell of [false, true]) {
  const shell = powershell ? 'PowerShell' : 'Bash';
  const unavailable = powershell ? !ps && 'PowerShell unavailable' : win && 'Unix only';
  for (const wrapper of [false, true]) {
    test(`${shell} ${wrapper ? 'wrapper' : 'direct'}: real Pi refuses two personal paths to one directory`, { skip: unavailable || (!pi && 'Pi unavailable') }, t => {
      const f = fixture(t, powershell);
      const link = join(f.home, 'linked checkout');
      symlinkSync(f.root, link, win ? 'junction' : 'dir');
      const list = () => f.run(pi!, ['list', '--no-approve']);
      // Pi trims stored paths when resolving them, not when printing their labels.
      for (const source of [relative(f.agent, link), ' ' + relative(f.agent, link)]) {
        writeFileSync(join(f.agent, 'settings.json'), JSON.stringify({ packages: [f.root, { source, extensions: [] }] }));
        const before = list();
        assert.deepEqual(before, { status: 0, stderr: '', stdout: `User packages:\n  ${f.root}\n    ${f.root}\n  ${source} (filtered)\n    ${link}\n` });
        const r = f.uninstall(wrapper);
        assert.deepEqual(list(), before, 'neither registration may be removed');
        f.verifyFiles();
        assert.equal(realpathSync(link), f.root);
        assert.equal(r.status, 1);
        assert.equal(r.stdout, '==> keepgoing 1.0.0\n');
        if (powershell) assert.match(r.stderr, /unsafe or ambiguous checkout identity/);
        else assert.equal(r.stderr, 'error: unsafe or ambiguous checkout identity; no package changes made\n');
      }
    });

    test(`${shell} ${wrapper ? 'wrapper' : 'direct'}: real Pi personal registration and file postconditions`, { skip: unavailable || (!pi && 'Pi unavailable') }, t => {
      const f = fixture(t, powershell);
      const list = () => {
        const r = f.run(pi!, ['list', '--approve']); // include the project's local fixture in the postcondition
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stderr, '');
        return r.stdout;
      };
      const source = relative(f.agent, f.root);
      const literal = f.root + ' (filtered)';
      mkdirSync(literal);
      writeFileSync(join(literal, 'original.txt'), 'literal');
      mkdirSync(join(f.cwd, '.pi'));
      writeFileSync(join(f.cwd, '.pi/settings.json'), JSON.stringify({ packages: [f.root] }));
      const project = `\nProject packages:\n  ${f.root}\n    ${f.root}\n`;
      for (const entry of [source, { source, extensions: [] }]) {
        writeFileSync(join(f.agent, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always', packages: ['missing-checkout', f.other, literal, entry] }));
        const remaining = `User packages:\n  missing-checkout\n  ${f.other}\n    ${f.other}\n  ${literal}\n    ${literal}\n`;
        assert.equal(list(), remaining + `  ${source}${typeof entry === 'string' ? '' : ' (filtered)'}\n    ${f.root}\n` + project);
        const r = f.uninstall(wrapper);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stderr, '');
        assert.equal(list(), remaining + project);
        f.verifyFiles();
        assert.equal(readFileSync(join(literal, 'original.txt'), 'utf8'), 'literal');
      }
      // Pi removes *all* personal entries with the same local match key.
      writeFileSync(join(f.agent, 'settings.json'), JSON.stringify({ packages: [source, { source: f.root, extensions: [] }] }));
      const duplicate = list();
      assert.equal(duplicate, `User packages:\n  ${source}\n    ${f.root}\n  ${f.root} (filtered)\n    ${f.root}\n` + project);
      const refused = f.uninstall(wrapper);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /unsafe or ambiguous checkout identity/);
      assert.equal(list(), duplicate);
      f.verifyFiles();
    });
  }

  test(`${shell}: a checkout name Pi would trim is not a safe removal operand`, { skip: unavailable || win || (!pi && 'Pi unavailable') }, t => {
    const f = fixture(t, powershell, 'trailing ');
    mkdirSync(f.root.trimEnd());
    writeFileSync(join(f.agent, 'settings.json'), JSON.stringify({ packages: [f.root.trimEnd()] }));
    const before = f.run(pi!, ['list']);
    assert.equal(before.stdout, `User packages:\n  ${f.root.trimEnd()}\n    ${f.root.trimEnd()}\n`);
    for (const wrapper of [false, true]) {
      assert.equal(f.uninstall(wrapper).status, 1);
      assert.deepEqual(f.run(pi!, ['list']), before);
      f.verifyFiles();
    }
  });

  test(`${shell}: ambiguous personal identity, managed paths and project-only entries across homes`, { skip: unavailable }, t => {
    const f = fixture(t, powershell);
    const stub = `#!${process.execPath}\nconst fs = require('node:fs'), path = require('node:path');
const agent = process.env.PI_CODING_AGENT_DIR;
if (!agent || path.dirname(path.dirname(agent)) !== process.env.HOME) process.exit(98);
const file = path.join(agent, 'list.txt');
if (process.argv[2] === 'list') process.stdout.write(fs.readFileSync(file));
else if (process.argv[2] === 'remove') { fs.appendFileSync(file + '.calls', JSON.stringify(process.argv.slice(2))); fs.writeFileSync(file, 'No packages installed.\\n'); }
else process.exit(99);`;
    writeFileSync(join(f.bin, win ? 'pi.cjs' : 'pi'), stub, { mode: 0o755 });
    if (win) writeFileSync(join(f.bin, 'pi.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0pi.cjs" %*\r\n`);
    const lane = (name: string) => join(f.home, name, 'agent');
    // The managed source has a different installed spelling through an ancestor link.
    const parentLink = join(f.home, 'linked parent');
    symlinkSync(f.other, parentLink, win ? 'junction' : 'dir');
    const link = join(f.other, 'checkout link');
    symlinkSync(f.root, link, win ? 'junction' : 'dir');
    const managedPath = join(parentLink, 'checkout link');
    const states = [
      ['.pi', `User packages:\n  ${f.root}\n    ${f.root}\n  ${relative(f.agent, f.root)} (filtered)\n    ${f.root}\n`],
      ['.pi-git', `User packages:\n  git:example.invalid/org/keepgoing (filtered)\n    ${f.root}\n`],
      ['.pi-npm', `User packages:\n  npm:pi-keepgoing\n    ${f.root}\n`],
      ['.pi-git-alias', `User packages:\n  ${f.root}\n    ${f.root}\n  git:example.invalid/org/keepgoing\n    ${managedPath}\n`],
      ['.pi-npm-alias', `User packages:\n  npm:pi-keepgoing\n    ${managedPath}\n`],
      ['.pi-project', `User packages:\n  ${f.other}\n    ${f.other}\nProject packages:\n  ${f.root}\n    ${f.root}\n`],
      ['.pi-disappeared', `User packages:\n  ${f.root}\n    ${f.root}\n  npm:other\n    ${join(f.home, 'vanished installation')}\n`],
      ['.pi-missing', `User packages:\n  ${f.root}\n`],
      ['.pi-mismatch', `User packages:\n  ${f.root}\n    ${f.other}\n`],
      ['.pi-local', `User packages:\n  ${f.root}\n    ${f.root}\n`],
    ];
    if (!win) {
      const loop = join(f.home, 'unresolved link');
      symlinkSync(loop, loop);
      states.push(['.pi-unresolved', `User packages:\n  ${f.root}\n    ${f.root}\n  ${loop}\n`]);
    }
    for (const [name, state] of states) {
      mkdirSync(lane(name), { recursive: true }); writeFileSync(join(lane(name), 'list.txt'), state);
    }
    delete f.env.PI_CODING_AGENT_DIR;
    const r = f.uninstall(true, powershell ? '-AllHomes' : '--all-homes');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stderr.includes(`${states.length - 2} of ${states.length} Pi homes failed`), r.stderr);
    for (const [name, state] of states) {
      f.env.PI_CODING_AGENT_DIR = lane(name);
      assert.deepEqual(f.run(join(f.bin, win ? 'pi.cmd' : 'pi'), ['list']), { status: 0, stdout: name === '.pi-local' ? 'No packages installed.\n' : state, stderr: '' });
      assert.equal(existsSync(join(lane(name), 'list.txt.calls')), name === '.pi-local');
    }
    f.verifyFiles();
  });
}
