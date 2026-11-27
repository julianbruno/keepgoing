# Changelog

## 1.0.0 — Initial Keepgoing version (unreleased)

### Commands and migration

- `/jb:keepgoing` is the single command for the `pi-keepgoing` package. Use `on`, `off`, `status`, `now`, or `wait 24m` for continuation; use `inhibit on|off|status` to manage sleep protection without sending a message. Running `/jb:keepgoing` without arguments means `on`.
- **Breaking for earlier development builds:** the old commands have no aliases, and Keepgoing does not import their saved opt-in or pending timers. After removing an earlier installation, restart Pi and run `/jb:keepgoing on` in each session where you want monitoring.

### Recovery and timing

- Resume watches for supported usage-limit errors from Claude Bridge, Anthropic, and OpenAI Codex. It schedules a `Continue` for a known reset plus 90 seconds, within a six-hour window. A warning or an unknown reset does not trigger a retry. Manual waits use the duration you choose instead.
- Claude Bridge reads the reset time and timezone from the provider’s message, including hour-only times. If the buffered reset has already passed by no more than six hours, Keepgoing waits about five seconds before continuing. No city is a default; Pi displays deadlines in its local timezone. See [the same deadline in three cities](docs/commands.md#timezones-and-waits).
- Explicitly enabled monitoring stays on across successive usage windows. Automatic continuation checks the current session, pending work, human decisions, sleep protection, and the five-minute repeat guard. Keep Pi open: exiting or reloading cancels pending timers.

- Exhaustion is recognized only in its exact known form, and anything else schedules nothing. Claude Bridge accepts just the optional `Error:` prefix, the optional `five_hour` header, the exhaustion sentence and `· resets <time> (<Area/City>)`. Codex and Anthropic reports are rejected if they mention a count, a unit such as requests or messages, remaining capacity, a warning or a condition, or a question. A stated reset days away or more than five hours away also schedules nothing. A Bridge reset must be written as `resets 4pm (Area/City)` or `resets 4:30pm (Area/City)`. Extra advice and even `0 requests remaining` now schedule nothing; use `/jb:keepgoing wait` in those cases.
- `wait 24m` started while Resume is off sends one `Continue` and leaves Resume off afterwards. An explicit `on` keeps monitoring. `off` also aborts any quota lookup in progress.

### Consent and privacy

- Resume consent belongs to the Pi session file that granted it: a fork or copied session never inherits `on`. An aborted turn is never resumed, even after reload, navigation, or loss of sleep protection.
- Unrecognized limit errors log only the provider and a fixed reason. `KEEPGOING_DEBUG=1` adds fixed diagnostic labels; the provider's error text is never printed.
- The uninstallers remove only the exact personal registration for this checkout and refuse when another registration, link, or managed install points to it. The checkout's files are never deleted.

### Status and sleep protection

- `status` shows whether Resume is monitoring, waiting, or off without querying the provider. It reports the local deadline and countdown for a pending wait, or the reason nothing was scheduled. `Last continuation at` records when Keepgoing submitted a message to Pi, not whether the model completed a turn.
- While waiting, the status bar shows only the countdown (`keepgoing ⏳ resumes in 24m`). Escape still cancels. Manual sleep protection is independent of Resume: it can keep the computer awake while the screen sleeps or locks normally.

### Installation and documentation

- Added Bash and PowerShell checkout installers and uninstallers, with preview and Pi-home selection. Resume reports and checkout actions show the package version. See [installation and removal](docs/install.md).
- Added the [Keepgoing guide](WHY-KEEPGOING.md) and illustrated command examples. The MIT-licensed package includes runtime files, documentation, and checkout helpers; it excludes tests and internal development notes.
