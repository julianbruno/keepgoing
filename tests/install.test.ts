import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const version = "9.8.7";
const banner = `==> keepgoing ${version}`;

function fixture(t: any, manifest: string | null = JSON.stringify({ name: "pi-keepgoing", version, dependencies: { other: "1.0.0" } }, null, 2)) {
  const root = mkdtempSync(join(tmpdir(), "keepgoing-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "extensions"));
  mkdirSync(join(root, "bin"));
  copyFileSync(new URL("../install.sh", import.meta.url), join(root, "install.sh"));
  if (manifest !== null) writeFileSync(join(root, "package.json"), manifest);
  writeFileSync(join(root, "extensions/keepgoing.ts"), "");
  const calls = join(root, "calls.jsonl");
  writeFileSync(calls, "");
  writeFileSync(join(root, "bin/pi"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "list") {
  process.stdout.write(process.env.LIST);
  process.exit(Number(process.env.LIST_EXIT || 0));
}
`, { mode: 0o755 });
  for (const [name, body] of [["uname", "echo Linux"], ["systemd-inhibit", "exit 0"]]) {
    writeFileSync(join(root, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  return {
    root,
    run(args: string[], list: string, listExit = 0) {
      const result = spawnSync("bash", [join(root, "install.sh"), ...args], {
        encoding: "utf8", timeout: 5000,
        env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, CALLS: calls, LIST: list, LIST_EXIT: String(listExit), HOME: root, PI_CODING_AGENT_DIR: join(root, "bin") },
      });
      assert.equal(result.error, undefined);
      return { ...result, calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
    },
  };
}

for (const relative of [false, true]) {
  for (const action of ["status", "install", "uninstall"]) {
    test(`shell installer ${action} recognizes ${relative ? "relative" : "absolute"} personal declarations`, { skip: process.platform === "win32" }, t => {
      const f = fixture(t);
      const source = relative ? ".." : f.root;
      const result = f.run([action], `User packages:\n  ${source}\n    ${f.root}\n`);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      const lines = action === "status" ? [`keepgoing is installed from ${f.root}`]
        : action === "uninstall" ? [`removing keepgoing ${version} (${f.root})`, "done. Restart Pi (or run /reload)."]
        : [`keepgoing already installed from ${f.root}`, "done. Restart Pi (or run /reload) and check /jb:keepgoing and /jb:keepgoing inhibit.", `keep this checkout in place: Pi loads the package from ${f.root}`];
      assert.equal(result.stdout, [banner, ...lines.map(line => `==> ${line}`)].join("\n") + "\n");
      assert.deepEqual(result.calls, action === "uninstall" ? [["list", "--no-approve"], ["remove", f.root, "--no-approve"]] : [["list"]]);
    });
  }
}

for (const action of ["status", "install", "uninstall"]) {
  test(`shell installer ${action} preserves absent-source behavior and ignores project declarations`, { skip: process.platform === "win32" }, t => {
    const f = fixture(t);
    const result = f.run([action], `User packages:\n  npm:other\n    ${join(f.root, "bin")}\nProject packages:\n  ${f.root}\n    ${f.root}\n`);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const lines = action === "install" ? [`installing keepgoing ${version} from ${f.root}`, "done. Restart Pi (or run /reload) and check /jb:keepgoing and /jb:keepgoing inhibit.", `keep this checkout in place: Pi loads the package from ${f.root}`]
      : [`keepgoing is not installed from ${f.root}${action === "uninstall" ? "; nothing to do" : ""}`];
    assert.equal(result.stdout, [banner, ...lines.map(line => `==> ${line}`)].join("\n") + "\n");
    assert.deepEqual(result.calls, action === "install" ? [["list"], ["install", f.root]] : [action === "uninstall" ? ["list", "--no-approve"] : ["list"]]);
  });
}

for (const action of ["install", "uninstall"]) {
  test(`shell installer ${action} dry-run never changes declarations`, { skip: process.platform === "win32" }, t => {
    const f = fixture(t);
    const list = action === "install" ? "User packages:\n" : `User packages:\n  ${f.root}\n    ${f.root}\n`;
    const result = f.run([action, "--dry-run"], list);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const step = action === "install" ? "install" : "remove";
    const lines = action === "install" ? [`==> installing keepgoing ${version} from ${f.root}`, `[dry-run] pi ${step} ${f.root}`, "==> done. Restart Pi (or run /reload) and check /jb:keepgoing and /jb:keepgoing inhibit.", `==> keep this checkout in place: Pi loads the package from ${f.root}`]
      : [`==> removing keepgoing ${version} (${f.root})`, `[dry-run] pi ${step} ${f.root} --no-approve`, "==> done. Restart Pi (or run /reload)."];
    assert.equal(result.stdout, [banner, ...lines].join("\n") + "\n");
    assert.deepEqual(result.calls, [action === "uninstall" ? ["list", "--no-approve"] : ["list"]]);
  });
}

test("shell installer fails closed when pi list fails", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const result = f.run(["install"], "", 1);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, `${banner}\n`);
  assert.equal(result.stderr, "error: pi list failed; no package changes made\n");
  assert.deepEqual(result.calls, [["list"]]);
});

// The real manifest minus "type", which would turn the fixture's CommonJS fake pi into ESM.
const real = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
for (const [label, manifest, expected] of [["has no version", "{}", "unknown"], ["is missing", null, "unknown"],
  ["is the real manifest", JSON.stringify({ ...real, type: undefined }, null, 2), real.version]] as const) {
  test(`shell installer first line names the version when package.json ${label}`, { skip: process.platform === "win32" }, t => {
    const f = fixture(t, manifest);
    const result = f.run(["status"], `User packages:\n  ${f.root}\n`);
    assert.equal(result.stdout.split("\n")[0], `==> keepgoing ${expected}`);
    if (manifest === null) {
      assert.equal(result.status, 1);
      assert.equal(result.stdout, `==> keepgoing unknown\n`);
      assert.equal(result.stderr, "error: run this script from inside the keepgoing checkout\n");
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `==> keepgoing ${expected}\n==> keepgoing is installed from ${f.root}\n`);
    }
  });
}

test("shell installer rejects a checkout that only has the legacy inhibit entry", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  rmSync(join(f.root, "extensions/keepgoing.ts"));
  writeFileSync(join(f.root, "extensions/inhibit.ts"), "");
  const result = f.run(["install"], "User packages:\n");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, `${banner}\n`);
  assert.equal(result.stderr, "error: run this script from inside the keepgoing checkout\n");
  assert.deepEqual(result.calls, []);
});

test("shell installer --help output is unchanged and has no version line", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const result = f.run(["--help"], "");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "Install or remove keepgoing as a personal Pi package (Linux/systemd and macOS).\nUsage: ./install.sh [install|uninstall|status] [--dry-run] [--all-homes]\n--all-homes runs the action in every Pi home found at ~/.pi/agent and ~/.pi-*/agent.\n");
  assert.deepEqual(result.calls, []);
});

// --all-homes: each discovered ~/.pi*/agent home gets its own run with PI_CODING_AGENT_DIR.
function lanes(t: any, homes: Record<string, string | null>) {
  const f = fixture(t);
  const home = join(f.root, "home");
  for (const [name, list] of Object.entries(homes)) {
    mkdirSync(join(home, name, "agent"), { recursive: true });
    if (list !== null) writeFileSync(join(home, name, "agent", "list.txt"), list);
  }
  mkdirSync(join(home, ".pip"), { recursive: true }); // not a Pi home
  writeFileSync(join(f.root, "bin/pi"), `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const dir = process.env.PI_CODING_AGENT_DIR, args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify([dir ?? null, ...args]) + "\\n");
if (args[0] === "list") {
  const file = dir && path.join(dir, "list.txt");
  if (!file || !fs.existsSync(file)) process.exit(1);
  process.stdout.write(fs.readFileSync(file, "utf8"));
}
`, { mode: 0o755 });
  return {
    home,
    run(args: string[], extra: Record<string, string> = {}) {
      const env: Record<string, string | undefined> = { ...process.env, HOME: home, PATH: `${join(f.root, "bin")}:${process.env.PATH}`, CALLS: join(f.root, "calls.jsonl"), ...extra };
      if (!("PI_CODING_AGENT_DIR" in extra)) delete env.PI_CODING_AGENT_DIR;
      const result = spawnSync("bash", [join(f.root, "install.sh"), ...args], { encoding: "utf8", timeout: 5000, env });
      assert.equal(result.error, undefined);
      return { ...result, root: f.root, calls: readFileSync(join(f.root, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
    },
  };
}

test("shell installer --all-homes installs only where missing, one home at a time", { skip: process.platform === "win32" }, t => {
  const l = lanes(t, { ".pi": "User packages:\n", ".pi-opus": null, ".pi-gpt": "User packages:\n" });
  const installed = (root: string) => `User packages:\n  ${root}\n`;
  // .pi-opus already has it; written after fixture creation so root is known.
  const first = l.run(["status", "--all-homes"]);
  writeFileSync(join(l.home, ".pi-opus/agent/list.txt"), installed(first.root));
  const result = l.run(["install", "--all-homes"]);
  const pi = join(l.home, ".pi/agent"), gpt = join(l.home, ".pi-gpt/agent"), opus = join(l.home, ".pi-opus/agent");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const done = ["==> done. Restart Pi (or run /reload) and check /jb:keepgoing and /jb:keepgoing inhibit.", `==> keep this checkout in place: Pi loads the package from ${result.root}`];
  assert.equal(result.stdout.split("\n").filter(line => line === banner).length, 1, "version printed exactly once");
  assert.equal(result.stdout, [
    banner,
    `==> Pi home: ${pi}`, `==> installing keepgoing ${version} from ${result.root}`, ...done,
    `==> Pi home: ${gpt}`, `==> installing keepgoing ${version} from ${result.root}`, ...done,
    `==> Pi home: ${opus}`, `==> keepgoing already installed from ${result.root}`, ...done,
    "==> 3 Pi homes processed",
  ].join("\n") + "\n");
  assert.deepEqual(result.calls.slice(-5), [[pi, "list"], [pi, "install", result.root], [gpt, "list"], [gpt, "install", result.root], [opus, "list"]]);
});

test("shell installer --all-homes status reports each home, continues past failures, and exits 1", { skip: process.platform === "win32" }, t => {
  const l = lanes(t, { ".pi": "User packages:\n", ".pi-nan": null });
  const result = l.run(["status", "--all-homes"]);
  const pi = join(l.home, ".pi/agent"), nan = join(l.home, ".pi-nan/agent");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, [banner, `==> Pi home: ${pi}`, `==> keepgoing is not installed from ${result.root}`, `==> Pi home: ${nan}`].join("\n") + "\n");
  assert.equal(result.stderr, `error: pi list failed; no package changes made\nerror: 1 of 2 Pi homes failed: ${nan}\n`);
  assert.deepEqual(result.calls, [[pi, "list"], [nan, "list"]]);
});

test("shell installer --all-homes dry-run changes nothing and rejects ambiguous or empty targets", { skip: process.platform === "win32" }, t => {
  const l = lanes(t, { ".pi-grok": "User packages:\n" });
  const grok = join(l.home, ".pi-grok/agent");
  const dry = l.run(["install", "--all-homes", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`\\[dry-run\\] pi install ${dry.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.deepEqual(dry.calls, [[grok, "list"]]);
  const both = l.run(["install", "--all-homes"], { PI_CODING_AGENT_DIR: grok });
  assert.equal(both.status, 2);
  assert.equal(both.stderr, "error: --all-homes cannot be combined with PI_CODING_AGENT_DIR\n");
  assert.deepEqual(both.calls, dry.calls);
  rmSync(join(l.home, ".pi-grok"), { recursive: true });
  const none = l.run(["status", "--all-homes"]);
  assert.equal(none.status, 1);
  assert.equal(none.stderr, `error: no Pi homes found (looked for ${l.home}/.pi/agent and ${l.home}/.pi-*/agent)\n`);
});

// Review gap #4: a lane can declare the checkout as a relative source; `pi list` prints it with the resolved path indented.
for (const action of ["status", "install", "uninstall"]) {
  test(`shell installer --all-homes ${action} treats a relative personal declaration as installed`, { skip: process.platform === "win32" }, t => {
    const l = lanes(t, { ".pi": null, ".pi-gpt": "User packages:\n" });
    const root = dirname(l.home), source = "../../..";
    writeFileSync(join(l.home, ".pi/agent/list.txt"), `User packages:\n  ${source}\n    ${root}\n`);
    const result = l.run([action, "--all-homes"]);
    const pi = join(l.home, ".pi/agent"), gpt = join(l.home, ".pi-gpt/agent");
    assert.equal(result.root, root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const done = ["==> done. Restart Pi (or run /reload) and check /jb:keepgoing and /jb:keepgoing inhibit.", `==> keep this checkout in place: Pi loads the package from ${root}`];
    const [relative, absent] = action === "status" ? [[`==> keepgoing is installed from ${root}`], [`==> keepgoing is not installed from ${root}`]]
      : action === "install" ? [[`==> keepgoing already installed from ${root}`, ...done], [`==> installing keepgoing ${version} from ${root}`, ...done]]
      : [[`==> removing keepgoing ${version} (${root})`, "==> done. Restart Pi (or run /reload)."], [`==> keepgoing is not installed from ${root}; nothing to do`]];
    assert.equal(result.stdout, [banner, `==> Pi home: ${pi}`, ...relative, `==> Pi home: ${gpt}`, ...absent, "==> 2 Pi homes processed"].join("\n") + "\n");
    assert.deepEqual(result.calls, action === "status" ? [[pi, "list"], [gpt, "list"]]
      : action === "install" ? [[pi, "list"], [gpt, "list"], [gpt, "install", root]]
      : [[pi, "list", "--no-approve"], [pi, "remove", root, "--no-approve"], [gpt, "list", "--no-approve"]]);
  });
}
