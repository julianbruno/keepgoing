import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { classifyLimit, resetFromText, fallbackDeadline, resolveReset, parseWait, isUnrecognizedUsageLimit, bridgeResetFromText } from "../src/recovery.ts";

test("only positive subscription-window errors from supported providers qualify", () => {
  for (const provider of ["openai-codex", "anthropic"]) {
    assert.equal(classifyLimit(provider, "You've hit your usage limit. Try again after 2026-09-12T14:00:00Z"), true);
    assert.equal(classifyLimit(provider, "5-hour usage limit reached; resets at 2026-09-12T14:00:00Z"), true);
    for (const text of ["invalid API key", "insufficient credits", "context window exceeded", "model unavailable", "network timeout", "tool error", "internal server error", "rate limit exceeded", "subscription required", "Monthly usage limit reached", "Weekly subscription quota exhausted", "Your API usage limit is reached", "usage limit reached"]) {
      assert.equal(classifyLimit(provider, text), false, text);
    }
  }
  assert.equal(classifyLimit("other", "5-hour usage limit reached"), false);
});

for (const provider of ["openai-codex", "anthropic"]) {
  for (const [text, expected] of [
    ["Daily usage limit reached. Try again tomorrow.", false],
    ["24-hour subscription quota exhausted. Try again later.", false],
    ["12-hour usage limit reached. Try again later.", false],
    ["You've hit your usage limit for the day. Try again later.", false],
    ["You've hit your usage limit for the week. Try again next week.", false],
    ["5-hour usage limit reached. Your summary for the week is available.", true],
    ["5-hour usage limit reached; 1 request remains", false],
    ["1 request remains; 5-hour usage limit reached", false],
    ["Your 5-hour usage limit is reached when you use all 50 requests", false],
    ["Your 5-hour usage limit is reached when you use all allotted requests", false],
    ["Your 5-hour usage limit is reached when you use all allotted requests. 5-hour usage limit reached.", false],
    ["5-hour usage limit reached. Your 5-hour usage limit is reached when you use all allotted requests.", false],
    ["5-hour usage limit reached. Your daily summary is available.", true],
    ["You can continue until your 5-hour usage limit is reached", false],
    ["5-hour usage limit reached, 0% remaining", false],
    ["5-hour usage limit reached, more than 0 requests remaining", false],
    ["Your 5-hour usage quota is depleted by half", false],
    ["5-hour usage limit reached. 25% remaining", false],
    ["5-hour usage limit reached, 25,0% remaining", false],
    ["5-hour usage limit reached - 0 requests remaining", false],
    ["5-hour usage limit: 0% remaining", false],
    ["2026-09-12T14:00:00Z", false],
    ["5-hour usage limit reached, 0 requests remaining", false],
    ["5-hour usage limit reached — 0 requests remaining", false],
    ["5-hour usage limit reached; 0 requests left", false],
    ["5-hour usage limit reached, 2 requests remaining", false],
    ["Your 5-hour usage quota is depleted. Try again later.", true],
    ["You've reached your 5-hour usage limit warning threshold. Try again later.", false],
  ] as const) test(`${provider}: ${text}`, () => assert.equal(classifyLimit(provider, text), expected));

  test(`${provider} requires exhausted capacity, not a warning or a reset alone`, () => {
    for (const text of [
      "Warning: 95% of your 5-hour usage limit used; resets at 2026-09-12T14:00:00Z",
      "You've reached 80% of your usage limit. Try again after 2026-09-12T13:00:00Z",
      "5-hour usage limit: 2 requests remaining; resets at 2026-09-12T14:00:00Z",
      "Your 5-hour usage limit has not been reached",
      "You've reached your warning threshold for the usage limit. Try again later.",
      "5-hour usage reached 49 of 50 requests in your usage window",
      "You'll be notified when your 5-hour usage limit is reached",
      "Your 5-hour usage limit is reached at 100 requests; 2 requests remain",
    ]) assert.equal(classifyLimit(provider, text), false, text);
    // Exact format: any warning wording fails closed, even an unrelated one.
    assert.equal(classifyLimit(provider, "Warning: output truncated. You've hit your ChatGPT usage limit. Try again later."), false);
    assert.equal(classifyLimit(provider, "5-hour usage limit reached (warning: output truncated)"), false);
    assert.equal(classifyLimit(provider, "Your 5-hour subscription quota has been exhausted"), true);
    assert.equal(classifyLimit(provider, "5-hour usage exhausted"), true);
  });
}

test("bridge requires five_hour and explicit session or extra usage exhaustion", () => {
  const actual = "Claude rate limit (five_hour) — resets 1:50:00 AM: You've hit your session limit · resets 1:50am (America/Argentina/Buenos_Aires)";
  assert.equal(classifyLimit("claude-bridge", actual), true);
  const quota = "Claude quota exceeded — rate limit (five_hour) — resets at 1:30:00 PM: You've hit your session limit · resets 1:30pm (America/Argentina/Buenos_Aires)";
  assert.equal(classifyLimit("claude-bridge", quota), true);
  for (const text of [
    quota.replace("five_hour", "weekly"),
    quota.replace("You've hit your session limit", "95% of session limit used"),
    quota.replace("You've hit your session limit", "billing error; You've hit your session limit"),
  ]) assert.equal(classifyLimit("claude-bridge", text), false, text);
  assert.equal(classifyLimit("claude-bridge", "Claude rate limit (five_hour): extra usage exhausted · resets 1:50am (America/Argentina/Buenos_Aires)"), true);
  assert.equal(classifyLimit("claude-bridge", "Claude rate limit (five_hour): You're out of extra usage · resets 1:50am (America/Argentina/Buenos_Aires)"), true);
  for (const text of ["rate limit 429", "Claude rate limit (five_hour) · resets 1:50am (America/Argentina/Buenos_Aires)",
    "Claude rate limit (five_hour): session limit · resets 1:50am (America/Argentina/Buenos_Aires)",
    "Claude rate limit (five_hour): extra usage limit · resets 1:50am (America/Argentina/Buenos_Aires)",
    "You've hit your session limit · resets 1:50am (America/Argentina/Buenos_Aires)",
    "Claude rate limit (weekly): You've hit your session limit · resets 1:50am (America/Argentina/Buenos_Aires)",
    "Claude rate limit (five_hour): billing error; You've hit your session limit · resets 1:50am (America/Argentina/Buenos_Aires)"]) {
    assert.equal(classifyLimit("claude-bridge", text), false, text);
  }
  assert.equal(classifyLimit("other", actual), false);
});

test("bridge recognizes every reported five-hour exhaustion format, not warnings or other errors", () => {
  const raw = "You've hit your 5-hour limit · resets 8:50pm (America/Argentina/Buenos_Aires)";
  const quota = "Claude quota exceeded — rate limit (five_hour) — resets 8:50:00 PM: " + raw;
  for (const text of [raw, quota, "Error: " + quota]) {
    assert.equal(classifyLimit("claude-bridge", text), true, text);
    assert.equal(classifyLimit("other", text), false, text);
    for (const invalid of [
      text.replace("You've hit your 5-hour limit", "95% of 5-hour limit used"),
      text.replace("You've hit your 5-hour limit", "You've hit your weekly limit"),
      text + "; billing error",
      text + "; invalid API key",
    ]) assert.equal(classifyLimit("claude-bridge", invalid), false, invalid);
  }
});

for (const prefix of ["", "Claude rate limit (five_hour): "]) {
  const claim = prefix + "You've hit your 5-hour limit";
  test(`${claim}: a warning threshold is not exhaustion`, () => {
    assert.equal(classifyLimit("claude-bridge", claim + " warning threshold"), false);
  });
  test(`${claim}: any text beyond the known format fails closed`, () => {
    assert.equal(classifyLimit("claude-bridge", claim), true);
    assert.equal(classifyLimit("claude-bridge", claim + "; warning threshold notifications are enabled"), false);
  });
}

for (const advice of [
  "You'll be notified when you've hit your session limit",
  "We'll notify you when you've hit your session limit",
  "Check whether you're out of extra usage",
]) test(`bridge advice is not an assertion: ${advice}`, () => {
  const report = `Claude rate limit (five_hour): ${advice}`;
  assert.equal(classifyLimit("claude-bridge", report), false);
  assert.equal(classifyLimit("claude-bridge", `${report}; You've hit your session limit`), false);
});

test("a Bridge question needs a separate affirmative report", () => {
  const question = "Claude rate limit (five_hour): You've hit your session limit?";
  assert.equal(classifyLimit("claude-bridge", question), false);
  assert.equal(classifyLimit("claude-bridge", `${question} Session limit reached.`), false);
});

test("a Bridge exhaustion report that also reports remaining capacity never qualifies", () => {
  const limit = "You've hit your 5-hour limit";
  const reset = " · resets 4pm (Europe/Madrid)";
  for (const capacity of ["; 2 requests remaining", "; 1 request remains", " — 10% left", "; 3 credits remaining"]) {
    assert.equal(classifyLimit("claude-bridge", limit + capacity + reset), false, capacity);
    assert.equal(classifyLimit("claude-bridge", `Claude rate limit (five_hour): ${limit}${capacity}`), false, capacity);
  }
  assert.equal(classifyLimit("claude-bridge", limit + reset), true);
  assert.equal(classifyLimit("claude-bridge", limit + "; 0 requests remaining" + reset), false);
});

test("remaining capacity in other wording also contradicts exhaustion", () => {
  const contradictions = ["2 requests are remaining", "2 messages remaining", "remaining requests: 2", "2 requests still remaining",
    "2 requests available", "5 prompts left", "remaining messages: 3", "1 more request available", "remaining: 40%",
    "2 remaining requests", "40 percent remaining", "40% of usage remaining", "2 requests are left", "2 request(s) remaining",
    "left: 2 requests", "remains: 2 requests", "0 requests remaining, 3 requests remaining"];
  const zeros = ["0 messages remaining", "no requests are remaining", "remaining requests: 0", "0 requests available",
    "0% remaining", "zero requests left", "remaining: 0%"];
  const bridge = (tail: string) => [`You've hit your 5-hour limit; ${tail} · resets 4pm (Europe/Madrid)`,
    `Claude rate limit (five_hour): You've hit your 5-hour limit; ${tail}`];
  for (const tail of contradictions) {
    for (const text of bridge(tail)) assert.equal(classifyLimit("claude-bridge", text), false, text);
    for (const provider of ["openai-codex", "anthropic"]) {
      assert.equal(classifyLimit(provider, `5-hour usage limit reached; ${tail}. Try again later.`), false, `${provider}: ${tail}`);
    }
  }
  // Exact format only: even an exact-zero report is extra text and schedules nothing.
  for (const tail of zeros) {
    for (const text of bridge(tail)) assert.equal(classifyLimit("claude-bridge", text), false, text);
    for (const provider of ["openai-codex", "anthropic"]) {
      assert.equal(classifyLimit(provider, `5-hour usage limit reached; ${tail}. Try again later.`), false, `${provider}: ${tail}`);
    }
  }
  assert.equal(classifyLimit("claude-bridge", "You've hit your 5-hour limit · resets 4pm (Europe/Madrid)"), true);
  assert.equal(classifyLimit("anthropic", "5-hour usage limit reached. Usage will be available again at 4pm."), true);
  // A zero for one unit must not hide a non-zero count for another.
  for (const tail of ["remaining requests: 0, messages: 3", "0 requests remaining, 3 messages", "remaining: 0%, 3 prompts"]) {
    for (const text of bridge(tail)) assert.equal(classifyLimit("claude-bridge", text), false, text);
    assert.equal(classifyLimit("anthropic", `5-hour usage limit reached; ${tail}. Try again later.`), false, tail);
  }
  // Fail closed: incidental capacity words also schedule nothing rather than risk a wrong Continue.
  for (const text of ["5-hour usage limit reached. Try again later, 3 hours left.", "5-hour usage limit reached (100%)."]) {
    assert.equal(classifyLimit("anthropic", text), false, text);
  }
  const question = "Claude rate limit (five_hour): You've hit your session limit？";
  assert.equal(classifyLimit("claude-bridge", question), false);
  assert.equal(classifyLimit("claude-bridge", `${question} Session limit reached.`), false);
});

test("independent verifier counterexamples never qualify as exhaustion", () => {
  const tails = ["remaining requests: 0, messages: 3", "remaining: 0 requests, 3 messages", "remaining: 0, 3 messages",
    "remaining:0,3 messages", "left: 0 requests, 2 prompts", "available: 0 requests, 4 messages",
    "remaining: 0 requests / 3 messages", "remaining: 0 | messages: 3", "remaining: none (3 messages)",
    "remaining: zero requests and 3 messages", "0 requests remaining (3 messages)", "no requests left — 3 messages",
    "remainder: 2 requests", "leftover: 2 requests", "2 requests unused", "2 requests to go", "2 requests spare",
    "balance: 3 messages", "you can still send 3 messages", "you have 2 more requests", "48 of 50 requests used",
    "used 48/50 requests", "2 requests ｒｅｍａｉｎｉｎｇ", "2 requests rem.", "2 requests avail.", "no requests left — two messages"];
  for (const tail of tails) {
    for (const text of [`You've hit your 5-hour limit; ${tail} · resets 4pm (Europe/Madrid)`,
      `Claude rate limit (five_hour): You've hit your 5-hour limit; ${tail}`,
      `Error: Claude quota exceeded — rate limit (five_hour) — resets 4:00:00 PM: You've hit your 5-hour limit; ${tail}`]) {
      assert.equal(classifyLimit("claude-bridge", text), false, text);
    }
    for (const provider of ["openai-codex", "anthropic"]) {
      assert.equal(classifyLimit(provider, `5-hour usage limit reached; ${tail}. Try again later.`), false, `${provider}: ${tail}`);
    }
  }
  for (const provider of ["openai-codex", "anthropic"]) for (const text of [
    "5-hour usage limit reached? Try again later.", "5-hour usage limit reached？ Try again later.",
    "Have you reached your 5-hour usage limit? Try again later.", "Is your 5-hour usage limit reached? Try again later.",
    "You've hit your 5-hour usage limit, haven't you? Try again later.", "You've reached your 5-hour usage limit?",
  ]) assert.equal(classifyLimit(provider, text), false, `${provider}: ${text}`);
  for (const mark of ["؟", "‽", "﹖"]) {
    assert.equal(classifyLimit("claude-bridge", `Claude rate limit (five_hour): You've hit your session limit${mark}`), false, mark);
    for (const provider of ["openai-codex", "anthropic"]) {
      assert.equal(classifyLimit(provider, `5-hour usage limit reached${mark} Try again later.`), false, `${provider}: ${mark}`);
    }
  }
  // Fail closed by design: any count of a unit, even the cap size, vetoes automatic continuation.
  assert.equal(classifyLimit("anthropic", "5-hour usage limit of 50 messages reached. Try again later."), false);
  // Positive controls: real reports and prose that mentions no remaining capacity.
  assert.equal(classifyLimit("anthropic", "5-hour usage limit reached. Requests available again at 4pm."), true);
  assert.equal(classifyLimit("openai-codex", "You've hit your usage limit. Try again in 5 hours."), true);
  assert.equal(classifyLimit("claude-bridge", "Error: Claude quota exceeded — rate limit (five_hour) — resets 4:00:00 PM: You've hit your 5-hour limit · resets 4pm (Europe/Madrid)"), true);
  assert.equal(classifyLimit("claude-bridge", "Claude rate limit (five_hour): You've hit your 5-hour limit; 0 requests remaining · resets 4pm (Etc/GMT+3)"), false);
});

test("after the known time and window numbers are removed, any other count vetoes exhaustion", () => {
  const tails = ["remaining: 0 requests, 2,000 tokens", "remaining: 0 requests, 10 000 tokens", "remaining: 0 requests, 2k tokens",
    "remaining requests: 0, messages = 3", "remaining requests: 0, messages 3", "remaining requests: 0, messages (3)",
    "remaining requests: 0, messages → 3", "remaining: 0 requests, 3 Opus messages", "remaining: 0 requests, six messages",
    "remaining: 0 requests, ten messages", "remaining: 0 requests, a couple of messages", "remaining: 0 requests, many messages",
    "remaining: 0 requests, 3 queries", "remaining: 0 requests, 3 calls", "remaining: 0 requests, 3 conversations",
    "remaining: 0 requests, 3 uses", "remaining: 0 requests, 3 chats", "remaining: 0 requests, 3 responses",
    "remaining: 0 requests, 3 completions", "remaining: 0 requests, 3 msgs", "remaining: 0 requests, 3 reqs",
    "remaining: 0 requests, 3 more", "remaining: 0 requests, Sonnet: 3", "remaining: 0 requests, quota 3",
    "requests used: 0 of 50", "Sonnet: 3", "3 more", "３ messages left"];
  for (const tail of tails) {
    for (const text of [`You've hit your 5-hour limit; ${tail} · resets 4pm (Europe/Madrid)`,
      `Claude rate limit (five_hour): You've hit your 5-hour limit; ${tail}`,
      `Error: Claude quota exceeded — rate limit (five_hour) — resets 4:00:00 PM: You've hit your 5-hour limit; ${tail}`]) {
      assert.equal(classifyLimit("claude-bridge", text), false, text);
    }
    for (const provider of ["openai-codex", "anthropic"]) {
      assert.equal(classifyLimit(provider, `5-hour usage limit reached; ${tail}. Try again later.`), false, `${provider}: ${tail}`);
    }
  }
  for (const provider of ["openai-codex", "anthropic"]) for (const text of [
    "Have you reached your 5-hour usage limit.", "¿5-hour usage limit reached.", "Is your 5-hour usage limit reached. Try again later.",
  ]) assert.equal(classifyLimit(provider, text), false, `${provider}: ${text}`);
  // Numbers that belong to the window, a reset time, a duration or a timestamp are not capacity.
  for (const provider of ["openai-codex", "anthropic"]) for (const text of [
    "You've hit your usage limit. Try again in 4 hours 12 minutes.", "5-hour usage limit reached. Try again at 4:00 PM.",
    "5-hour usage limit reached. Try again at 16:30.",
    "5-hour usage limit reached. Resets at 2026-09-12T13:00:00Z.", "5-hour usage limit reached. Try again in a few hours.",
  ]) assert.equal(classifyLimit(provider, text), true, `${provider}: ${text}`);
  assert.equal(classifyLimit("claude-bridge", "Claude rate limit (five_hour) — resets 1:50:00 AM: You've hit your session limit · resets 1:50am (Etc/GMT+3)"), true);
});

test("times are only ignored after a reset or retry phrase, and count words are capacity", () => {
  const tails = ["remaining: 0 requests, 3M tokens", "remaining: 0 requests, 1.5M tokens", "remaining requests: 0, tokens: 2M",
    "remaining: 0 requests, 2m tokens", "remaining requests: 0, Opus 3h", "remaining requests: 0 (Opus 3/10)",
    "0 requests remaining (Opus: 3/50)", "remaining requests: 0 (messages 3/50)", "remaining: 0 requests, one Opus message",
    "remaining: 0 requests, some Opus messages", "remaining: 0 requests, a few Opus messages", "remaining: 0 requests, several Opus messages",
    "remaining: 0 requests, five Opus messages", "remaining: 0 requests, twenty messages", "remaining: 0 requests, fifty messages",
    "remaining: 0 requests, lots of messages", "remaining: 0 requests, plenty of messages", "remaining requests: 0; messages: unlimited",
    "remaining: 0 requests; unlimited messages", "remaining requests: 0, messages = five", "remaining: 0 requests; you can still send one Opus message",
    "remaining: 0 requests, 2 hours of usage", "remaining: 0 requests, 30 minutes of usage"];
  for (const tail of tails) {
    for (const text of [`You've hit your 5-hour limit; ${tail} · resets 4pm (Europe/Madrid)`,
      `Claude rate limit (five_hour): You've hit your 5-hour limit; ${tail}`,
      `Error: Claude quota exceeded — rate limit (five_hour) — resets 4:00:00 PM: You've hit your 5-hour limit; ${tail}`]) {
      assert.equal(classifyLimit("claude-bridge", text), false, text);
    }
    for (const provider of ["openai-codex", "anthropic"]) {
      assert.equal(classifyLimit(provider, `5-hour usage limit reached; ${tail}. Try again later.`), false, `${provider}: ${tail}`);
    }
  }
  for (const provider of ["openai-codex", "anthropic"]) for (const text of [
    "5-hour usage limit reached. Try again in 2 hours 15 minutes.", "5-hour usage limit reached. Try again in 4h 30m.",
    "5-hour usage limit reached. Try again at 16:00 UTC.", "5-hour usage limit reached. Try again at 4:00 p.m.",
    "5-hour usage limit reached. Try again in an hour.", "5-hour usage limit reached. Try again in 90 minutes.",
    "5-hour usage limit reached. Try again in 3 hrs.", "5-hour usage limit reached. Resets at 12am (UTC+2).",
    "5-hour usage limit reached. Resets at 1760000000.", "5-hour usage limit reached. Try again in several hours.",
    "5-hour usage limit reached. Try again in one hour.", "5-hour usage limit reached. Try again in five minutes.",
    "5-hour usage limit reached. Try again in a few minutes.", "5-hour usage limit reached. Please wait some time and try again later.",
  ]) assert.equal(classifyLimit(provider, text), true, `${provider}: ${text}`);
  // A count chained after a reset time is not swallowed as a duration.
  assert.equal(classifyLimit("anthropic", "5-hour usage limit reached. Resets in 2h, 3M tokens."), false);
});

test("warnings, conditions and unreadable reset shapes fail closed", () => {
  // Portable syntax: the module must not rely on RegExp modifiers, which need Node 23 or later.
  const source = readFileSync(new URL("../src/recovery.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\(\?[-a-z]+:/);
  for (const provider of ["openai-codex", "anthropic"]) for (const text of [
    "You have hit the usage limit warning. Try again later.", "You've reached your 5-hour usage limit warning level. Try again later.",
    "You've hit your 5-hour usage limit alert. Try again later.", "Warning: 5-hour usage limit reached soon. Try again later.",
    "You've almost reached your 5-hour usage limit. Try again later.", "After you hit your 5-hour usage limit, try again later.",
    "Whenever you hit your 5-hour usage limit, try again later.", "5-hour usage limit reached; you can still send fifteen more. Try again later.",
    "5-hour usage limit reached; you can still send more. Try again later.", "Heads-up: 5-hour usage limit reached shortly.",
    "Upcoming: 5-hour usage limit reached.", "Warnings: you've hit your 5-hour usage limit. Try again later.",
    "Caution: you've hit your 5-hour usage limit. Try again later.", "Nearing your 5-hour usage limit. 5-hour usage limit reached.",
    "You're close to your limit. You've hit your 5-hour usage limit. Try again later.", "You've hit your 5-hour usage limit, but you can continue. Try again later.",
    "You've hit your usage limit. Try again in 3 days.", "You've hit your usage limit. Try again in 12 hours.",
    "You've hit your usage limit. Try again in seven hours.", "You've hit your usage limit. Try again next week.",
    "You've hit your usage limit. Try again on Monday.", "You've hit your usage limit. Try again next month.",
    "You've hit your usage limit. Try again later this week.", "You've hit your usage limit. Try again in 6.5 hours.",
    "You've hit your usage limit. Try again in 400 minutes.", "You've hit your usage limit. Try again in a fortnight.",
    "You've hit your usage limit. Try again overnight.", "You've hit your usage limit. Try again after the weekend.",
  ]) assert.equal(classifyLimit(provider, text), false, `${provider}: ${text}`);
  // A short reset still counts, and "Learn more" is a link label, not capacity.
  for (const provider of ["openai-codex", "anthropic"]) for (const text of [
    "You've hit your usage limit. Try again in 300 minutes.", "You've hit your usage limit. Try again in 4h 59m.",
    "You've hit your usage limit. Learn more: https://example.com/limits. Try again later.",
  ]) assert.equal(classifyLimit(provider, text), true, `${provider}: ${text}`);
  // The classifier accepts only reset shapes the Bridge reset reader can resolve.
  for (const reset of ["· resets 0am (Europe/Madrid)", "· resets 13pm (Europe/Madrid)", "· resets 1:60am (Europe/Madrid)", "· resets 4 pm (Europe/Madrid)", "· resets 4pm", "· resets 4:30:00pm (Europe/Madrid)", "· resets 4p.m. (Europe/Madrid)", "· resets at 4pm (Europe/Madrid)"]) {
    assert.equal(classifyLimit("claude-bridge", `You've hit your 5-hour limit ${reset}`), false, reset);
  }
  for (const [reset, from] of [["· resets 4pm (Europe/Madrid)", "2026-11-17T13:00:00Z"],
    ["· resets 4:30pm (America/Argentina/Buenos_Aires)", "2026-11-17T17:00:00Z"], ["· resets 12am (Etc/GMT+3)", "2026-11-18T01:00:00Z"]]) {
    const text = `You've hit your 5-hour limit ${reset}`;
    assert.equal(classifyLimit("claude-bridge", text), true, reset);
    assert.notEqual(bridgeResetFromText(text, Date.parse(from)), undefined, reset);
  }
});

test("only a short, closed reset tail can follow a retry phrase", async () => {
  for (const provider of ["openai-codex", "anthropic"]) {
    for (const tail of ["at 4:00 PM Tue", "at 4pm on Tue", "next Mon", "Sat", "in twenty hours", "in fifteen hours", "in thirty hours",
      "in 86400 seconds", "in 30000 seconds", "next year", "in a year", "in December", "in the coming days", "at the end of the week",
      "this coming week", "after the holidays", "next cycle", "once your plan renews", "in the morning", "at midnight", "in a while",
      "at 2026-12-04", "in 0h 400m", "in 5h 90m", "in 5 hours and 120 minutes", "at 4pm on December fifth", "in 6.5 hours"]) {
      assert.equal(classifyLimit(provider, `You've hit your usage limit. Try again ${tail}.`), false, `${provider}: ${tail}`);
    }
    for (const tail of ["later", "in 5 hours", "in 300 minutes", "in 359 minutes", "in 4h 59m", "in 2.5 hours", "in 5.5 hours",
      "in 2 hours 15 minutes", "in an hour", "in a few minutes", "in several hours", "at 4pm", "at 4:00 p.m.", "at 16:30", "at 16:00 UTC",
      "after 2026-09-12T14:00:00Z"]) {
      assert.equal(classifyLimit(provider, `You've hit your usage limit. Try again ${tail}.`), true, `${provider}: ${tail}`);
    }
  }
  // A stated instant outside the window is never replaced by the usage API's five-hour reset.
  let requests = 0;
  const registry = { isUsingOAuth: () => true, getApiKeyForProvider: async () => "synthetic" };
  const request = async () => { requests++; return { ok: true, json: async () => ({ five_hour: { resets_at: "2026-09-12T13:00:00Z" } }) }; };
  for (const text of ["You've hit your usage limit. Try again after 2026-12-04T10:00:00Z.", "You've hit your usage limit. Try again at 1798000000."]) {
    assert.equal(await resolveReset("anthropic", text, registry, request as any, Date.parse("2026-09-12T12:00:00Z")), undefined, text);
  }
  assert.equal(requests, 0);
});

test("bridge accepts nearby five-hour spelling and punctuation variants", () => {
  for (const text of [
    "You’ve hit your 5-hour limit · resets 8:50pm (America/Argentina/Buenos_Aires)",
    "You have hit your five-hour limit · resets 8:50pm (America/Argentina/Buenos_Aires)",
    "You've hit your 5 hour limit · resets 8:50pm (America/Argentina/Buenos_Aires)",
    "  Error: Claude quota exceeded – rate limit (five_hour): You've hit your 5-hour limit · resets 8:50pm (America/Argentina/Buenos_Aires)  ",
  ]) assert.equal(classifyLimit("claude-bridge", text), true, text);
});

test("unknown usage-limit candidates are diagnostic only, excluding unrelated and permanent errors", () => {
  assert.equal(isUnrecognizedUsageLimit("claude-bridge", "Claude rate limit (five_hour): usage cap reached; resets 8:50pm (America/Argentina/Buenos_Aires)"), true);
  for (const provider of ["anthropic", "openai-codex"]) {
    assert.equal(isUnrecognizedUsageLimit(provider, "Usage quota exhausted"), true);
  }
  for (const text of [
    "You've hit your 5-hour limit · resets 8:50pm (America/Argentina/Buenos_Aires)",
    "network timeout", "invalid API key; rate limit", "monthly usage limit reached",
    "weekly usage limit reached", "billing error; rate limit", "Claude usage warning: 95% of session limit used",
  ]) assert.equal(isUnrecognizedUsageLimit("claude-bridge", text), false, text);
  assert.equal(isUnrecognizedUsageLimit("other", "rate limit exceeded"), false);
});

test("bridge reset picks next future zoned minute, including midnight and DST repeats", async () => {
  const registry = { isUsingOAuth: () => { throw Error("bridge must not inspect OAuth"); }, getApiKeyForProvider: async () => { throw Error("bridge token requested"); } };
  const request = async () => { throw Error("bridge endpoint requested"); };
  const reset = (text: string, now: string) => resolveReset("claude-bridge", text, registry, request as any, Date.parse(now));
  const actual = "Claude rate limit (five_hour) — resets 1:50:00 AM: You've hit your session limit · resets 1:50am (America/Argentina/Buenos_Aires)";
  assert.equal(await reset(actual, "2026-09-29T02:19:00Z"), Date.parse("2026-09-29T04:51:30Z"));
  assert.equal(await reset("You've hit your session limit · resets 12:00am (America/Argentina/Buenos_Aires)", "2026-09-29T02:59:00Z"), Date.parse("2026-09-29T03:01:30Z"));
  // At fall-back 01:30 occurs twice; wait until after the later occurrence rather than firing prematurely.
  assert.equal(await reset("resets 1:30am (America/New_York)", "2026-11-01T05:00:00Z"), Date.parse("2026-11-01T06:31:30Z"));
  assert.equal(await reset("resets 1:30am (America/New_York)", "2026-11-01T05:45:00Z"), Date.parse("2026-11-01T06:31:30Z"));
  assert.equal(await reset("resets 2:30am (America/New_York)", "2026-03-08T06:30:00Z"), undefined, "spring-forward gap must not invent a reset");
  // Claude Bridge omits ":00" on the hour: "resets 4pm (Zone)".
  const hourOnly = "Error: Claude quota exceeded — rate limit (five_hour) — resets 4:00:00 PM: You've hit your 5-hour limit · resets 4pm (America/Argentina/Buenos_Aires)";
  assert.equal(await reset(hourOnly, "2026-11-17T17:30:00Z"), Date.parse("2026-11-17T19:01:30Z"));
  assert.equal(await reset("resets 12am (America/Argentina/Buenos_Aires)", "2026-09-29T02:59:00Z"), Date.parse("2026-09-29T03:01:30Z"));
});

test("bridge malformed and out-of-window resets fail closed without OAuth or fallback", async () => {
  let calls = 0;
  const registry = { isUsingOAuth: () => { calls++; return true; }, getApiKeyForProvider: async () => { calls++; return "token"; } };
  const request = async () => { calls++; return { ok: true, json: async () => ({}) }; };
  const now = Date.parse("2026-09-29T02:19:00Z");
  for (const suffix of ["resets 1:50am", "resets 1:50am (Invalid/Zone)", "resets 13:50am (America/Argentina/Buenos_Aires)",
    "resets 1:60am (America/Argentina/Buenos_Aires)", "resets 1:50am (America/Argentina/Buenos_Aires) · resets 2:50am (America/Argentina/Buenos_Aires)",
    "resets 6:50am (America/Argentina/Buenos_Aires)", "resets 5:19am (America/Argentina/Buenos_Aires)",
    "resets 13pm (America/Argentina/Buenos_Aires)", "resets 0am (America/Argentina/Buenos_Aires)", "resets 4pm"]) {
    assert.equal(await resolveReset("claude-bridge", `Claude rate limit (five_hour): You've hit your session limit · ${suffix}`, registry, request as any, now), undefined, suffix);
  }
  assert.equal(calls, 0);
});

test("reset parser bounds waits and fallback grows only to sixty minutes", () => {
  const now = Date.parse("2026-09-12T12:00:00Z");
  assert.equal(resetFromText("Try again at 2026-09-12T13:00:00Z", now), now + 3_600_000 + 90_000);
  assert.equal(resetFromText("Try again at 2026-09-13T13:00:00Z", now), undefined);
  assert.deepEqual([0,1,2,3,4].map(n => fallbackDeadline(n, now)), [10,20,40,60,60].map(n => now + n * 60_000));
  assert.equal(parseWait("5m"), 300_000);
  assert.equal(parseWait("1h"), 3_600_000);
  assert.equal(parseWait("7h"), undefined);
});

test("reset instructions select the buffered instant, never the noon log prefix", () => {
  const log = "[2026-09-12T12:00:00Z] 5-hour usage limit reached; ";
  const now = Date.parse("2026-09-12T12:00:00Z");
  for (const [instruction, expected] of [
    ["try again after 2026-09-12T13:00:00Z", "2026-09-12T13:01:30Z"],
    ["resets at 2026-09-12T14:00:00Z", "2026-09-12T14:01:30Z"],
    [`available again at ${Date.parse("2026-09-12T14:00:00Z") / 1000}`, "2026-09-12T14:01:30Z"],
  ]) assert.equal(resetFromText(log + instruction, now), Date.parse(expected), instruction);
  for (const instruction of ["reset unknown", "resets at 2026-09-12T13:00:00Z or 2026-09-12T14:00:00Z",
    "resets at 2026-09-12T13:00:00Z; try again after 2026-09-12T14:00:00Z"]) {
    assert.equal(resetFromText(log + instruction, now), undefined, instruction);
  }
  assert.equal(resetFromText("2026-09-12T13:00:00Z", now), Date.parse("2026-09-12T13:01:30Z"));
  assert.equal(resetFromText("5-hour usage limit reached until 2026-09-12T13:00:00Z", now), Date.parse("2026-09-12T13:01:30Z"));
});

for (const instruction of [
  "Next reset is scheduled for 2026-09-12T14:00:00Z",
  "Next reset (UTC): 2026-09-12T14:00:00Z",
  "resets at 2026-09-12T14:00:00Z; window started at 2026-09-12T09:00:00Z",
]) test(instruction, () => {
  const noon = "2026-09-12T12:00:00Z";
  assert.equal(resetFromText(`[${noon}] ${instruction}`, Date.parse(noon)), Date.parse("2026-09-12T14:01:30Z"));
});

test("next reset will be at identifies the reset, not a log time or competing instant", () => {
  const noon = "2026-09-12T12:00:00Z";
  const now = Date.parse(noon);
  const text = "5-hour usage limit reached. Next reset will be at 2026-09-12T14:00:00Z";
  for (const provider of ["anthropic", "openai-codex"]) assert.equal(classifyLimit(provider, text), true);
  assert.equal(resetFromText(text, now), Date.parse("2026-09-12T14:01:30Z"));
  assert.equal(resetFromText(`[${noon}] ${text}`, now), Date.parse("2026-09-12T14:01:30Z"));
  assert.equal(resetFromText(`${text}; resets at 2026-09-12T15:00:00Z`, now), undefined);
  assert.equal(resetFromText(`${text} or 2026-09-12T15:00:00Z`, now), undefined);
});

test("OAuth adapters use provider-specific endpoint and reset field, not other windows", async () => {
  const calls: Array<[string, RequestInit]> = [];
  const now = Date.parse("2026-09-12T12:00:00Z");
  const request = async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return { ok: true, json: async () => url.includes("chatgpt")
      ? { rate_limit: { primary_window: { reset_at: Math.floor((now + 3_600_000) / 1000) } } }
      : { five_hour: { resets_at: "2026-09-12T13:00:00Z" } } };
  };
  const registry = { isUsingOAuth: () => true, getApiKeyForProvider: async () => "token" };
  for (const provider of ["openai-codex", "anthropic"] as const) {
    assert.equal(await resolveReset(provider, "usage limit reached", registry, request as any, now), now + 3_690_000);
  }
  assert.equal(calls[0][0], "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(calls[1][0], "https://api.anthropic.com/api/oauth/usage");
  assert.equal((calls[1][1].headers as Record<string,string>)["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(await resolveReset("anthropic", "usage limit", { ...registry, isUsingOAuth: () => false }, request as any, now), undefined);
  assert.equal(calls.length, 2);
  assert.equal(await resolveReset("anthropic", "usage limit", registry, request as any, now, { provider: "openai-codex" }), undefined);
  assert.equal(calls.length, 2, "do not send another model's token to a provider endpoint");
  assert.equal(await resolveReset("anthropic", "usage limit", {
    ...registry, isUsingOAuth: () => { throw new Error("registry unavailable"); },
  }, request as any, now), undefined);
});

for (const source of ["timeout", "caller"]) test(`OAuth adapter discards late response body on ${source} abort`, async t => {
  const timeout = new AbortController(), caller = new AbortController();
  const timeoutMs: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => { timeoutMs.push(ms); return timeout.signal; });
  let requestSignal: AbortSignal | undefined;
  const request = async (_url: string, init: RequestInit) => {
    requestSignal = init.signal!;
    return { ok: true, json: async () => {
      (source === "timeout" ? timeout : caller).abort();
      return { five_hour: { resets_at: "2026-09-12T13:00:00Z" } };
    } };
  };
  const reset = await resolveReset("anthropic", "usage limit reached", { isUsingOAuth: () => true, getApiKeyForProvider: async () => "synthetic" },
    request, Date.parse("2026-09-12T12:00:00Z"), undefined, undefined, caller.signal);
  assert.deepEqual(timeoutMs, [8000]);
  assert.equal(requestSignal?.aborted, true);
  assert.equal(reset, undefined);
});

test("bridge reset defaults its search start to the current time", () => {
  // A reset one hour from the real clock, so the default must be a usable "now".
  const now = Date.now();
  const at = new Date(now + 60 * 60_000).toLocaleTimeString("en-US", { timeZone: "America/Argentina/Buenos_Aires", hour: "numeric", minute: "2-digit" });
  const text = `You've hit your 5-hour limit · resets ${at.replace(/\s+/, "").toLowerCase()} (America/Argentina/Buenos_Aires)`;
  const result = bridgeResetFromText(text);
  assert.notEqual(result, undefined, text);
  assert.equal(result, bridgeResetFromText(text, now), text);
});
