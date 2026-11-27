# Live verification status and checklist

Deterministic tests and live observations answer different questions. Use a disposable Pi session for the pending checks below before relying on Resume for unattended work. The keepgoing rename performed **no live tests**; every item below that names `/jb:keepgoing` is unverified in a live session.

## Evidence already available

| Evidence | What it supports | What it does not establish |
| --- | --- | --- |
| Automated test coverage | Fake-Pi command wiring, provider classification/reset handling, guards, reports, state and process arguments; run with `npm test` | Native power behavior, live exhaustion, or model acceptance |
| Historical Linux/systemd RPC smoke (0.4.0) | Owned `sleep`/`block` inhibitor row, owner isolation and 0→1→1→0 cleanup | Discovery of `/jb:keepgoing`, display/lock observation, or other platforms |
| User-confirmed Claude recovery (before the keepgoing rename) | Recovery worked in the user's Claude workflow with an earlier release | The renamed `/jb:keepgoing` command, every Claude route, provider/runtime combination, or platform |

Historical evidence used earlier command names and package identity. It is not verification of the keepgoing installation. User confirmation is not a provider/platform certification matrix.

## Pending installation and runtime checks

- [ ] Inspect `pi list` for the intended checkout, reload, and confirm keepgoing registers only `/jb:keepgoing`, with `/jb:keepgoing status` and `/jb:keepgoing inhibit status` working. After removing an earlier installation and restarting Pi, confirm no earlier command names remain, a session needs `/jb:keepgoing on` again, and no earlier pending timer reappears. Cross-check any [checkout helper](install.md#optional-checkout-installers) status with that listing; exercise the PowerShell installer on Windows (no runner available during preparation).
- [ ] In TUI, check completion, countdown, lone-Escape cancellation and UI prompt overlap. In RPC, check supported notifications. Submit slash commands one at a time.
- [ ] In TUI/RPC, confirm bare `/jb:keepgoing` behaves like `on`, and that `/jb:keepgoing inhibit on|off` leaves Resume and any pending wait unchanged. Schedule a standalone `wait` without prior `on`; verify `status` shows monitoring OFF with a deadline. After dispatch or cancellation check that only the manual inhibitor remains if enabled. Try `on` during a second wait: the deadline should stay unchanged and monitoring should remain ON afterward. Verify replacement rejection preserves a valid pending wait.
- [ ] In print/JSON, verify eligible automatic settled-handler recovery holds the process open, while retroactive slash activation does not advertise a disposable timer.
- [ ] Confirm reload cancels timers, saved enabled mode restores on the intended branch, and submission history is not imported into a different session or fork.
- [ ] Confirm the 1.0.0 headlines (`⏸ Resume is OFF. Nothing is scheduled.`, `✅ Resume is ON and watching for Claude's 5-hour usage limit. Nothing is scheduled yet.`, `⏳ Resume is ON. …`, `⚠️ Resume is ON, but nothing was scheduled.`) and the TUI status bar (`keepgoing ⏳ resumes in <n>m`, `keepgoing ✅ resume on`). Check `off` without a wait reports no cancellation.
- [ ] Confirm every Resume report ends with `keepgoing 1.0.0` for the installed package.
- [ ] Run `./install.sh --all-homes` (start with `status` or `--dry-run`) with several Pi homes; confirm `==> keepgoing 1.0.0` once, `Pi home: <dir>` per home and the intended `pi list` in each home.
- [ ] On native Windows, run `.\install.ps1 status -AllHomes` and `-DryRun`, then the real action; confirm it mirrors `--all-homes`.

## Pending provider checks

- [ ] For Codex and Anthropic, verify a live eligible five-hour error, absolute reset preference, and managed-OAuth lookup only when needed. Confirm one same-session continuation without bypassing a human decision.
- [ ] For Claude Bridge, verify both supported prefixes with explicit exhaustion and zoned reset, without OAuth lookup. Extend the user-confirmed Claude evidence only to combinations actually exercised.
- [ ] Compare the [same Bridge deadline in three local zones](commands.md#timezones-and-waits). Keep the error timestamp and printed reset zone fixed, change the Pi runtime zone, and verify only the displayed date/time changes. A separate `wait 24m` must remain 24 minutes in each zone.
- [ ] For Claude Bridge, verify an hour-only reset such as `resets 4pm (<IANA zone>)` schedules at that hour plus 90 seconds.
- [ ] For Claude Bridge, let the reset pass before `/reload` + `/jb:keepgoing on` (or a late first `on`); confirm `⏳ Resume is ON. Claude's usage window already reset; continuing in a few seconds.` and one continuation about 5 seconds later. Confirm an error older than six hours past its reset schedules nothing.
- [ ] Keep Resume on across successive exhausted windows, including beyond twelve continuations. Confirm recovery stays enabled after each dispatch, healthy usage schedules nothing, and `off` prevents further recovery.
- [ ] Confirm automatic scheduling emits a report without requesting `status`, including the buffered deadline and runtime-local timezone; confirm unavailable resets/guard rejections report the reason. With no error, `on` should explain monitoring rather than a failed attempt.
- [ ] With Resume on, present a synthetic unrecognized limit-like error containing a fake secret and a newline. With `KEEPGOING_DEBUG` unset or `0`, confirm one console line with only provider and reason. Restart Pi with `KEEPGOING_DEBUG=1`: check for family, window and reset-marker labels, no original text and at most 160 characters on one line. In each mode re-inspect the same error; expect no duplicate warning and no scheduled continuation.
- [ ] Observe submission history separately from actual Pi/model acceptance; do not infer completion from the timestamp alone.

Do not manufacture real quota exhaustion in routine unit tests. Missing or invalid resets should schedule nothing; use an explicit timed wait when choosing the delay yourself.

## Pending platform and power checks

- [ ] On Linux/systemd (including Omarchy), observe display blanking and locking while system sleep is inhibited.
- [ ] On macOS, confirm `caffeinate -i -w` keeps the system awake, permits display sleep and exits on Pi termination.
- [ ] On native Windows, confirm the hidden helper sets only `ES_SYSTEM_REQUIRED`, exits on parent loss and releases its request on explicit off and abnormal termination.
- [ ] On each platform, verify manual and resume owners do not release each other and owned helpers exit on normal quit.
- [ ] Terminate an owned helper during a disposable Resume wait. Confirm disabled status, no continuation, cleared TUI listener/headless wait, and successful re-enabling after restoring the backend.

Record the platform, Pi/package versions, provider route, runtime mode and observed result when completing a live check. Keep untested combinations pending rather than generalizing a successful run.
