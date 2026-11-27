# keepgoing — Let the limit expire, not your workflow

**Usage-limit recovery, scheduled continuation, and system-sleep protection for Pi.** Opt in to a supported reset-based continuation or choose a delay yourself; keep the system awake while the screen can sleep and lock normally.

**Choose keepgoing when a supported usage window interrupts your Pi session and you want one opt-in workflow that keeps the computer awake, waits for a known reset, and continues without answering human decisions for you.**

It is a focused companion for Pi—not a scheduler daemon, an endless retry loop, an account/model failover, or an alternative to Gentle AI. The screen can still sleep and lock normally.

## The moment keepgoing earns its place

You are working on a substantial task. Claude reports:

```text
You've hit your 5-hour limit · resets 8:50pm (America/Argentina/Buenos_Aires)
```

You should not need to keep checking the clock, prevent system sleep separately, and remember to send a continuation later. Enable:

```text
/jb:keepgoing on
```

If the latest assistant message is an eligible error, keepgoing schedules for the printed reset **plus 90 seconds**. In this example, that is **20:51:30 in Buenos Aires** because the *message* names that zone, not because Keepgoing uses it by default. If Pi is running in Tokyo, `status` shows the same instant on the Tokyo clock. A manual `wait 24m` lasts 24 minutes in either city. [Compare the local times](docs/commands.md#timezones-and-waits). If no eligible error is present yet, it watches for the next one. In an interactive session, a newly settled supported limit produces a schedule or failure report automatically.

A Claude Bridge reset is resolved from the time of the error, not from when you run `on`. If that buffered reset already passed **no more than six hours** before now—for example after a `/reload` or a late `on`—keepgoing continues about **5 seconds** later. An older reset schedules nothing and is reported as unavailable.

**With `on`, opt in once for the session, not once per exhausted window.** After a continuation is submitted, Resume stays enabled for the next eligible exhaustion, without a session-wide continuation cap. Healthy usage does not trigger a turn.

## Why choose keepgoing?

- **One workflow for waiting and system-sleep protection.** Resume holds its own sleep-protection lease for the whole wait, including the idle time after the failed run settled; manual inhibition is separate. Turning one off does not release the other.
- **Explicit timing, not optimistic retries.** Automatic scheduling needs a recognized subscription-window error and a usable reset. Unknown limit-like messages are reported in the console, not turned into guessed deadlines or backoff retries.
- **A deliberate scope.** Supports eligible `openai-codex`, `anthropic`, and `claude-bridge` errors. Bridge understands raw and wrapped five-hour messages and printed IANA-zoned reset times, including hour-only resets such as `resets 4pm (Asia/Tokyo)`; it never queries a provider usage API.
- **A visible plan.** `status` opens with a plain headline—for example `⏳ Resume is ON. Waiting for Claude's usage window to reset.` or `✅ Resume is ON and watching for Claude's 5-hour usage limit. Nothing is scheduled yet.`—then shows the pending deadline, local timezone, countdown, sleep protection, and observed scheduling/cancellation reasons. In TUI the status bar shows `keepgoing ⏳ resumes in <n>m` while waiting and `keepgoing ✅ resume on` while monitoring. `off` without a pending wait reports only the off state and claims no cancellation. `status` does not make a model call or query a provider.
- **You remain the interrupt.** Input, prompts, decision tools, navigation, and Escape cancellation in TUI stop pending work. A continuation is not consent.
- **Small runtime footprint in dependencies.** No npm runtime dependencies; uses native platform helpers. This is not a claim about lower CPU, memory, or energy use than alternatives.

## How it compares with other Pi plugins

These tools overlap, but they are not interchangeable. keepgoing is a separate project from [pi-keep-going][keep-going] despite the similar name. The comparison below is based on their published documentation, checked **November 17, 2026**, and was not re-checked when this project took the keepgoing name; it is not a benchmark or an audit of every implementation. Features not described here should not be read as proven absent; “not documented” means only that the checked page does not describe it. The two `pi-auto-resume` packages are different projects.

### Usage-limit resume and auto-continue

| Alternative | Its documented focus | Choose keepgoing instead when… | Prefer the alternative when… |
| --- | --- | --- | --- |
| [pi-keep-going][keep-going] (v1.2.0) | On by default; usage-limit recovery for Anthropic, Codex, and Gemini at the reset plus 90 seconds, otherwise backoff from 30 minutes doubling; `maxWaitHours` 24; custom one-shot messages; jobs persisted per branch; a single-firer lease. Keep-awake is not documented; its 30-second absolute-timestamp check tolerates host sleep. | You want explicit session opt-in, built-in system-sleep protection, Claude Bridge support, and no guessed backoff when the reset is unknown. | You need Gemini, custom scheduled messages, waits up to 24 hours, persisted jobs, or a single-firer lease across processes sharing a session. |
| [@fahrizkyputra/pi-auto-resume][fahrizky] | Broad rate/network failure recovery, reset hints and headers, Claude subscriptions behind 9router, configurable backoff; `maxWaitMs` 0 means no limit; a 15-second wall-clock check; now ships a jcode daemon (macOS launchd). Typing, Escape, or a session switch cancels. | You want bounded subscription-window recovery with no automatic guessed-reset fallback, plus sleep protection in the same plugin. | You use 9router, need generic rate/network retries, unlimited or weekly waits, configurable continuation text/backoff, or a launchd daemon on macOS. |
| [pi-auto-resume by kasaiarashi][kasai] (1.0.0) | Output-token truncation, incomplete tool-call continuation, rate-limit retry using `Retry-After` or exponential backoff up to 1 hour; billing/plan failures only notify. | Your problem is a supported subscription window and keeping the host awake—not finishing truncated output or retrying broad error classes. | Your main interruption is `max_tokens`, incomplete tool-call output, or generic 429 recovery. |
| [pi-auto-wait][auto-wait] (0.1.1) | Opt-in (`/autowait`; `codexAutoWait5h` defaults to false); Codex five-hour window only; reset from the Codex usage API; waits until the reset plus 2 seconds, checks capacity, then resends (at most 3 times); fails open when no reset is available; in-memory, so a model change or reload cancels. Keep-awake is not documented. | You also use Anthropic or Claude Bridge, or want the machine kept awake during the wait. | You only use Codex and want a capacity check before the resend. |
| [pi-auto-continue][auto-continue] (0.4.1) | Detection on; by default asks through a dialog (`/ac config mode auto` for unattended); reset from CodexBar, then `x-ratelimit-reset`, then error text, up to 60 days; resumes by default in a fresh session via handoff; `pending-wait.json` is restored on the next start; asks again after 3 auto-resumes; never schedules in print/JSON mode. Keep-awake is not documented. | You want continuation in the same session, within a six-hour bound, with system-sleep protection. | You need the wait restored after Pi restarts, waits longer than six hours, CodexBar integration, or a fresh-session handoff. |
| [@cthulberg/pi-autoresume][cthulberg] (0.2.0) | On by default for any provider after the agent settles; reset from headers, Codex `Try again in ~N min` (plus 30 seconds), or generic “resets at”; otherwise backoff 5m/15m/30m/1h/2h; resets up to 7 days; in-session; sending a message cancels; its docs state “No escape key”. Keep-awake is not documented. | You want explicit opt-in, no guessed backoff, Escape cancellation, and sleep protection. | You want one always-on resume for every provider and accept backoff retries when no reset is printed. |
| [pi-continuity][continuity] (0.5.0) | On by default; also recovers truncation, broken streams, and tool-call endings; uses `Retry-After`, cooldown, or “Try again in”, otherwise polls every 10 minutes for up to 5 hours; session-bound; Escape, new input, or off interrupts; no usage API. Keep-awake is not documented. | You want a single scheduled continuation at a known reset, with no polling, plus sleep protection. | You want one extension for many interruption types, not only usage windows. |
| [pi-quota-auto-continue][quota-auto-continue] (0.3.0) | Oh My Pi only (“not supported on stock Pi”); on by default; Codex and Claude Code OAuth usage APIs; uses Oh My Pi's `retry()` instead of a continue message; metadata survives close; new input cancels. | You run stock Pi. | You run Oh My Pi and want its native retry. |
| [@andy8647/pi-agent-loop][agent-loop] (0.1.2) | Opt-in loop (`/agent-loop start <prompt>`) that waits for the reset plus a buffer for Anthropic, Kimi, DeepSeek, OpenAI, and a generic regex; the only documented cap is a maximum cycle count. Keep-awake and cancellation are not documented. | You want a bounded wait with documented cancellation, not a repeated prompt loop. | You want a prompt re-run in a loop across more providers. |
| [pi-multi-account][multi-account] (1.28.1) | On a quota error, switches to another account/model and auto-continues; polls usage APIs; persisted 6-hour default cooldown; a new message or Escape cancels; many providers. | You have one account and want to wait for its reset rather than switch. | You have several accounts or models and want failover instead of waiting. |

### Keep-awake only

| Alternative | Its documented focus | Choose keepgoing instead when… | Prefer the alternative when… |
| --- | --- | --- | --- |
| [pi-keepawake][keepawake] (1.0.2) | Zero-configuration system-sleep inhibition for the lifetime of any Pi process through the `pervigil` dependency; display sleep and lock remain enabled; “Verified on Windows 11 only”. | You want opt-in recovery timing and explicit on/off controls in addition to sleep inhibition. | You only need “Pi is open, the machine stays awake,” without scheduling or recovery commands. |
| [@narumitw/pi-caffeinate][narumitw] (0.49.15) | Run-scoped inhibition, configurable system/display modes, saved preferences, and WSL support; display-awake is the documented default. | You want system-only protection to remain active during a quota wait, with recovery and no display-awake mode to configure. | You need display-awake controls, per-run release, WSL-specific support, or custom inhibitor commands. |
| [pi-insomnia][insomnia] (0.4.0) | Keeps the host awake only while the agent runs; macOS and Linux; prevents idle sleep, not display sleep; its docs mention a telemetry ping. | The wait happens after the failed run has settled and you want protection for that idle time too. | You want automatic, run-scoped inhibition with no commands. |
| [pi-caffeinate by georgebashi][caffeinate] (2.0.0) | Keeps the host awake while the agent works; macOS, Linux, and Windows. | Same as above: you want protection during the wait between runs, together with recovery. | You want automatic run-scoped inhibition on all three platforms. |
| [@brianmichel/pi-awake][awake] (0.1.0) | Keep-awake for macOS only. | You also use Linux or Windows, or want recovery in the same plugin. | You are on macOS and only want keep-awake. |
| [pi-caffeinated][caffeinated] | A manual `/caffeinate` toggle with a centered coffee-break modal and platform-native keep-awake helpers. Not re-checked on November 17, 2026 (last checked November 2, 2026). | You want a pending continuation and command/status-driven control rather than a coffee-break overlay. | You want a visual manual break mode, not provider-limit recovery. |

Other keep-awake packages appeared only in pi.dev search results and were **not reviewed**: `@pedro_klein/pi-caffeinate`, `@artale/pi-caffeinate`, and `alanly/pi-caffeine`. Nothing is claimed about them.

**The differentiator is the combination:** explicit session opt-in, system-only sleep protection that covers the idle wait, conservative reset-based continuation with no guessed-reset fallback and a six-hour cap, Claude Bridge wall-clock resets (including `resets 4pm (Zone)`), and cancellation at human-interaction boundaries such as prompts and decision tools. None of the resume packages above documents sleep prevention, Claude Bridge reset parsing, or cancellation on decision tools/prompts—that is a reading of their docs, not a proof of absence. Other packages are a better fit if you want broader retries, restart persistence, longer waits, account failover, or simpler always-on inhibition.

## With Gentle AI: keep the workflow moving, not the consent gates

**Gentle AI handles the development workflow; keepgoing handles a supported quota wait in the current Pi session.** They are complementary, not competing harnesses—but Gentle Shell's optional model fallback chains overlap with keepgoing on quota errors (see below).

When using Gentle AI through `gentle-pi`/Gentle Shell:

1. Start the task normally with its existing scope, tracking, and review workflow.
2. Enable `/jb:keepgoing on` in that same Pi session before or after an eligible top-level usage-limit error.
3. If Pi settles on that error, keepgoing can wait for the valid reset and submit a continuation through Pi's normal user-message pipeline.
4. If a UI prompt or `ask_user_choice` / `ask_user_question` decision tool opens, keepgoing cancels its pending work. Closing or answering a prompt does **not** automatically recreate that wait.

This is **event-based interoperability**, not a direct Gentle AI API integration. keepgoing observes Pi prompt and tool events; it does not inspect native review lineages, maintain receipts, or know every possible consent surface. It does not depend on Gentle AI and also works in plain Pi.

### What Gentle Shell already does about quota (gentle-pi 5.1.0)

- **No keep-awake.** A search of the gentle-pi 5.1.0 package for inhibit, caffeinate, keep-awake, and wake-lock found nothing. keepgoing's sleep protection does not duplicate a Gentle feature.
- **Opt-in model fallback chains.** When a profile has an ordered fallback list in `profile-fallbacks.json`, a quota (usage limit, billing) or auth error switches at once to the next model, and rate-limit, provider-unavailable, timeout, and network errors switch after Pi's own retries; a follow-up message resumes the work. A model that hit a limit or auth error is skipped for 30 minutes (2 minutes after a transient error), and a spent `/gentle:usage` limit holds that model—or the whole provider when every one of its limits is spent—until the reset. Nothing happens unless chains are configured. This is **switching model**, not waiting for the same model's reset.
- **`/gentle:usage` is a display** and a cooldown input for those chains, not a scheduled continuation.
- **The orchestrator's quota-recovery guidance is prompt text**, not automation: it covers only a failed verifier, says it is “not an automatic retry, provider/model fallback”, and allows one new attempt only after the human reports restored availability and explicitly requests the missing verification.

**Combining fallback chains with keepgoing on the same error is untested (unverified).** Both can react to the same settled quota error: a chain may send its follow-up on another model while keepgoing has scheduled a continuation for the original reset. Pick one per lane: fallback chains where switching model is acceptable, keepgoing where you want to wait for the same model's reset.

### What it does not do for Gentle AI

- It does not grant review consent, approve a finding, acknowledge review authority, or change RDD settings.
- It does not authorize commits, pushes, merges, releases, or additional product scope.
- It does not replace ODD tracking, Engram memory, verification, or the human's decisions.
- It does not detect or relaunch a subagent whose error exists only inside that subagent.
- It does not preserve a timer after exit/reload or reconstruct the exact failed provider request.
- It does not switch model or account; that is what Gentle's fallback chains (or another plugin) do.

The recovery message explicitly tells the model not to make decisions for the user. That instruction is **not a security boundary**; the host's existing consent and permission controls remain responsible. Local deterministic tests exercise the prompt/decision cancellation hooks; this is not a claim of certified compatibility with every Gentle AI version or UI.

See [Gentle AI's Pi package][gentle] and the [Gentle Shell repository][gentle-shell] for its workflow and review responsibilities, and [keepgoing's architecture](docs/architecture.md) for the actual interoperability boundary.

## When not to use keepgoing

| Your requirement | Why another approach is better |
| --- | --- |
| Continue after Pi exits, reloads, or the machine reboots | Pending timers are deliberately session-bound and are not restored. [pi-auto-continue][auto-continue] restores its pending wait on the next start, and [pi-keep-going][keep-going] persists jobs per branch. Persisted extension jobs still do not imply OS-level relaunch. |
| Switch to another account or model when quota runs out | keepgoing only waits for the same window to reset. Use [pi-multi-account][multi-account] or Gentle Shell's model fallback chains—not both on the same lane as keepgoing. |
| Recover arbitrary 429/network errors, output truncation, or every provider | keepgoing deliberately recognizes a narrow set of subscription-window failures. Use a broader recovery extension such as [pi-continuity][continuity] or [kasaiarashi's pi-auto-resume][kasai] if that is the job. |
| Wait through weekly/monthly limits or automatically wait more than six hours | Automatic deadlines, including the 90-second buffer, must fit within six hours. Monthly/weekly, billing, and auth errors are not eligible recovery triggers. Others document longer waits (for example 24 hours in pi-keep-going, 7 days in @cthulberg/pi-autoresume, 60 days in pi-auto-continue). |
| Keep the display awake or disable screen locking | keepgoing inhibits system sleep only. Use a display-mode tool such as [@narumitw/pi-caffeinate][narumitw] if that is intentional. |
| Coordinate exactly one continuation across multiple Pi processes attached to the same session | keepgoing does not provide a cross-process single-firer lease; pi-keep-going documents one. |
| Run on Oh My Pi with its native retry | keepgoing submits a normal continuation message; [pi-quota-auto-continue][quota-auto-continue] targets Oh My Pi's `retry()`. |
| Fix credentials, buy credits, or bypass provider quotas | Waiting cannot solve these problems. keepgoing does not bypass provider restrictions. |
| Guarantee autonomous completion while you are away | A scheduled message can still be cancelled or fail asynchronously. A submitted continuation is not proof that Pi accepted it or that the model finished the task. |

Automatic recovery is not “free extra usage”: the resumed turn consumes provider usage normally. Keeping the system awake also has a power cost. Turn Resume off when you no longer need it.

**Avoid enabling multiple automatic-resume plugins on the same session.** They can independently schedule continuations. Several packages above (pi-keep-going, @cthulberg/pi-autoresume, pi-continuity) are on by default once installed, so co-installing one with keepgoing can produce duplicate continuations even if you never enable it. Likewise, another keep-awake extension may keep the host awake after keepgoing releases its own lease. Co-installation has not been validated as a coordinated workflow.

## Try it without changing your workflow

From a checkout on macOS or Linux, run `pi install "$PWD"` or `./install.sh`; use `./install.sh --all-homes` when you run several Pi homes (`.\install.ps1 -AllHomes` on Windows, not yet verified on native Windows). See the [installation guide](docs/install.md). Load the package before scheduling anything; `/reload` cancels pending timers, although a later `on` still continues a Claude Bridge reset that passed within the last six hours. Submit these commands separately:

```text
/jb:keepgoing on
/jb:keepgoing status
```

To choose the delay yourself, without a provider error, use `wait` on its own. From OFF it schedules one `Continue`, releases its lease on dispatch or cancellation, and leaves monitoring OFF. If you explicitly turn monitoring on before or during the wait, it stays on afterward.

```text
/jb:keepgoing wait 24m
```

To stop Resume and release its sleep-protection lease:

```text
/jb:keepgoing off
```

Need only manual system-sleep protection? Use `/jb:keepgoing inhibit on` and later `/jb:keepgoing inhibit off`; that is independent of Resume. Platforms have native helper prerequisites, and implemented support is not proof of live validation everywhere: read the [platform requirements](docs/install.md#platform-requirements) and [verification status](docs/manual-test-todo.md).

**Choose keepgoing for a controlled pause in work you already authorized—not for automation that decides what should happen next.**

## Sources and comparison scope

- keepgoing's implementation and behavior: [commands](docs/commands.md), [installation](docs/install.md), [recovery classification](src/recovery.ts), [extension lifecycle](extensions/keepgoing.ts), and deterministic tests (`tests/keepgoing.test.ts` in the source checkout; tests are not included in the package files).
- Alternative capabilities are attributed to their package pages or upstream README below, checked November 17, 2026 (pi-caffeinated: November 2, 2026). No competitor was installed or benchmarked for this guide; no relative reliability, speed, or security ranking is claimed.
- Gentle Shell capabilities come from the locally installed gentle-pi 5.1.0 package, checked November 27, 2026 (`README.md` and `docs/readme-reference.md`, “Model fallback chains”; `assets/orchestrator-quota-recovery.md`) and its [repository][gentle-shell]. Its absence of keep-awake is based on a text search of that package, not on an audit. The interaction between its fallback chains and keepgoing is unverified.
- Documentation and defaults can change. Recheck the linked sources before choosing or publishing an updated comparison.

[keep-going]: https://pi.dev/packages/pi-keep-going
[fahrizky]: https://pi.dev/packages/%40fahrizkyputra/pi-auto-resume
[kasai]: https://pi.dev/packages/pi-auto-resume
[auto-wait]: https://pi.dev/packages/pi-auto-wait
[auto-continue]: https://pi.dev/packages/pi-auto-continue
[cthulberg]: https://pi.dev/packages/%40cthulberg/pi-autoresume
[continuity]: https://pi.dev/packages/pi-continuity
[quota-auto-continue]: https://pi.dev/packages/pi-quota-auto-continue
[agent-loop]: https://pi.dev/packages/%40andy8647/pi-agent-loop
[multi-account]: https://pi.dev/packages/pi-multi-account
[keepawake]: https://pi.dev/packages/pi-keepawake
[narumitw]: https://pi.dev/packages/%40narumitw/pi-caffeinate
[insomnia]: https://pi.dev/packages/pi-insomnia
[caffeinate]: https://pi.dev/packages/pi-caffeinate
[awake]: https://pi.dev/packages/%40brianmichel/pi-awake
[caffeinated]: https://pi.dev/packages/pi-caffeinated
[gentle]: https://pi.dev/packages/gentle-pi
[gentle-shell]: https://github.com/Gentleman-Programming/gentle-shell

Additional primary source for pi-keep-going: https://github.com/ohlulu/pi-keep-going
