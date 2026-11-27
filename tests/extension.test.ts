import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createExtension, getProcessInhibitor } from "../extensions/keepgoing.ts";

function setup(platform: NodeJS.Platform = "linux") {
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const messages: string[] = [];
  let starts = 0;
  const owners = new Set<string>();
  const inhibitor = {
    get active() { return owners.size > 0; },
    has: (owner: string) => owners.has(owner),
    acquire(owner: string) { if (owners.has(owner)) return false; starts++; owners.add(owner); return true; },
    release(owner: string) { return owners.delete(owner); },
  };
  createExtension(inhibitor as any, platform)({
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerShortcut() {},
    on(name: string, handler: any) { events.set(name, handler); },
    appendEntry() {},
  } as any);
  const keepgoing = commands.get("jb:keepgoing");
  // The independent inhibit subcommand of the single /jb:keepgoing command.
  const command = { handler: (arg: string, ctx: any) => keepgoing.handler(`inhibit ${arg}`, ctx) };
  const ctx = { hasUI: true, mode: "rpc", ui: { notify(message: string) { messages.push(message); } },
    sessionManager: { getSessionId: () => "one", getBranch: () => [] } };
  return { commands, events, messages, inhibitor, keepgoing, command, ctx, owners, get starts() { return starts; } };
}

test("manifest declares exactly the extension and Pi peer dependency", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions/keepgoing.ts"]);
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
});

test("manifest retains a dependency-free SemVer version", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.dependencies, undefined);
});

test("macOS and Windows manual ownership uses the same controller", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    const state = setup(platform);
    await state.command.handler("on", state.ctx);
    assert.deepEqual(state.messages, ["Sleep inhibitor enabled."]);
    assert.equal(state.starts, 1);
  }
});

test("registers exactly one namespaced command with manual inhibit argument completions", () => {
  const { commands, keepgoing } = setup();
  assert.deepEqual([...commands.keys()], ["jb:keepgoing"]);
  assert.deepEqual(keepgoing.getArgumentCompletions("inhibit "), [
    { value: "inhibit on", label: "on" }, { value: "inhibit off", label: "off" }, { value: "inhibit status", label: "status" },
  ]);
  assert.deepEqual(keepgoing.getArgumentCompletions("inhibit o"), [
    { value: "inhibit on", label: "on" }, { value: "inhibit off", label: "off" },
  ]);
  assert.deepEqual(keepgoing.getArgumentCompletions("inhibit s"), [{ value: "inhibit status", label: "status" }]);
  assert.equal(keepgoing.getArgumentCompletions("inhibit missing"), null);
});

test("on, off, and status report transitions without redundant actions", async () => {
  const { command, ctx, messages, inhibitor } = setup();
  for (const arg of ["status", "on", "on", "status", "off", "off", "status"]) await command.handler(arg, ctx);
  assert.deepEqual(messages, [
    "Sleep inhibitor is inactive.", "Sleep inhibitor enabled.",
    "Sleep inhibitor is already active.", "Sleep inhibitor is active.",
    "Sleep inhibitor disabled.", "Sleep inhibitor is already inactive.",
    "Sleep inhibitor is inactive.",
  ]);
  assert.equal(inhibitor.active, false);
});

test("invalid and empty arguments display namespaced usage", async () => {
  const { command, ctx, messages } = setup();
  for (const arg of ["", "bogus", "on off", " ON "]) await command.handler(arg, ctx);
  assert.deepEqual(messages, Array(4).fill("Usage: /jb:keepgoing inhibit on|off|status"));
});

test("session replacement retains manual inhibition and quit releases it", async () => {
  const { events, inhibitor, ctx } = setup();
  inhibitor.acquire("manual");
  for (const reason of ["reload", "new", "resume", "fork"]) {
    await events.get("session_shutdown")({ reason }, ctx);
    assert.equal(inhibitor.has("manual"), true, reason);
  }
  await events.get("session_shutdown")({ reason: "quit" }, ctx);
  assert.equal(inhibitor.has("manual"), false);
  await events.get("session_shutdown")({ reason: "quit" }, ctx);
  assert.equal(inhibitor.has("manual"), false);
});

test("the process controller registry uses the keepgoing identity only", () => {
  const scope: Record<symbol, unknown> = {};
  const otherKey = Symbol.for("other-extension.inhibitor.controller");
  const otherController = { other: true };
  scope[otherKey] = otherController;
  const controller = getProcessInhibitor(scope, () => ({ fresh: true }));
  assert.deepEqual(controller, { fresh: true });
  assert.strictEqual(scope[Symbol.for("keepgoing.inhibitor.controller")], controller);
  assert.strictEqual(scope[otherKey], otherController);
});

test("new extension runtimes reuse the same process controller and can stop it", async () => {
  const scope = {};
  let creations = 0;
  const factory = () => {
    creations++;
    const owners = new Set<string>();
    return { get active() { return owners.size > 0; }, has: (owner: string) => owners.has(owner),
      acquire: (owner: string) => { if (owners.has(owner)) return false; owners.add(owner); return true; },
      release: (owner: string) => owners.delete(owner) };
  };
  const first = getProcessInhibitor(scope, factory);
  const second = getProcessInhibitor(scope, factory);
  assert.strictEqual(second, first);
  assert.equal(creations, 1);
  const commands = new Map<string, any>();
  createExtension(second as any)({ registerCommand(name: string, command: any) { commands.set(name, command); }, on() {}, registerShortcut() {} } as any);
  first.acquire("manual");
  const messages: string[] = [];
  const ctx = { hasUI: true, mode: "rpc", ui: { notify(message: string) { messages.push(message); } } };
  await commands.get("jb:keepgoing").handler("inhibit status", ctx);
  await commands.get("jb:keepgoing").handler("inhibit off", ctx);
  assert.deepEqual(messages, ["Sleep inhibitor is active.", "Sleep inhibitor disabled."]);
  assert.equal(first.active, false);
});
