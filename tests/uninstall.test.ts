import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";

const win = process.platform === "win32";
const powershell = (win ? ["pwsh.exe", "powershell.exe"] : ["pwsh"]).flatMap(name =>
  (process.env.PATH ?? "").split(delimiter).map(dir => join(dir, name))).find(path => existsSync(path));
const source = "../../.."; // from <checkout>/home/.pi*/agent
const list = ["list", "--no-approve"];
const banner = "==> keepgoing 1.0.0\n";
const shellUsage = "Usage: ./uninstall.sh [--dry-run|-n] [--all-homes] [--help|-h]";
const psUsage = "Usage: .\\uninstall.ps1 [-DryRun] [-AllHomes] [-Help]";

function fixture(t: TestContext, ps: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keepgoing uninstall-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), bin = join(root, "bin"), calls = join(root, "calls");
  for (const dir of [home, bin, join(root, "extensions")]) mkdirSync(dir);
  const ext = ps ? "ps1" : "sh", script = join(root, `uninstall.${ext}`);
  for (const name of ["install", "uninstall"]) copyFileSync(new URL(`../${name}.${ext}`, import.meta.url), join(root, `${name}.${ext}`));
  writeFileSync(join(root, "package.json"), '{\n  "version": "1.0.0"\n}\n');
  writeFileSync(join(root, "extensions/keepgoing.ts"), "");
  const fake = `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'list') process.stdout.write(process.env.LIST);
else if (args[0] !== 'remove') process.exit(99);
else process.exit(Number(process.env.REMOVE_EXIT || 0));\n`;
  writeFileSync(join(bin, win ? "pi.cjs" : "pi"), fake, { mode: 0o755 });
  if (win) writeFileSync(join(bin, "pi.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0pi.cjs" %*\r\n`);
  return { root, home, run(args: string[], extra: Record<string, string> = {}, command?: string) {
    writeFileSync(calls, "");
    const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: bin + delimiter + process.env.PATH,
      PI_CODING_AGENT_DIR: "", KEEPGOING_INSTALL_CHILD: "", CALLS: calls, SCRIPT: script, REMOVE_EXIT: "0",
      LIST: `User packages:\n  ${source}\n    ${root}\n`, ...extra };
    const result = spawnSync(ps ? powershell! : script, ps ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      ...(command ? ["-Command", command] : ["-File", script, ...args])] : args, { env, cwd: home, encoding: "utf8", timeout: 20000 });
    assert.ifError(result.error);
    return { status: result.status, stdout: result.stdout.replaceAll("\r\n", "\n"), stderr: result.stderr.replaceAll("\r\n", "\n"),
      calls: readFileSync(calls, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) };
  } };
}

for (const ps of [false, true]) {
  const name = ps ? "PowerShell" : "Bash", opts = { skip: ps ? (!powershell && "PowerShell unavailable") : win };
  const help = ps ? "-Help" : "--help", usage = ps ? psUsage : shellUsage;
  const dry = ps ? "-DryRun" : "--dry-run", all = ps ? "-AllHomes" : "--all-homes";
  test(`${name}: help and rejected arguments never call Pi`, opts, t => {
    const f = fixture(t, ps);
    for (const flag of ps ? [help] : [help, "-h"]) {
      assert.deepEqual(f.run([flag]), { status: 0, stdout: usage + "\n", stderr: "", calls: [] });
    }
    for (const arg of ["install", "status", "uninstall", "-Action", "-All", "--unknown"]) {
      assert.deepEqual(f.run([help, arg]), { status: 2, stdout: "", stderr: `error: unknown argument: ${arg}\n${usage}\n`, calls: [] });
    }
  });
  test(`${name}: remove only the personal declaration for this checkout; absence is a no-op`, opts, t => {
    const f = fixture(t, ps);
    assert.deepEqual(f.run([]), { status: 0, stdout: banner + `==> removing keepgoing 1.0.0 (${f.root})\n==> done. Restart Pi (or run /reload).\n`,
      stderr: "", calls: [list, ["remove", f.root, "--no-approve"]] });
    for (let i = 0; i < 2; i++) assert.deepEqual(f.run([], { LIST: `User packages:\n  npm:other\nProject packages:\n  ${f.root}\n` }),
      { status: 0, stdout: banner + `==> keepgoing is not installed from ${f.root}; nothing to do\n`, stderr: "", calls: [list] });
  });
  test(`${name}: forward preview, home selection and failures`, opts, t => {
    const f = fixture(t, ps), removing = `==> removing keepgoing 1.0.0 (${f.root})\n`;
    const preview = removing + `[dry-run] pi remove ${f.root} --no-approve\n==> done. Restart Pi (or run /reload).\n`;
    for (const flag of ps ? [dry] : [dry, "-n"]) assert.deepEqual(f.run([flag]), { status: 0, stdout: banner + preview, stderr: "", calls: [list] });
    assert.deepEqual(f.run([all], { PI_CODING_AGENT_DIR: f.home }), { status: 2, stdout: banner,
      stderr: `error: ${all} cannot be combined with PI_CODING_AGENT_DIR\n`, calls: [] });
    if (!ps) {
      const lane = join(f.home, ".pi-work", "agent");
      mkdirSync(lane, { recursive: true });
      assert.deepEqual(f.run([all, dry]), { status: 0, stdout: banner + `==> Pi home: ${lane}\n` + preview + "==> 1 Pi homes processed\n", stderr: "", calls: [list] });
    }
    const failed = f.run([], { REMOVE_EXIT: "37" });
    assert.equal(failed.status, ps ? 1 : 37);
    assert.equal(failed.stdout, banner + removing);
    if (ps) assert.match(failed.stderr, /command failed:/); else assert.equal(failed.stderr, "");
    assert.deepEqual(failed.calls, [list, ["remove", f.root, "--no-approve"]]);
  });
}

test("PowerShell: success replaces stale status without terminating the caller", { skip: !powershell && "PowerShell unavailable" }, t => {
  const f = fixture(t, true);
  assert.deepEqual(f.run([], { LIST: "User packages:\n" }, '$global:LASTEXITCODE = 41; & $env:SCRIPT; "caller: $LASTEXITCODE"'),
    { status: 0, stdout: banner + `==> keepgoing is not installed from ${f.root}; nothing to do\ncaller: 0\n`, stderr: "", calls: [list] });
});

test("PowerShell checkout uninstaller documents only its own switches", () => {
  const script = readFileSync(new URL("../uninstall.ps1", import.meta.url), "utf8");
  assert.ok(script.includes(psUsage));
  assert.match(script, /install\.ps1/);
  assert.doesNotMatch(script, /\bpi (?:install|list|remove)\b/i);
});
