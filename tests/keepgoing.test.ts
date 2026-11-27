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

test("restore accepts only representable successful timestamps owned by this session", async () => {
  const valid = Date.parse("2026-09-12T12:07:09Z");
  const cases: Record<string, unknown>[] = [
    {}, { lastContinuationAt: valid },
    ...[undefined, null, "123", NaN, Infinity, -Infinity, 8.64e15 + 1, -8.64e15 - 1, {}].map(lastContinuationAt => ({ lastContinuationAt, lastContinuationSession: "one" })),
    { lastContinuationAt: valid, lastContinuationSession: "other" },
    { lastContinuationAt: valid, lastContinuationSession: 123 },
    { lastContinuationAt: valid, lastContinuationSession: "one" },
  ];
  for (const fields of cases) {
    const h = harness({}, "tui");
    h.branch.push({ type: "custom", customType: "keepgoing.resume", data: {
      enabled: false, resumes: 3, lastResume: valid, ...fields,
    } });
    await h.emit("session_start");
    await h.commands.get("jb:keepgoing").handler("status", h.ctx);
    const expected = fields.lastContinuationAt === valid && fields.lastContinuationSession === "one";
    assert.equal(h.messages.at(-1)!.includes("Last continuation at:"), expected);
    assert.equal(h.entries.length, 0);
  }
});

test("restored continuation counts never disable monitoring or show a ceiling", async () => {
  for (const count of [0, 9, 10, 11, 12, 13, 40]) {
    const h = harness({}, "tui");
    h.branch.push({ type: "custom", customType: "keepgoing.resume", data: { ...ownConsent, resumes: count } });
    await h.emit("session_start");
    await h.commands.get("jb:keepgoing").handler("status", h.ctx);
    assert.match(h.messages.at(-1)!, /^✅ Resume is ON and watching for Claude's 5-hour usage limit\. Nothing is scheduled yet\.\n/);
    assert.doesNotMatch(h.messages.at(-1)!, /\/12|continuations used|limit reached|remaining in this session/);
    assert.equal(h.entries.length, 0);
    assert.equal(h.sent.length, 0);
  }
});

for (const count of [11, 12, 13, 40]) {
  test(`manual wait and now still dispatch once after ${count} continuations`, async () => {
    const h = harness({}, "tui");
    h.branch.push({ type: "custom", customType: "keepgoing.resume", data: { ...ownConsent, resumes: count } });
    await h.emit("session_start");
    const command = h.commands.get("jb:keepgoing");
    await command.handler("wait 1h", h.ctx);
    assert.equal(h.sent.length, 0);
    await command.handler("now", h.ctx);
    h.advance(1);
    assert.deepEqual(h.sent, [{ message: "Continue", options: { expandPromptTemplates: false } }]);
    await command.handler("off", h.ctx);
    h.advance(3_600_000);
    assert.equal(h.sent.length, 1);
    assert.match(h.messages.at(-1)!, /Resume is OFF/);
  });
}

for (const provider of ["claude-bridge", "anthropic", "openai-codex"]) {
  test(`${provider} keeps recovering exhaustion beyond twelve windows but never resumes healthy usage`, async () => {
    const h = harness({}, "tui");
    const command = h.commands.get("jb:keepgoing");
    await command.handler("on", h.ctx);
    for (let index = 0; index < 14; index++) {
      const start = Date.parse("2026-10-21T12:00:00Z") + index * 5 * 3_600_000;
      h.setNow(new Date(start).toISOString());
      for (const message of [
        { role: "assistant", provider, stopReason: "stop" },
        { role: "assistant", provider, stopReason: "error", errorMessage: "Claude usage warning: 95% of session limit used" },
      ]) {
        await h.emit("agent_start");
        await h.emit("agent_end", { messages: [message] });
        await h.emit("agent_settled");
      }
      h.advance(60_000);
      await command.handler("status", h.ctx);
      assert.match(h.messages.at(-1)!, /watching.*Nothing is scheduled yet/s);
      assert.equal(h.sent.length, index);
      const reset = start + 3_600_000;
      const zonedTime = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit", hour12: true }).format(reset).replace(/\s/g, "").toLowerCase();
      const errorMessage = provider === "claude-bridge"
        ? `Claude quota exceeded — rate limit (five_hour): You've hit your session limit · resets ${zonedTime} (Etc/UTC)`
        : `5-hour usage limit reached; resets at ${new Date(reset).toISOString()}`;
      await h.emit("agent_start");
      await h.emit("agent_end", { messages: [{ role: "assistant", provider, stopReason: "error", errorMessage }] });
      await h.emit("agent_settled");
      await command.handler("status", h.ctx);
      assert.match(h.messages.at(-1)!, /Resume is ON\. Waiting/);
      h.advance(reset + 90_000 - (start + 60_000) - 1);
      assert.equal(h.sent.length, index);
      h.advance(1);
      assert.equal(h.sent.length, index + 1);
      assert.deepEqual(h.sent.at(-1), { message: "Continue the interrupted request after the provider usage window reset. Do not make decisions for the user.", options: { expandPromptTemplates: false } });
      assert.doesNotMatch(h.messages.at(-1)!, /limit reached/);
    }
    await command.handler("off", h.ctx);
    h.setNow("2026-10-25T12:00:00Z");
    await h.emit("agent_end", { messages: [{ role: "assistant", provider, stopReason: "error", errorMessage: provider === "claude-bridge"
      ? "Claude rate limit (five_hour): You've hit your session limit · resets 1:00pm (Etc/UTC)"
      : "5-hour usage limit reached; resets at 2026-10-25T13:00:00Z" }] });
    await h.emit("agent_settled");
    h.advance(3_690_000);
    assert.equal(h.sent.length, 14, "off must stop subsequent exhausted-window recovery");
  });
}

test("countdown rounds up consistently across hour and minute boundaries", async () => {
  const h = harness({}, "tui");
  const command = h.commands.get("jb:keepgoing");
  await command.handler("wait 2h", h.ctx);
  for (const [elapsed, expected] of [[0, "2h"], [1, "2h"], [60_000, "1h 59m"], [3_539_999, "1h"], [1, "1h"], [60_000, "59m"]] as const) {
    h.advance(elapsed);
    await command.handler("status", h.ctx);
    assert.ok(h.messages.at(-1)!.includes(`Time remaining: ${expected}`));
    assert.doesNotMatch(h.messages.at(-1)!, /Time remaining: 0m/);
  }
});

test("diagnostic status is read-only and records actual cancellation without a live blocker", async () => {
  let lookups = 0;
  const h = harness({ resolve: () => { lookups++; return null; } }, "tui");
  const command = h.commands.get("jb:keepgoing");
  await command.handler("on", h.ctx);
  assert.match(h.messages.at(-1)!, /When Claude reports its 5-hour limit, Resume schedules the continuation/);
  await command.handler("wait 24m", h.ctx);
  await h.emit("input", { source: "interactive" });
  const before = [h.jobs.length, h.entries.length, lookups];
  await command.handler("status", h.ctx);
  assert.match(h.messages.at(-1)!, /watching/);
  assert.match(h.messages.at(-1)!, /Previous wait cancelled by user input/);
  assert.doesNotMatch(h.messages.at(-1)!, /WAITING|Blocked/);
  assert.deepEqual([h.jobs.length, h.entries.length, lookups], before);
  h.setSession("two");
  await h.emit("session_start");
  await command.handler("status", h.ctx);
  assert.match(h.messages.at(-1)!, /Resume is OFF/);
  assert.doesNotMatch(h.messages.at(-1)!, /cancelled by user input/);
});

test("pending status stays primary after rejected replacement and shows zoned full deadline", async () => {
  const h = harness({}, "tui");
  const command = h.commands.get("jb:keepgoing");
  await command.handler("wait 24m", h.ctx);
  await command.handler("wait 7h", h.ctx);
  await command.handler("status", h.ctx);
  assert.match(h.messages.at(-1)!, /Waiting for your requested time/);
  assert.match(h.messages.at(-1)!, /Continue at: .*Sep 12, 2026/);
  assert.match(h.messages.at(-1)!, /Time remaining: 24m/);
  assert.match(h.messages.at(-1)!, /screen can still turn off/i);
  assert.match(h.messages.at(-1)!, /The new attempt was not scheduled: wait duration is invalid/);
  h.advance(1_440_000);
  assert.equal(h.sent.length, 1);
});

test("activation reports evaluated guard reasons without claiming an unavailable reset", async () => {
  for (const [kind, reason] of [["busy", "the agent is busy"], ["queued", "messages are queued"],
    ["prompt", "a UI prompt is open"], ["decision", "a human decision is pending"],
    ["repeat", "five-minute repeat guard rejected the attempt"]]) {
    let lookups = 0;
    const h = harness({ resolve: () => { lookups++; return null; } }, "tui");
    h.branch.push({ type: "message", message: failure });
    if (kind === "busy") h.ctx.isIdle = () => false;
    if (kind === "queued") h.ctx.hasPendingMessages = () => true;
    if (kind === "prompt") await h.emit("ui_prompt_start");
    if (kind === "decision") await h.emit("tool_execution_start", { toolCallId: "q", toolName: "ask_user_question" });
    if (kind === "repeat") h.branch.push({ type: "custom", customType: "keepgoing.resume", data: {
      ...ownConsent, resumes: 1, lastResume: Date.parse("2026-09-12T11:59:00Z"),
    } });
    const command = h.commands.get("jb:keepgoing");
    await command.handler("on", h.ctx);
    assert.ok(h.messages.at(-1)!.includes(`No continuation was scheduled: ${reason}.`), kind);
    assert.match(h.messages.at(-1)!, /Next:/);
    if (kind === "prompt" || kind === "decision") {
      assert.match(h.messages.at(-1)!, /Next: Answer the human prompt, then explicitly schedule a new wait if needed\./);
      assert.doesNotMatch(h.messages.at(-1)!, /Resume will monitor for another usage limit/);
    }
    const notification = h.messages.at(-1);
    await command.handler("status", h.ctx);
    assert.equal(h.messages.at(-1), notification);
    assert.equal(lookups, 0);
    assert.equal(h.jobs.length, 0);
    assert.doesNotMatch(h.messages.at(-1)!, /reset is unavailable/);
  }
  let lookups = 0;
  const h = harness({ resolve: () => { lookups++; return null; } }, "tui");
  h.branch.push({ type: "message", message: failure });
  await h.commands.get("jb:keepgoing").handler("on", h.ctx);
  assert.match(h.messages.at(-1)!, /No continuation was scheduled: Claude's usage reset time is unavailable/);
  await h.commands.get("jb:keepgoing").handler("status", h.ctx);
  assert.equal(lookups, 1);
});

test("consumed failures and failed enqueue have specific historical outcomes", async () => {
  const h = harness({}, "tui");
  h.branch.push({ type: "message", message: failure });
  const command = h.commands.get("jb:keepgoing");
  await command.handler("on", h.ctx);
  await command.handler("status", h.ctx);
  assert.match(h.messages.at(-1)!, /Waiting for Claude's usage window to reset/);
  h.advance(390_000);
  await command.handler("on", h.ctx);
  assert.match(h.messages.at(-1)!, /latest usage-limit error was already handled/);
  assert.equal(h.sent.length, 1);
  const invalid = harness({ resolve: () => Date.parse("2026-09-12T20:00:00Z") }, "tui");
  invalid.branch.push({ type: "message", message: failure });
  await invalid.commands.get("jb:keepgoing").handler("on", invalid.ctx);
  assert.match(invalid.messages.at(-1)!, /deadline is outside the future six-hour window/);
  assert.equal(invalid.jobs.length, 0);
});

test("cancellation reasons are history, and navigation clears runtime diagnostics", async () => {
  for (const [event, payload, reason] of [
    ["ui_prompt_start", {}, "because a UI prompt opened"],
    ["tool_execution_start", { toolCallId: "q", toolName: "ask_user_choice" }, "because a human decision opened"],
    ["session_before_switch", {}, "by session navigation"],
    ["session_shutdown", { reason: "reload" }, "by session shutdown"],
  ] as const) {
    const h = harness({}, "tui");
    const command = h.commands.get("jb:keepgoing");
    await command.handler("wait 24m", h.ctx);
    await h.emit(event, payload);
    await command.handler("status", h.ctx);
    assert.ok(h.messages.at(-1)!.includes(`Previous wait cancelled ${reason}`), event);
    assert.doesNotMatch(h.messages.at(-1)!, /WAITING|NOT SCHEDULED/);
    await h.emit("session_tree");
    await command.handler("status", h.ctx);
    assert.doesNotMatch(h.messages.at(-1)!, /Previous wait/);
    h.advance(1_440_000);
    assert.equal(h.sent.length, 0);
  }
});

test("status never repairs a lost lease or initializes lifecycle state", async () => {
  const h = harness({}, "tui");
  const command = h.commands.get("jb:keepgoing");
  await command.handler("status", h.ctx);
  assert.equal(h.entries.length, 0);
  await command.handler("on", h.ctx);
  h.owners.clear();
  const entries = h.entries.length;
  await command.handler("status", h.ctx);
  assert.match(h.messages.at(-1)!, /Warning: Resume is not keeping your computer awake/);
  assert.doesNotMatch(h.messages.at(-1)!, /Your computer will stay awake/);
  assert.equal(h.entries.length, entries);
  assert.equal(h.owners.size, 0);
});

test("failed continuation submission is recorded without exposing raw errors or changing dispatch policy", async () => {
  const h = harness({}, "tui");
  h.pi.sendUserMessage = () => { throw Error("private prompt/error details"); };
  const command = h.commands.get("jb:keepgoing");
  await command.handler("wait 24m", h.ctx);
  assert.throws(() => h.advance(1_440_000), /private prompt\/error details/);
  await command.handler("status", h.ctx);
  assert.match(h.messages.at(-1)!, /No continuation was scheduled: Pi could not accept the continuation/);
  assert.doesNotMatch(h.messages.at(-1)!, /private|WAITING/);
  assert.equal(h.entries.at(-1).data.resumes, 1);
  assert.equal(h.sent.length, 0);
});

test("standalone waits acquire a lease, report status, and send Continue at the requested delay", async () => {
  for (const [duration, delay] of [["1h", 3_600_000], ["24m", 1_440_000]] as const) {
    const h = harness({}, "tui");
    const command = h.commands.get("jb:keepgoing");
    await command.handler(`wait ${duration}`, h.ctx);
    assert.equal(h.owners.has(oneLease), true);
    await command.handler("status", h.ctx);
    assert.match(h.messages.at(-1)!, /Waiting for your requested time.*Continue at:.*Time remaining:.*Keep this Pi session open/s);
    assert.ok(h.messages.at(-1)!.includes(`Time remaining: ${duration}`));
    h.advance(delay - 1);
    assert.equal(h.sent.length, 0);
    await command.handler("status", h.ctx);
    assert.match(h.messages.at(-1)!, /Time remaining: 1s/);
    h.advance(1);
    assert.deepEqual(h.sent, [{ message: "Continue", options: { expandPromptTemplates: false } }]);
  }
});

for (const stop of ["expiry", "now", "escape", "input", "ui_prompt_start", "tool_execution_start", "session_before_switch", "session_tree", "session_start", "session_shutdown", "send error", "lost lease"]) {
  test(`standalone replacement stays runtime-only through ${stop}`, async () => {
    let lookups = 0;
    const h = harness({ resolve: () => { lookups++; return null; } }, "tui");
    const cmd = (arg: string) => h.commands.get("jb:keepgoing").handler(arg, h.ctx);
    await cmd("inhibit on");
    await cmd("wait 2m");
    await cmd("wait 1m");
    assert.deepEqual(h.entries, [], "starting a timer is not persisted consent");
    assert.deepEqual([...h.owners], ["manual", oneLease]);
    await h.emit("agent_end", { messages: settled });
    await h.emit("agent_settled");
    await cmd("status");
    assert.match(h.messages.at(-1)!, /Resume is OFF\. Waiting for your requested time only/);
    assert.doesNotMatch(h.messages.at(-1)!, /attempt was not scheduled/);
    if (stop === "now") { await cmd("now"); h.advance(1); }
    else if (stop === "expiry") h.advance(60_000);
    else if (stop === "escape") [...h.terminalListeners][0]("\u001b");
    else if (stop === "send error") {
      h.pi.sendUserMessage = () => { throw Error("synthetic failure"); };
      assert.throws(() => h.advance(60_000), /synthetic failure/);
    } else if (stop === "lost lease") { h.owners.delete(oneLease); h.advance(60_000); }
    else await h.emit(stop, { source: "interactive", reason: "reload", toolCallId: "q", toolName: "ask_user_question" });
    const expected = ["now", "expiry"].includes(stop) ? [{ message: "Continue", options: { expandPromptTemplates: false } }] : [];
    assert.deepEqual(h.sent, expected);
    assert.deepEqual([...h.owners], ["manual"]);
    assert.deepEqual([h.terminalListeners.size, liveJobs(h).length], [0, 0]);
    await cmd("status");
    assert.match(h.messages.at(-1)!, /Resume is OFF\. Nothing is scheduled/);
    assert.doesNotMatch(h.messages.at(-1)!, /Resume will monitor/);
    h.advance(600_000);
    await h.emit("agent_end", { messages: settled });
    await h.emit("agent_settled");
    const reload = harness();
    replay(reload, h.entries);
    await reload.emit("session_start");
    await reload.emit("agent_end", { messages: settled });
    await reload.emit("agent_settled");
    reload.advance(600_000);
    assert.deepEqual([lookups, h.sent, reload.owners.size, reload.jobs.length, reload.sent.length], [0, expected, 0, 0, 0]);
  });
}

for (const when of ["before", "during"]) test(`explicit on ${when} wait preserves monitoring and its lease`, async () => {
  const h = harness();
  const cmd = (arg: string) => h.commands.get("jb:keepgoing").handler(arg, h.ctx);
  if (when === "before") await cmd("on");
  await cmd("wait 1m");
  if (when === "during") await cmd("on");
  await cmd("now");
  h.advance(1);
  h.advance(300_000);
  await h.emit("agent_end", { messages: [{ ...failure, errorMessage: "5-hour usage limit reached; resets at 2026-09-12T13:00:00Z" }] });
  await h.emit("agent_settled");
  h.advance(3_690_000);
  assert.deepEqual(h.sent, [{ message: "Continue", options: { expandPromptTemplates: false } }, resetContinuation]);
  assert.deepEqual([...h.owners], [oneLease]);
});

test("off cancels standalone wait while preserving manual lease and reports no timer", async () => {
  const h = harness({}, "tui");
  await h.commands.get("jb:keepgoing").handler("inhibit on", h.ctx);
  const command = h.commands.get("jb:keepgoing");
  await command.handler("wait 24m", h.ctx);
  await command.handler("off", h.ctx);
  await command.handler("status", h.ctx);
  assert.match(h.messages.at(-1)!, /Resume is OFF\. Nothing is scheduled/s);
  assert.deepEqual([...h.owners], ["manual"]);
  h.advance(1_440_000);
  assert.equal(h.sent.length, 0);
});

test("rejected standalone waits do not enable or retain a lease", async () => {
  for (const guard of ["busy", "queued", "decision", "prompt", "invalid", "helper"]) {
    const h = harness({}, "tui");
    if (guard === "busy") h.ctx.isIdle = () => false;
    if (guard === "queued") h.ctx.hasPendingMessages = () => true;
    if (guard === "decision") await h.emit("tool_execution_start", { toolCallId: "q", toolName: "ask_user_question" });
    if (guard === "prompt") await h.emit("ui_prompt_start");
    if (guard === "helper") {
      // Force acquisition failure using a controller rather than a live OS helper.
      const broken = harness({}, "tui", { active: false, has: () => false, acquire: () => { throw Error("unavailable"); }, release: () => false } as any);
      await broken.commands.get("jb:keepgoing").handler("wait 1h", broken.ctx);
      assert.equal(broken.jobs.length, 0);
      assert.equal(broken.entries.some(entry => entry.data.enabled), false);
      continue;
    }
    await h.commands.get("jb:keepgoing").handler(guard === "invalid" ? "wait 7h" : "wait 1h", h.ctx);
    assert.equal(h.owners.size, 0, guard);
    assert.equal(h.entries.some(entry => entry.data.enabled), false, guard);
    assert.equal(h.jobs.length, 0, guard);
  }
});

test("rejected replacement wait preserves existing timer and lease", async () => {
  const h = harness({}, "tui");
  const command = h.commands.get("jb:keepgoing");
  await command.handler("wait 24m", h.ctx);
  await command.handler("wait 7h", h.ctx);
  assert.equal(h.owners.has(oneLease), true);
  assert.equal(h.entries.length, 0);
  h.advance(1_440_000);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message, "Continue");
});

test("failed timer setup releases a standalone lease and removes the Escape listener", async () => {
  const h = harness({ schedule: () => { throw Error("timer unavailable"); } }, "tui");
  const cmd = (arg: string) => h.commands.get("jb:keepgoing").handler(arg, h.ctx);
  await cmd("inhibit on");
  await assert.rejects(cmd("wait 1h"), /timer unavailable/);
  await cmd("status");
  assert.match(h.messages.at(-1)!, /Resume is OFF\. Nothing is scheduled/);
  assert.deepEqual([...h.owners], ["manual"]);
  assert.deepEqual([h.terminalListeners.size, h.entries.length, h.sent.length], [0, 0, 0]);
});

test("enqueue rejection after lease acquisition rolls back temporary ownership", async () => {
  const owners = new Set<string>(["manual"]);
  let h: ReturnType<typeof harness>;
  const backend = {
    get active() { return owners.size > 0; },
    has: (owner: string) => owners.has(owner),
    acquire: (owner: string) => { owners.add(owner); h.ctx.isIdle = () => false; return true; },
    release: (owner: string) => owners.delete(owner),
  };
  h = harness({}, "tui", backend as any);
  await h.commands.get("jb:keepgoing").handler("wait 1h", h.ctx);
  assert.deepEqual([...owners], ["manual"]);
  assert.equal(h.jobs.length, 0);
  assert.equal(h.entries.length, 0);
  assert.match(h.messages.at(-1)!, /No safe wait scheduled/);
  assert.match(h.messages.at(-1)!, /No continuation was scheduled: the agent is busy/);
});

test("timed dispatch rechecks idle, queue, and session; 95% warning is not exhaustion", async () => {
  for (const guard of ["busy", "queued", "session"]) {
    const h = harness();
    await h.commands.get("jb:keepgoing").handler("wait 24m", h.ctx);
    if (guard === "queued") h.ctx.hasPendingMessages = () => true;
    if (guard === "busy") h.ctx.isIdle = () => false;
    if (guard === "session") h.setSession("two");
    h.advance(1_440_000);
    assert.equal(h.sent.length, 0);
    assert.equal(h.owners.size, 0, guard);
  }
  const h = harness();
  await h.commands.get("jb:keepgoing").handler("on", h.ctx);
  await h.emit("agent_end", { messages: [{ ...bridgeFailure, errorMessage: "Claude usage warning: 95% of session limit used" }] });
  await h.emit("agent_settled");
  assert.equal(h.jobs.length, 0);
});

for (const text of [reportedLimit, reportedQuota, "Error: " + reportedQuota]) {
  for (const activation of ["on after error", "already monitoring"]) {
    test(`reported five-hour format schedules and announces without status: ${activation}: ${text}`, async () => {
      const previous = process.env.TZ;
      process.env.TZ = "America/Argentina/Buenos_Aires";
      try {
        const h = harness({}, "tui");
        h.setNow("2026-10-21T23:00:00Z");
        h.ctx.modelRegistry.getApiKeyForProvider = async () => { throw Error("Bridge must not request OAuth"); };
        const command = h.commands.get("jb:keepgoing");
        const message = { ...bridgeFailure, errorMessage: text };
        if (activation === "on after error") {
          h.branch.push({ type: "message", message });
          await command.handler("on", h.ctx);
        } else {
          await command.handler("on", h.ctx);
          const count = h.messages.length;
          await h.emit("agent_end", { messages: [message] });
          assert.equal(h.messages.length, count, "wait until the agent settles");
          await h.emit("agent_settled");
          assert.equal(h.messages.length, count + 1, "announce automatically exactly once");
        }
        assert.equal(h.messages.at(-1), [
          "⏳ Resume is ON. Waiting for Claude's usage window to reset.",
          `Continue at: 20:51:30 · Oct 21, 2026 · ${Intl.DateTimeFormat().resolvedOptions().timeZone}\nTime remaining: 52m`,
          "Your computer will stay awake (the screen can still turn off). Keep this Pi session open: timers end when you exit or reload Pi.",
          "Cancel with /jb:keepgoing off or Escape.",
          versionLine,
        ].join("\n\n"));
        assert.equal(h.sent.length, 0);
        const jobs = h.jobs.filter(job => !job.cancelled).length;
        await command.handler("on", h.ctx);
        assert.equal(h.jobs.filter(job => !job.cancelled).length, jobs);
        h.advance(3_090_000 - 1);
        assert.equal(h.sent.length, 0);
        h.advance(1);
        assert.deepEqual(h.sent, [{ message: "Continue the interrupted request after the provider usage window reset. Do not make decisions for the user.", options: { expandPromptTemplates: false } }]);
        assert.equal(h.entries.at(-1).data.resumes, 1);
        h.advance(60_000);
        assert.equal(h.sent.length, 1);
      } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
      }
    });
  }
}

test("on without an error waits normally and later announces a scheduling failure", async () => {
  for (const latest of [undefined, { role: "assistant", stopReason: "stop" }]) {
    const h = harness({}, "tui");
    if (latest) h.branch.push({ type: "message", message: latest });
    const command = h.commands.get("jb:keepgoing");
    await command.handler("on", h.ctx);
    assert.match(h.messages.at(-1)!, /^✅ Resume is ON and watching for Claude's 5-hour usage limit\. Nothing is scheduled yet\.\n/);
    assert.match(h.messages.at(-1)!, /When Claude reports its 5-hour limit, Resume schedules the continuation/);
    assert.doesNotMatch(h.messages.at(-1)!, /No continuation was scheduled:/);
    assert.equal(h.jobs.length, 0);
    assert.equal(h.sent.length, 0);
    assert.equal(h.entries.at(-1).data.enabled, true);
    assert.ok(h.owners.has(oneLease));
    const count = h.messages.length;
    await h.emit("agent_end", { messages: [{ ...bridgeFailure, errorMessage: reportedLimit.replace("8:50pm", "invalid") }] });
    await h.emit("agent_settled");
    assert.equal(h.messages.length, count + 1);
    // A malformed reset no longer matches the exact Bridge format, so it is reported as unrecognized.
    assert.match(h.messages.at(-1)!, /No continuation was scheduled: unrecognized usage-limit error/);
    assert.match(h.messages.at(-1)!, /Next:.*wait/);
    assert.equal(h.jobs.length, 0);
    assert.equal(h.sent.length, 0);
    assert.equal(h.entries.at(-1).data.resumes, 0);
    assert.equal(h.entries.at(-1).data.enabled, true);
  }
});

for (const debug of [undefined, "0", "1"]) {
  test(`unknown usage-limit diagnostic with KEEPGOING_DEBUG=${debug ?? "unset"}`, async t => {
    const previous = process.env.KEEPGOING_DEBUG;
    t.after(() => {
      if (previous === undefined) delete process.env.KEEPGOING_DEBUG;
      else process.env.KEEPGOING_DEBUG = previous;
    });
    if (debug === undefined) delete process.env.KEEPGOING_DEBUG;
    else process.env.KEEPGOING_DEBUG = debug;
    const warnings: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
    const h = harness({ resolve: () => assert.fail("diagnostics must not look up resets") }, "tui");
    const command = h.commands.get("jb:keepgoing");
    const privateText = "Bearer synthetic-secret request_id=r123 /private/file https://example.invalid/?key=fake\r\n\x1b[31m\u2028" + "x".repeat(2048);
    const cases = [
      ["claude-bridge", `RATE-LIMIT (FIVE_HOUR) resets 8:50pm ${privateText}`, "rate-limit", "five-hour", "present"],
      ["anthropic", `usage limit unclear; session window ${privateText} resets`, "usage-limit", "session", "absent"],
      ["openai-codex", `${privateText} rate limit`, "unknown", "unknown", "absent"],
    ];
    const end = (message: typeof bridgeFailure) => h.emit("agent_end", { messages: [message] });
    await end({ ...bridgeFailure, errorMessage: "rate limit" }); // OFF
    await command.handler("on", h.ctx);
    const entries = structuredClone(h.entries);
    for (const errorMessage of [reportedLimit, "network timeout", "monthly usage limit reached", "invalid API key", "rate limit warning"]) {
      await end({ ...bridgeFailure, errorMessage });
    }
    await end({ ...bridgeFailure, provider: "other\nprovider", errorMessage: "rate limit" });
    assert.deepEqual(warnings, []);
    for (const [provider, errorMessage, family, window, reset] of cases) {
      const message = { ...bridgeFailure, provider, errorMessage };
      await end(message);
      await h.emit("agent_settled");
      h.branch.push({ type: "message", message });
      await command.handler("on", h.ctx); // same object: no second warning
      const summary = `keepgoing: provider=${provider} reason=unrecognized_usage_limit`;
      const line = debug === "1" ? `${summary} family=${family} window=${window} reset-marker=${reset}` : summary;
      assert.deepEqual(warnings.splice(0), [[line]]);
      assert.ok(line.length <= 160);
      assert.match(h.messages.at(-1)!, /unrecognized usage-limit error.*console/);
      assert.doesNotMatch(h.messages.join("\n"), /synthetic-secret|private\/file|example\.invalid/);
    }
    assert.equal(h.jobs.length, 0);
    assert.equal(h.sent.length, 0);
    assert.deepEqual(h.entries, entries);
  });
}

test("automatic recovery announces guard rejection without scheduling or changing counters", async () => {
  const h = harness({}, "tui");
  await h.commands.get("jb:keepgoing").handler("on", h.ctx);
  h.ctx.hasPendingMessages = () => true;
  const count = h.messages.length;
  await h.emit("agent_end", { messages: [failure] });
  await h.emit("agent_settled");
  assert.equal(h.messages.length, count + 1);
  assert.match(h.messages.at(-1)!, /No continuation was scheduled: messages are queued/);
  assert.equal(h.jobs.length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.entries.at(-1).data.resumes, 0);
});

for (const activation of ["on after error", "already monitoring"]) {
  test(`Claude quota exceeded schedules the printed reset minute with ${activation}`, async () => {
    const h = harness({}, "tui");
    const start = Date.parse("2026-09-29T15:00:00Z");
    const deadline = Date.parse("2026-09-29T16:31:30Z");
    h.setNow("2026-09-29T15:00:00Z");
    h.ctx.model.provider = "claude-bridge";
    h.ctx.modelRegistry.isUsingOAuth = () => { throw Error("OAuth inspected"); };
    h.ctx.modelRegistry.getApiKeyForProvider = async () => { throw Error("token requested"); };
    const message = { ...bridgeFailure, errorMessage: "Claude quota exceeded — rate limit (five_hour) — resets at 1:30:00 PM: You've hit your session limit · resets 1:30pm (America/Argentina/Buenos_Aires)" };
    const command = h.commands.get("jb:keepgoing");
    if (activation === "on after error") {
      h.branch.push({ type: "message", message });
      await command.handler("on", h.ctx);
    } else {
      await command.handler("on", h.ctx);
      await h.emit("agent_end", { messages: [message] });
      await h.emit("agent_settled");
    }
    await command.handler("status", h.ctx);
    assert.match(h.messages.at(-1)!, /Resume is ON\. Waiting for Claude's usage window to reset/);
    assert.match(h.messages.at(-1)!, /Time remaining: 1h 32m/);
    assert.equal(h.sent.length, 0);
    assert.equal(h.jobs.filter(job => !job.cancelled).length, 2);
    await command.handler("on", h.ctx);
    h.advance(deadline - start - 1);
    assert.equal(h.sent.length, 0);
    h.advance(1);
    assert.deepEqual(h.sent, [{ message: "Continue the interrupted request after the provider usage window reset. Do not make decisions for the user.", options: { expandPromptTemplates: false } }]);
    h.advance(60_000);
    assert.equal(h.sent.length, 1);
    assert.equal(h.entries.at(-1).data.resumes, 1);
  });
}

test("one activation recovers consecutive Claude windows and keeps monitoring after each dispatch", async () => {
  const h = harness({}, "tui");
  h.setNow("2026-10-21T15:00:00Z");
  const command = h.commands.get("jb:keepgoing");
  await command.handler("on", h.ctx);
  for (const [index, start, reset, deadline] of [
    [1, "2026-10-21T15:00:00Z", "1:30pm", "2026-10-21T16:31:30Z"],
    [2, "2026-10-21T20:00:00Z", "6:30pm", "2026-10-21T21:31:30Z"],
  ] as const) {
    h.setNow(start);
    await h.emit("agent_start");
    await h.emit("input", { source: "extension" });
    const message = { ...bridgeFailure, errorMessage: `Claude quota exceeded — rate limit (five_hour): You've hit your session limit · resets ${reset} (America/Argentina/Buenos_Aires)` };
    await h.emit("agent_end", { messages: [message] });
    await h.emit("agent_settled");
    await command.handler("status", h.ctx);
    assert.match(h.messages.at(-1)!, /Resume is ON\. Waiting for Claude's usage window to reset/);
    h.advance(Date.parse(deadline) - Date.parse(start) - 1);
    assert.equal(h.sent.length, index - 1);
    h.advance(1);
    assert.equal(h.sent.length, index);
    assert.deepEqual(h.sent.at(-1), { message: "Continue the interrupted request after the provider usage window reset. Do not make decisions for the user.", options: { expandPromptTemplates: false } });
    await h.emit("agent_start");
    await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
    await h.emit("agent_settled");
    await command.handler("status", h.ctx);
    assert.match(h.messages.at(-1)!, /Resume is ON and watching for Claude's 5-hour usage limit\. Nothing is scheduled yet/);
    assert.equal(h.entries.at(-1).data.enabled, true);
    assert.equal(h.entries.at(-1).data.resumes, index);
    assert.equal(h.entries.at(-1).data.lastContinuationAt, Date.parse(deadline));
    assert.ok(h.owners.has(oneLease));
    h.advance(60_000);
    assert.equal(h.sent.length, index, "monitoring alone must not send another continuation");
  }
});

test("late bridge activation schedules overnight local reset without OAuth, immediate turn, or duplicate", async () => {
  const h = harness({}, "tui");
  h.setNow("2026-09-29T02:19:00Z");
  h.ctx.model.provider = "claude-bridge";
  h.ctx.modelRegistry.isUsingOAuth = () => { throw Error("OAuth inspected"); };
  h.ctx.modelRegistry.getApiKeyForProvider = async () => { throw Error("token requested"); };
  h.branch.push({ type: "message", message: bridgeFailure });
  const command = h.commands.get("jb:keepgoing");
  await command.handler("on", h.ctx);
  const deadline = Date.parse("2026-09-29T04:51:30Z");
  assert.match(h.messages.at(-1)!, /Continue at: .*Sep 29, 2026/);
  assert.equal(h.sent.length, 0);
  assert.equal(h.jobs[0].deadline, Date.parse("2026-09-29T02:20:00Z"));
  await command.handler("on", h.ctx);
  h.advance(deadline - Date.parse("2026-09-29T02:19:00Z") - 1);
  assert.equal(h.sent.length, 0);
  h.advance(1);
  assert.equal(h.sent.length, 1);
  h.advance(60_000);
  assert.equal(h.sent.length, 1);
});

test("newly settled bridge failure schedules one buffered turn and headless invalid reset does not wait", async () => {
  const h = harness();
  h.setNow("2026-09-29T02:19:00Z");
  await h.commands.get("jb:keepgoing").handler("on", h.ctx);
  await h.emit("agent_end", { messages: [bridgeFailure] });
  await h.emit("agent_settled");
  assert.equal(h.sent.length, 0);
  h.advance(Date.parse("2026-09-29T04:51:30Z") - Date.parse("2026-09-29T02:19:00Z"));
  assert.equal(h.sent.length, 1);
  for (const mode of ["print", "json"]) {
    const run = harness({}, mode);
    run.setNow("2026-09-29T02:19:00Z");
    await run.commands.get("jb:keepgoing").handler("on", run.ctx);
    await run.emit("agent_end", { messages: [{ ...bridgeFailure, errorMessage: "Claude rate limit (five_hour): You've hit your session limit · resets 1:50am (Invalid/Zone)" }] });
    await run.emit("agent_settled");
    assert.equal(run.jobs.length, 0, mode);
    assert.equal(run.sent.length, 0, mode);
  }
});

test("settled bridge recovery respects manual wait and rejects stale or invalid limits without fallback", async () => {
  const h = harness();
  h.setNow("2026-09-29T02:19:00Z");
  await h.commands.get("jb:keepgoing").handler("on", h.ctx);
  await h.commands.get("jb:keepgoing").handler("wait 3h", h.ctx);
  await h.emit("agent_end", { messages: [bridgeFailure] });
  await h.emit("agent_settled");
  assert.equal(h.jobs.filter(job => !job.cancelled).length, 1);
  h.advance(3 * 60 * 60_000);
  assert.equal(h.sent.length, 1);
  for (const message of [{ ...bridgeFailure, errorMessage: "Claude rate limit (five_hour): You've hit your session limit · resets 1:50am (Invalid/Zone)" },
    { ...bridgeFailure, errorMessage: "Claude rate limit (five_hour): You've hit your session limit · resets 6:50am (America/Argentina/Buenos_Aires)" },
    { ...bridgeFailure, errorMessage: "Claude rate limit (weekly): You've hit your session limit · resets 1:50am (America/Argentina/Buenos_Aires)" }]) {
    const run = harness();
    run.setNow("2026-09-29T02:19:00Z");
    run.branch.push({ type: "message", message });
    await run.commands.get("jb:keepgoing").handler("on", run.ctx);
    assert.equal(run.jobs.length, 0);
    await run.emit("agent_end", { messages: [message] });
    await run.emit("agent_settled");
    assert.equal(run.jobs.length, 0);
    assert.equal(run.entries.at(-1).data.fallback, 0);
  }
  for (const later of [{ role: "user", content: "later" }, { role: "assistant", stopReason: "stop" }]) {
    const run = harness();
    run.setNow("2026-09-29T02:19:00Z");
    run.branch.push({ type: "message", message: bridgeFailure }, { type: "message", message: later });
    await run.commands.get("jb:keepgoing").handler("on", run.ctx);
    assert.equal(run.jobs.length, 0);
  }
});

test("activation schedules latest settled branch failure once and reports local retry time without an immediate turn", async () => {
  const h = harness({}, "tui");
  h.branch.push({ type: "message", message: failure });
  await h.commands.get("jb:keepgoing").handler("on", h.ctx);
  assert.equal(h.jobs.filter(job => !job.cancelled).length, 2);
  assert.equal(h.sent.length, 0);
  assert.match(h.messages.at(-1)!, /Continue at: .*:06:30/);
  await h.commands.get("jb:keepgoing").handler("on", h.ctx);
  assert.equal(h.jobs.filter(job => !job.cancelled).length, 2);
  await h.commands.get("jb:keepgoing").handler("status", h.ctx);
  assert.match(h.messages.at(-1)!, /Continue at: \d{2}:\d{2}:\d{2}/);
  h.advance(390_000);
  assert.equal(h.sent.length, 1);
  await h.commands.get("jb:keepgoing").handler("on", h.ctx);
  assert.match(h.messages.at(-1)!, /^⚠️ Resume is ON, but nothing was scheduled\.\n/);
  h.advance(390_000);
  assert.equal(h.sent.length, 1);
});

test("activation ignores stale, unsupported, permanent, and decision-blocked errors", async () => {
  for (const later of [{ type: "message", message: { role: "user", content: "later" } }, { type: "message", message: { role: "assistant", stopReason: "stop" } }]) {
    const h = harness({}, "tui");
    h.branch.push({ type: "message", message: failure }, later);
    await h.commands.get("jb:keepgoing").handler("on", h.ctx);
    assert.equal(h.jobs.length, 0);
    assert.match(h.messages.at(-1)!, /^✅ Resume is ON and watching for Claude's 5-hour usage limit\. Nothing is scheduled yet\.\n/);
  }
  for (const message of [{ ...failure, provider: "other" }, { ...failure, errorMessage: "monthly usage limit reached" }]) {
    const h = harness({}, "tui");
    h.branch.push({ type: "message", message });
    await h.commands.get("jb:keepgoing").handler("on", h.ctx);
    assert.equal(h.jobs.length, 0);
  }
  const h = harness({}, "tui");
  h.branch.push({ type: "message", message: failure });
  await h.emit("tool_execution_start", { toolCallId: "choice", toolName: "ask_user_choice" });
  await h.commands.get("jb:keepgoing").handler("on", h.ctx);
  assert.equal(h.jobs.length, 0);
  await h.commands.get("jb:keepgoing").handler("status", h.ctx);
  assert.match(h.messages.at(-1)!, /^⚠️ Resume is ON, but nothing was scheduled\.\n/);
});

test("retroactive print/json activation returns promptly without a disposable recovery timer", async () => {
  for (const mode of ["print", "json"]) {
    const h = harness({}, mode);
    h.branch.push({ type: "message", message: failure });
    let returned = false;
    const activation = h.commands.get("jb:keepgoing").handler("on", h.ctx).then(() => { returned = true; });
    for (let n = 0; n < 5; n++) await Promise.resolve();
    assert.equal(returned, true, mode);
    await activation;
    assert.equal(h.jobs.length, 0, mode);
    assert.equal(h.sent.length, 0, mode);
  }
});

test("concurrent retroactive lookups with unavailable reset never schedule", async () => {
  const finish: Array<(value: null) => void> = [];
  const h = harness({ resolve: () => new Promise<null>(resolve => finish.push(resolve)) }, "tui");
  h.branch.push({ type: "message", message: { ...failure, errorMessage: "5-hour usage limit reached" } });
  const command = h.commands.get("jb:keepgoing");
  const first = command.handler("on", h.ctx);
  const second = command.handler("on", h.ctx);
  assert.equal(finish.length, 2);
  finish[0](null);
  finish[1](null);
  await Promise.all([first, second]);
  assert.equal(h.entries.at(-1).data.fallback, 0);
  assert.equal(h.jobs.filter(job => !job.cancelled).length, 0);
  assert.equal(h.sent.length, 0);
  await command.handler("status", h.ctx);
  assert.match(h.messages.at(-1)!, /^⚠️ Resume is ON, but nothing was scheduled\.\n/);
  h.advance(600_000);
  assert.equal(h.sent.length, 0);
});

