# Command guide

Use `/jb:keepgoing` for continuation **in the current Pi session**. It inhibits system sleep only; display sleep and screen lock remain enabled. **Keep Pi open**: closing or reloading it cancels timers, and no OS scheduler restarts it. `/jb:keepgoing inhibit on|off|status` is a separate manual system-sleep switch inside the same command. Earlier command names have no aliases.

## Resume options

| Command | What it does |
| --- | --- |
| `/jb:keepgoing` or `/jb:keepgoing on` | Enable automatic recovery and acquire the session sleep lease. In TUI/RPC, check the latest active-branch message for an eligible settled subscription-window error and schedule at the valid reset plus 90 seconds. Report the continuation time/countdown or scheduling failure. Without an error, wait for a new supported limit and announce its schedule or failure automatically. No immediate model turn; an existing wait is preserved. After recovery, keep watching for the next exhaustion with no continuation-count limit. |
| `/jb:keepgoing status` | Friendly read-only waiting/monitoring/off report, truthful sleep protection, one exact local date/time with seconds and timezone, and rounded countdown. Shows observed reasons and next steps, without provider queries or model calls. Ends with the installed version, for example `keepgoing 1.0.0`. |
| `/jb:keepgoing wait 1h` or `/jb:keepgoing wait 24m` | Schedule one user message `Continue`. From OFF, the wait holds the session lease until dispatch or cancellation without enabling monitoring. If `on` is issued before or during the wait, monitoring stays on afterward. No prior `on` or provider reset required. A safe wait replaces any pending timer. Use a positive whole number with `m` or `h`, up to six hours. Rejected waits do not leave a newly enabled state or lease behind. |
| `/jb:keepgoing now` | Accelerate an already pending continuation subject to timer and safety checks. It does not enable resume or create a timer. **It can run before the provider reset**: use only when deliberately trying early. |
| `/jb:keepgoing off` | Cancel the timer and abort outstanding usage lookups, disable recovery, and release only the resume lease. The manual lease remains active. With a pending wait, the report adds `Previous wait cancelled by /jb:keepgoing off.`; without one, it reports only the off state and claims no cancellation. |

### Reading the report

| Headline | Meaning |
| --- | --- |
| `⏸ Resume is OFF. Nothing is scheduled.` | Disabled, with no continuation scheduled. |
| `✅ Resume is ON and watching for Claude's 5-hour usage limit. Nothing is scheduled yet.` | Enabled without a timer; previous cancellations/submissions are history. |
| `⏳ Resume is OFF. Waiting for your requested time only.` | A one-off timer is pending, without automatic monitoring. |
| `⏳ Resume is ON. Waiting for your requested time.` / `⏳ Resume is ON. Waiting for Claude's usage window to reset.` | A timer is pending. Its deadline/countdown stays primary even after a rejected replacement (`The new attempt was not scheduled: <reason>.`). |
| `⏳ Resume is ON. Claude's usage window already reset; continuing in a few seconds.` | The provider reset had already passed (no more than six hours ago); the continuation runs about 5 seconds after scheduling. |
| `⚠️ Resume is ON, but nothing was scheduled.` | The evaluated attempt did not schedule; read `No continuation was scheduled: <reason>.` and its `Next:` action. |

The line `Your computer will stay awake (the screen can still turn off). Keep this Pi session open: timers end when you exit or reload Pi.` appears only while Resume is on or waiting; the off report omits it.

In TUI, the status bar shows `keepgoing ⏳ resumes in <n>m` while a wait is pending (minutes rounded up), `keepgoing ✅ resume on` while monitoring, and nothing while off.

After a standalone timed continuation, `status` reports OFF with submission history. If monitoring was explicitly enabled, after a successful timed or provider-reset continuation, `status` shows the `✅ Resume is ON and watching…` headline and `Previously: the continuation was sent to Pi.` Its next action is: `Resume will monitor for another usage limit. Use /jb:keepgoing off if you no longer need it.` This is sent history, not a pending human prompt; real prompts/decisions still advise answering the human prompt before scheduling a new wait.

Submitting a continuation also adds `Last continuation at: 21:07:09 · Sep 12, 2026 · Asia/Tokyo` (in a Tokyo runtime). It records the actual time the submission call returned without a synchronous error, not the planned deadline. The entire line is absent until this session has a recorded submission. Scheduling, cancellation, guard rejection and synchronously failed submissions never create or replace it; each later submission replaces the previous time. `off` retains history. Valid saved history survives reload in the same session only; a different session or fork does not inherit it, and a session switch during submission records nothing. This is **not** confirmation that Pi accepted the message or that the model started or completed: Pi dispatches asynchronously, so a failure can still follow a recorded submission.

`on` ends with the same report, including the continuation time/countdown or no-schedule reasons. If no error is present, it explains that Resume will wait for a supported usage-limit error and then automatically report the schedule or failure. Missing errors are normal monitoring, not failed attempts. Newly settled supported limits emit that report automatically; `status` remains a read-only way to inspect it. Some report wording says “Claude” even for supported Codex/Anthropic recovery; this is presentation, not a restriction to Claude. Example in a Tokyo runtime:

```text
⏳ Resume is ON. Waiting for Claude's usage window to reset.

Continue at: 00:14:30 · Oct 10, 2026 · Asia/Tokyo
Time remaining: 24m

Your computer will stay awake (the screen can still turn off). Keep this Pi session open: timers end when you exit or reload Pi.

Cancel with /jb:keepgoing off or Escape.

keepgoing 1.0.0
```

Every Resume report (`on`, `off`, `status`, rejected `wait`, and automatic announcements) ends with `keepgoing <version>`, read from the package's own `package.json`; it shows `keepgoing (version unknown)` if that file cannot be read.

The date includes the year and exact seconds; the IANA timezone comes from the runtime's local `Intl` timezone, not a hardcoded country or the provider's zone. Countdown rounds **up**: at least 60 seconds uses whole minutes (`2h 36m`, `1m`), below 60 seconds uses whole seconds (`60s` for 59.999 seconds). A pending timer never shows `0m`; if due but not yet dispatched, it shows `1s`. There is no continuation-count ceiling; a completed automatic recovery returns to monitoring for the next eligible exhaustion. If Resume's sleep protection is inactive, `Warning: Resume is not keeping your computer awake.` replaces the promise to keep the computer awake.

**Submit slash commands one at a time. `/reload` cancels any pending timer.** Reload only when ready to recreate it with `on` or `wait`; status never restores a cancelled timer. Reasons distinguish ineligible or consumed latest branch messages, busy/queued work, prompts/decisions, the five-minute repeat guard, evaluated unavailable resets, enqueue rejection, and cancellation/backend loss. They describe observed outcomes only, not inferred provider causes. Diagnostics reset when the session/branch is restored and are not saved. A cancelled prompt does not remain a claimed current blocker after it closes. Display sleep remains unchanged and the scope is only the current session while Pi stays open.

### Timezones and waits

`/jb:keepgoing wait 24m` counts 24 minutes from the command. It does not read a timezone or add a reset buffer. For a Claude Bridge reset, the zone in the provider’s message determines the instant; the report displays it in the local timezone of the Pi process. Neither zone is fixed to Buenos Aires.

For example, on **January 15, 2026**, `resets 8:50pm (America/Argentina/Buenos_Aires)` gives one future deadline after the 90-second buffer. Only the displayed clock and date change:

| Pi’s local timezone | `Continue at` (local date and time) |
| --- | --- |
| `America/Argentina/Buenos_Aires` | Jan 15, 20:51:30 |
| `Europe/Madrid` | Jan 16, 00:51:30 |
| `Asia/Tokyo` | Jan 16, 08:51:30 |

The date matters: cities that observe daylight saving time can have different offsets at other times of year.

### Which option should I use?

1. After recognized five-hour exhaustion, use `on` and inspect `status`. No schedule means no automatic turn will happen later.
2. Choose `wait <duration>` when you decide the delay yourself. It replaces an automatic retry; repeating `on` does not replace a wait. A wait does not change your monitoring preference or save a timer to restore after reload.
3. Use `now` only to accelerate knowingly; use `off` to cancel and release the lease.

Automatic recovery requires a usable reset within six hours. Missing or invalid reset schedules **nothing**; there is no speculative fallback. Claude Bridge resolves its printed wall-clock reset relative to the error's timestamp, not the current time. If that buffered reset already passed no more than six hours ago (for example after `/reload` or a late `on`), Resume continues about 5 seconds later; an older reset reports `No continuation was scheduled: Claude's usage reset passed more than six hours ago.` Only Claude Bridge takes this path; a Codex/Anthropic reset that is not in the future schedules nothing. A 95% warning is not exhaustion. Claude Bridge accepts both `Claude rate limit (five_hour)` and `Claude quota exceeded — rate limit (five_hour)`. They accept explicit session, five-hour, or extra-usage exhaustion with a valid printed local reset and IANA zone, such as `resets 1:50am (Asia/Tokyo)` or the hour-only `resets 4pm (Europe/Madrid)`. The raw `You've hit your 5-hour limit · resets 8:50pm (America/Argentina/Buenos_Aires)` message also qualifies, as do the wrapped message with `Error:`, straight/curly apostrophes, `5 hour`/`five-hour`, and dash variants in the quota wrapper. Nothing else may appear in a Bridge report: extra advice, a count or a question schedules nothing. Codex/Anthropic reports that mention a count, a unit such as requests or messages, remaining capacity, a warning or a question also schedule nothing. Codex/Anthropic use an absolute error reset first and attempt their Pi-managed OAuth usage lookup only when no usable absolute reset is available. Bridge never performs OAuth lookup. Only the latest eligible branch message is considered, not older errors behind newer messages. The six-hour bound includes the 90-second buffer, and provider recovery retains the five-minute repeat guard.

### Unknown limit messages

While Resume is on, keepgoing logs one console line per unrecognized limit-like error object from `claude-bridge`, `anthropic` or `openai-codex`. By default it names only the provider and the reason:

```text
keepgoing: provider=claude-bridge reason=unrecognized_usage_limit
```

For troubleshooting, start Pi with the environment variable `KEEPGOING_DEBUG=1`. The same line then includes three fields, for example `family=rate-limit window=five-hour reset-marker=present`. They describe markers found in the first 512 UTF-16 code units of the error, not a confirmed exhaustion or reset. Family is `rate-limit`, `usage-limit` or `unknown`; window is `five-hour`, `session` or `unknown`; the reset marker is `present` or `absent`.

In both modes the complete diagnostic is at most 160 ASCII characters on one line. No free text is copied: secrets, request or account IDs, paths, URLs, timestamps, zones and control characters are all withheld. Unset `KEEPGOING_DEBUG` or set it to `0` before starting Pi for summary-only logging; only the exact value `1` enables details.

The UI points to the summary; inspecting the same error again does not log it twice. Unknown messages never authorize a continuation or change retry rules. Known warnings, auth/billing failures, and monthly/weekly limits are excluded. Use an explicit `wait` if you choose the delay yourself.

Pending continuation requires the same session, live sleep lease, idle Pi, no queued message or human decision. User input, Esc in TUI, human prompts/tools, session navigation, shutdown, or backend loss cancels it. Restart/reload does not replay a timer, and reboot recovery is not supported. Error-only failures inside a subagent do not trigger detection or relaunch. Retroactive `on` does not retain a timer in print/JSON single-shot modes; automatic `agent_settled` recovery can hold those modes open. Standalone command waits depend on an open interactive runtime, not a detached single-shot timer.

## Manual sleep inhibition

The `inhibit` subcommand is independent of Resume: it does not enable or disable Resume, schedule a turn, or change a pending wait.

| Command | What it does |
| --- | --- |
| `/jb:keepgoing inhibit on` | Acquire the independent manual sleep lease. Does not enable resume or schedule a turn. |
| `/jb:keepgoing inhibit status` | Report whether the manual lease is active. |
| `/jb:keepgoing inhibit off` | Release only the manual lease; the resume lease remains separate. |

See [installation](install.md) and [architecture](architecture.md).
