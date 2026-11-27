import assert from "node:assert/strict";
import { test } from "node:test";
import { createExtension, packageVersionLine } from "../extensions/keepgoing.ts";
import { createInhibitor } from "../src/inhibitor.ts";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const versionLine = `keepgoing ${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version}`;

function harness(extras: Record<string, unknown> = {}, mode = "rpc", backend?: ReturnType<typeof createInhibitor>) {
  const commands = new Map<string, any>();
  const events = new Map<string, Array<(event: any, ctx: any) => any>>();
  const shortcuts = new Map<string, any>();
  const terminalListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
  const messages: string[] = [];
  const entries: any[] = [];
  const branch: any[] = [];
  const sent: any[] = [];
  const customSent: any[] = [];
  const jobs: Array<{ deadline: number; fire(): void; cancelled: boolean }> = [];
  let now = Date.parse("2026-09-12T12:00:00Z");
  let session = "one";
  const owners = new Set<string>();
  const inhibitor = {
    get active() { return owners.size > 0; },
    has: (owner: string) => owners.has(owner),
    acquire: (owner: string) => { if (owners.has(owner)) return false; owners.add(owner); return true; },
    release: (owner: string) => owners.delete(owner),
  };
  const ctx = {
    mode, hasUI: mode === "tui", ui: {
      notify: (text: string) => messages.push(text),
      setStatus: () => {},
      onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
        terminalListeners.add(handler);
        return () => { terminalListeners.delete(handler); };
      },
    },
    sessionManager: {
      getSessionId: () => session,
      getSessionFile: (): string | undefined => `/sessions/${session}.jsonl`,
      getBranch: () => [...branch, ...entries.filter(item => item.session === session).map(item => ({ type: "custom", customType: item.customType, data: item.data }))],
      getEntries(): any[] { return this.getBranch(); },
    },
    model: { provider: "anthropic" }, modelRegistry: { isUsingOAuth: () => false, getApiKeyForProvider: async (): Promise<string | undefined> => undefined },
    isIdle: () => true, hasPendingMessages: () => false,
  };
  const pi = {
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut: (key: string, shortcut: any) => shortcuts.set(key, shortcut),
    on: (name: string, listener: any) => { events.set(name, [...(events.get(name) ?? []), listener]); },
    appendEntry: (customType: string, data: any) => entries.push({ session, customType, data }),
    sendMessage: (message: any, options: any) => customSent.push({ message, options }),
    sendUserMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  createExtension(backend ?? inhibitor as any, "linux", {
    now: () => now,
    schedule: (fire: () => void, delay: number) => {
      const job = { deadline: now + delay, fire, cancelled: false };
      jobs.push(job);
      return job;
    },
    cancel: (job: any) => { job.cancelled = true; },
    ...extras,
  })(pi as any);
  async function emit(name: string, event: any = {}) {
    let result;
    for (const listener of events.get(name) ?? []) result = await listener(event, ctx) ?? result;
    return result;
  }
  function advance(milliseconds: number) {
    now += milliseconds;
    for (const job of jobs.filter(job => !job.cancelled && job.deadline <= now)) { job.cancelled = true; job.fire(); }
  }
  return { pi, commands, shortcuts, terminalListeners, ctx, emit, messages, sent, customSent, jobs, owners, entries, branch, advance, setNow: (value: string) => { now = Date.parse(value); }, setSession: (id: string) => { session = id; } };
}
// Obtain a genuine record and lease name through the public opt-in, not a mock encoding.
const optedIn = harness();
await optedIn.commands.get("jb:keepgoing").handler("on", optedIn.ctx);
const ownConsent = optedIn.entries.at(-1).data;
const [oneLease] = optedIn.owners;

function backendHarness(mode = "tui") {
  const children: EventEmitter[] = [];
  const backend = createInhibitor({
    pid: 789,
    platform: "linux",
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { pid: 4123 });
      children.push(child);
      return child;
    },
    kill: () => {},
  });
  return { ...harness({}, mode, backend), backend, children };
}

// Shared fixtures, declared before any test that uses them.
const failure = { role: "assistant", provider: "anthropic", stopReason: "error", errorMessage: "5-hour usage limit reached; resets at 2026-09-12T12:05:00Z" };
const settled = [failure];

const bridgeFailure = { role: "assistant", provider: "claude-bridge", stopReason: "error",
  errorMessage: "Claude rate limit (five_hour) — resets 1:50:00 AM: You've hit your session limit · resets 1:50am (America/Argentina/Buenos_Aires)" };

const reportedLimit = "You've hit your 5-hour limit · resets 8:50pm (America/Argentina/Buenos_Aires)";
const reportedQuota = "Claude quota exceeded — rate limit (five_hour) — resets 8:50:00 PM: " + reportedLimit;

function replay(h: ReturnType<typeof harness>, entries: ReturnType<typeof harness>["entries"]) {
  for (const { customType, data } of entries) h.branch.push({ type: "custom", customType, data: structuredClone(data) });
}

// Review gap #4: a 4pm Buenos Aires bridge reset (19:00Z plus the 90 s buffer), anchored on the error timestamp.
const passedFailure = { ...bridgeFailure, timestamp: Date.parse("2026-11-17T15:58:25Z"),
  errorMessage: "Claude quota exceeded — rate limit (five_hour) — resets 4:00:00 PM: You've hit your 5-hour limit · resets 4pm (America/Argentina/Buenos_Aires)" };
const passedReset = Date.parse("2026-11-17T19:01:30Z");
const resetContinuation = { message: "Continue the interrupted request after the provider usage window reset. Do not make decisions for the user.", options: { expandPromptTemplates: false } };
const liveJobs = (h: ReturnType<typeof harness>) => h.jobs.filter(job => !job.cancelled);

test("the waiting status bar shows just the countdown", async () => {
  const h = harness({}, "tui");
  let status: string | undefined;
  const ctx = { ...h.ctx, ui: { ...h.ctx.ui, setStatus: (_key: string, value?: string) => { status = value; } } };
  await h.commands.get("jb:keepgoing").handler("wait 24m", ctx);
  assert.equal(status, "keepgoing ⏳ resumes in 24m");
});

test("friendly on and status share a local midnight report and rounded countdown", async () => {
  const previous = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  try {
    const h = harness({}, "tui");
    h.setNow("2026-10-09T14:50:30Z");
    const command = h.commands.get("jb:keepgoing");
    await command.handler("wait 24m", h.ctx);
    await command.handler("on", h.ctx);
    const report = h.messages.at(-1)!;
    await command.handler("status", h.ctx);
    assert.equal(h.messages.at(-1), report);
    assert.match(report, /Resume is ON\. Waiting for your requested time/);
    assert.match(report, /Continue at: 00:14:30 · Oct 10, 2026 · Asia\/Tokyo/);
    assert.match(report, /Time remaining: 24m/);
    assert.match(report, /Your computer will stay awake \(the screen can still turn off\)/);
    assert.match(report, /Keep this Pi session open/);
    assert.match(report, /Cancel with \/jb:keepgoing off or Escape/);
    assert.doesNotMatch(report, /lease|process|provider window|\d{4}-\d{2}-\d{2}T|\/12|Argentina/);
    for (const [elapsed, expected] of [[1, "24m"], [1_379_999, "1m"], [1, "60s"], [999, "59s"], [58_999, "1s"]] as const) {
      h.advance(elapsed);
      await command.handler("status", h.ctx);
      assert.ok(h.messages.at(-1)!.includes(`Time remaining: ${expected}`));
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

for (const kind of ["manual timed", "provider-reset"]) {
  test(`successful ${kind} continuation reports sent history and monitoring advice`, async () => {
    const h = harness({}, "tui");
    const command = h.commands.get("jb:keepgoing");
    if (kind === "manual timed") {
      await command.handler("on", h.ctx);
      await command.handler("wait 24m", h.ctx);
    }
    else {
      h.branch.push({ type: "message", message: failure });
      await command.handler("on", h.ctx);
    }
    h.advance(1_440_000);
    assert.equal(h.sent.length, 1);
    await command.handler("status", h.ctx);
    const report = h.messages.at(-1)!;
    assert.match(report, /Resume is ON and watching for Claude's 5-hour usage limit/);
    assert.match(report, /Previously: the continuation was sent to Pi\./);
    assert.ok(report.includes("Next: Resume will monitor for another usage limit. Use /jb:keepgoing off if you no longer need it."));
    assert.doesNotMatch(report, /Answer the human prompt|waiting for|Time remaining:/);
  });
}

for (const kind of ["manual", "provider"]) {
  test(`last continuation records actual successful ${kind} dispatch in local time`, async () => {
    const previous = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      const h = harness({}, "tui");
      const command = h.commands.get("jb:keepgoing");
      await command.handler("status", h.ctx);
      assert.doesNotMatch(h.messages.at(-1)!, /Last continuation at/);
      if (kind === "manual") await command.handler("wait 1m", h.ctx);
      else {
        h.branch.push({ type: "message", message: failure });
        await command.handler("on", h.ctx);
      }
      await command.handler("status", h.ctx);
      assert.doesNotMatch(h.messages.at(-1)!, /Last continuation at/);
      // Dispatch is late, and the synchronous send itself advances the clock.
      h.pi.sendUserMessage = (message, options) => {
        h.sent.push({ message, options });
        h.setNow("2026-09-12T12:07:09Z");
        return 1;
      };
      h.advance(420_000);
      await command.handler("status", h.ctx);
      const line = "Last continuation at: 21:07:09 · Sep 12, 2026 · Asia/Tokyo";
      assert.ok(h.messages.at(-1)!.includes(line));
      await command.handler("wait 1m", h.ctx);
      h.pi.sendUserMessage = () => { throw Error("send failed"); };
      assert.throws(() => h.advance(60_000), /send failed/);
      await command.handler("status", h.ctx);
      assert.ok(h.messages.at(-1)!.includes(line));
      await command.handler("wait 1m", h.ctx);
      h.pi.sendUserMessage = (message, options) => h.sent.push({ message, options });
      h.advance(60_000);
      await command.handler("off", h.ctx);
      assert.match(h.messages.at(-1)!, /Last continuation at: 21:09:09/);
      const before = [h.entries.length, h.jobs.length];
      await command.handler("status", h.ctx);
      assert.match(h.messages.at(-1)!, /Last continuation at: 21:09:09/);
      assert.deepEqual([h.entries.length, h.jobs.length], before);
      await h.emit("session_start");
      await command.handler("status", h.ctx);
      assert.match(h.messages.at(-1)!, /Last continuation at: 21:09:09/);
      const imported = h.entries.at(-1)!.data;
      h.setSession("fork");
      h.branch.length = 0;
      h.branch.push({ type: "custom", customType: "keepgoing.resume", data: imported });
      await h.emit("session_start");
      await command.handler("status", h.ctx);
      assert.doesNotMatch(h.messages.at(-1)!, /Last continuation at/);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
}

test("cancelled and guard-rejected waits never fabricate successful history", async () => {
  const h = harness({}, "tui");
  const command = h.commands.get("jb:keepgoing");
  await command.handler("wait 1m", h.ctx);
  await h.emit("input", { source: "interactive" });
  h.advance(60_000);
  await command.handler("status", h.ctx);
  assert.doesNotMatch(h.messages.at(-1)!, /Last continuation at/);
  await command.handler("wait 1m", h.ctx);
  h.ctx.isIdle = () => false;
  h.advance(60_000);
  await command.handler("status", h.ctx);
  assert.doesNotMatch(h.messages.at(-1)!, /Last continuation at/);
  await command.handler("wait 1m", h.ctx);
  assert.equal(h.sent.length, 0);
  assert.doesNotMatch(h.messages.at(-1)!, /Last continuation at/);
  h.ctx.isIdle = () => true;
  await command.handler("wait 1m", h.ctx);
  h.pi.sendUserMessage = () => { throw Error("first send failed"); };
  assert.throws(() => h.advance(60_000), /first send failed/);
  await command.handler("status", h.ctx);
  assert.doesNotMatch(h.messages.at(-1)!, /Last continuation at/);
});

test("session switch during send never attributes the continuation to the new session", async () => {
  const h = harness({}, "tui");
  const command = h.commands.get("jb:keepgoing");
  await command.handler("wait 1m", h.ctx);
  h.pi.sendUserMessage = (message, options) => {
    h.sent.push({ message, options });
    h.setSession("two");
    void h.emit("session_start");
  };
  h.advance(60_000);
  assert.equal(h.sent.length, 1);
  await command.handler("status", h.ctx);
  assert.doesNotMatch(h.messages.at(-1)!, /Last continuation at/);
  assert.ok(h.entries.every(entry => entry.data.lastContinuationAt === undefined));
});

