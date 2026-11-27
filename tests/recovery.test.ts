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

