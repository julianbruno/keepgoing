import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createInhibitor } from "../src/inhibitor.ts";

class FakeChild extends EventEmitter {
  pid = 4123;
}

function fixture(platform: NodeJS.Platform = "linux", env: { SystemRoot?: string } = {}) {
  const children: FakeChild[] = [];
  const spawns: unknown[][] = [];
  const signals: Array<[number, string]> = [];
  const inhibitor = createInhibitor({
    pid: 789,
    platform,
    env,
    spawn: (...args) => {
      spawns.push(args);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    kill: (pid, signal) => {
      signals.push([pid, signal]);
    },
  });
  return { inhibitor, children, spawns, signals };
}

test("start inhibits sleep without idle, uses the Pi PID watchdog, and starts only once", () => {
  const { inhibitor, spawns } = fixture();
  assert.equal(inhibitor.start(), true);
  assert.equal(inhibitor.start(), false);
  assert.equal(inhibitor.active, true);
  assert.deepEqual(spawns, [[
    "/usr/bin/systemd-inhibit",
    ["--what=sleep", "--mode=block", "--who=keepgoing", "--why=Pi trabajando", "/usr/bin/tail", "--pid=789", "-f", "/dev/null"],
    { detached: true, stdio: "ignore" },
  ]]);
  assert.equal(JSON.stringify(spawns).includes("idle"), false);
});

test("an acquired inhibitor lets an otherwise idle Node parent exit", () => {
  const moduleUrl = new URL("../src/inhibitor.ts", import.meta.url).href;
  const parent = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { spawn } from 'node:child_process';
    import { createInhibitor } from ${JSON.stringify(moduleUrl)};
    let helper;
    const inhibitor = createInhibitor({
      pid: process.pid, platform: 'linux', kill: process.kill,
      spawn: (_, args, options) => helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], options),
    });
    if (!inhibitor.acquire('test') || !helper.pid) throw new Error('helper not acquired');
    process.once('exit', () => helper.kill());
    process.once('beforeExit', () => {
      if (!inhibitor.has('test')) throw new Error('parent waited for inhibitor loss');
    });
  `], { encoding: "utf8", timeout: 10000 });
  assert.ifError(parent.error);
  assert.equal(parent.status, 0, parent.stderr);
});

test("stop signals only the owned group and is harmless when inactive", () => {
  const { inhibitor, signals } = fixture();
  assert.equal(inhibitor.stop(), false);
  inhibitor.start();
  assert.equal(inhibitor.stop(), true);
  assert.equal(inhibitor.active, false);
  assert.equal(inhibitor.stop(), false);
  assert.deepEqual(signals, [[-4123, "SIGTERM"]]);
});

test("spawn error and exit clear state without killing a replacement", () => {
  const { inhibitor, children, signals } = fixture();
  inhibitor.start();
  children[0].emit("error", new Error("missing executable"));
  assert.equal(inhibitor.active, false);
  inhibitor.start();
  children[0].emit("exit", 1);
  assert.equal(inhibitor.active, true);
  children[1].emit("exit", 0);
  assert.equal(inhibitor.active, false);
  assert.deepEqual(signals, []);
});

test("manual and session owners share one inhibitor without releasing each other", () => {
  const { inhibitor, spawns, signals } = fixture();
  assert.equal(inhibitor.acquire("manual"), true);
  assert.equal(inhibitor.acquire("session:one"), true);
  assert.equal(spawns.length, 1);
  assert.equal(inhibitor.release("manual"), true);
  assert.equal(inhibitor.active, true);
  assert.deepEqual(signals, []);
  assert.equal(inhibitor.release("session:one"), true);
  assert.equal(inhibitor.active, false);
  assert.deepEqual(signals, [[-4123, "SIGTERM"]]);
});

test("macOS uses system-only caffeinate and Windows uses hidden system-only execution state", () => {
  const mac = fixture("darwin");
  mac.inhibitor.acquire("manual");
  assert.deepEqual(mac.spawns[0], ["caffeinate", ["-i", "-w", "789"], { detached: true, stdio: "ignore" }]);
  const win = fixture("win32", { SystemRoot: "D:\\Windows" });
  win.inhibitor.acquire("manual");
  const [command, args, options] = win.spawns[0] as [string, string[], object];
  assert.equal(command, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(options, { detached: true, stdio: "ignore", windowsHide: true });
  assert.deepEqual(args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command"]);
  assert.doesNotMatch(args.at(-1)!, /0x80000002|2147483650|omarchy|toggle idle/);
  win.inhibitor.release("manual");
  assert.deepEqual(win.signals, [[4123, "SIGTERM"]], "Windows must signal its owned PID, not a Unix process group");
});

test("Windows refuses to start without a fully qualified SystemRoot", () => {
  for (const SystemRoot of [undefined, "", "Windows", "D:Windows", "\\Windows"]) {
    const { inhibitor, spawns } = fixture("win32", { SystemRoot });
    assert.throws(() => inhibitor.acquire("manual"), /SystemRoot/);
    assert.deepEqual(spawns, []);
    assert.equal(inhibitor.active, false);
    assert.equal(inhibitor.release("manual"), false);
  }
});

test("Windows helper stops on setup errors or a zero result before the watchdog loop", () => {
  const { inhibitor, spawns } = fixture("win32", { SystemRoot: "C:\\Windows" });
  inhibitor.start();
  const script = (spawns[0][1] as string[]).at(-1)!;
  assert.match(script, /\$ErrorActionPreference = 'Stop'\s+Add-Type [^\n]*extern uint SetThreadExecutionState\(uint flags\);'/);
  assert.match(script, /if \(\[Win\.Sleep\]::SetThreadExecutionState\(\[uint32\]2147483649\) -eq 0\) \{ exit 1 \}\s+try \{\s+while \(Get-Process -Id 789 -ErrorAction SilentlyContinue\)/);
  assert.match(script, /finally \{\s+\[void\]\[Win\.Sleep\]::SetThreadExecutionState\(\[uint32\]2147483648\)/);
});

test("unexpected backend loss notifies once with affected owners, and later events cannot affect replacements", () => {
  const { inhibitor, children } = fixture();
  const lost: string[][] = [];
  const unsubscribe = inhibitor.onLoss(owners => { lost.push(owners); });
  inhibitor.acquire("manual");
  inhibitor.acquire("session:one");
  children[0].emit("error", new Error("helper failed"));
  assert.deepEqual(lost, [["manual", "session:one"]]);
  assert.equal(inhibitor.has("manual"), false);
  inhibitor.acquire("session:two");
  children[0].emit("exit", 1);
  assert.deepEqual(lost, [["manual", "session:one"]]);
  assert.equal(inhibitor.has("session:two"), true);
  unsubscribe();
  children[1].emit("exit", 1);
  assert.deepEqual(lost, [["manual", "session:one"]]);
});

test("intentional final release never emits backend loss", () => {
  const { inhibitor, children } = fixture();
  const lost: string[][] = [];
  inhibitor.onLoss(owners => { lost.push(owners); });
  inhibitor.acquire("manual");
  inhibitor.release("manual");
  children[0].emit("exit", 0);
  children[0].emit("error", new Error("late"));
  assert.deepEqual(lost, []);
});

test("late exit after stop cannot clear a new inhibitor", () => {
  const { inhibitor, children, signals } = fixture();
  inhibitor.start();
  inhibitor.stop();
  inhibitor.start();
  children[0].emit("exit", 0);
  assert.equal(inhibitor.active, true);
  inhibitor.stop();
  assert.deepEqual(signals, [[-4123, "SIGTERM"], [-4123, "SIGTERM"]]);
});
