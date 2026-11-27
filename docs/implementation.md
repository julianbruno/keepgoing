# Developer guide

Use deterministic tests for scheduling and safety logic; reserve live sessions for provider and native power-management checks. See [architecture](architecture.md) for the recovery flow and [verification status](manual-test-todo.md) for what has actually been observed.

## Code and test map

| Path | Responsibility |
| --- | --- |
| `src/inhibitor.ts` | Owner leases, system-only platform backends, owned-process cleanup, backend-loss notification. |
| `src/recovery.ts` | Conservative classification, reset parsing, bounded deadlines, private OAuth usage adapters. |
| `extensions/keepgoing.ts` | The `/jb:keepgoing` command (Resume arguments and the independent `inhibit` subcommand), lifecycle/state restoration, guards, reports, continuation dispatch and context filtering. |
| `tests/inhibitor.test.ts` | Fake process ownership, backend arguments, cleanup and loss handling. |
| `tests/recovery.test.ts` | Provider classification, reset parsing, OAuth adapter behavior and wait bounds. |
| `tests/extension.test.ts` | Manual command wiring and extension lifecycle. |
| `tests/install.test.ts` | Isolated shell helpers through a fake Pi CLI: declared/resolved paths, personal scope, dry-run and list failure. |
| `tests/package.test.ts` | npm metadata/license and actual dry-run contents, runtime imports and documentation links. |
| `tests/keepgoing.test.ts` | Resume behavior with fake Pi, clocks, branch state, prompts and continuation dispatch. |

Run the suite with:

```sh
npm test
```

For a focused run, substitute a filename from the table:

```sh
node --experimental-strip-types --test tests/recovery.test.ts
```

These tests fake child processes, usage endpoints, clocks, Pi events and senders. Passing them does not prove native macOS/Windows behavior, live provider responses, or model acceptance. Package tests run `npm pack --dry-run` without network installation, archive creation or publication. Installer tests stub Pi and platform commands; they do not modify personal settings. Real installation and PowerShell/native-platform verification remain separate operations.

## Provider adapter contracts

| Provider | Reset source / fallback endpoint | Response field |
| --- | --- | --- |
| `openai-codex` | Absolute error reset first; otherwise `https://chatgpt.com/backend-api/wham/usage` | `rate_limit.primary_window.reset_at` (Unix seconds) |
| `anthropic` | Absolute error reset first; otherwise `https://api.anthropic.com/api/oauth/usage` | `five_hour.resets_at` (ISO time) |
| `claude-bridge` | Error text only: `resets h[:mm]am/pm (IANA zone)`, minutes optional (`resets 4pm`) | No endpoint or token lookup |

Codex/Anthropic fallback requires the current provider's Pi-managed OAuth model and token through `modelRegistry.isUsingOAuth()` and `getApiKeyForProvider()`. Requests use Bearer authorization; Codex may add `ChatGPT-Account-Id` from the JWT, and Anthropic adds `anthropic-beta: oauth-2025-04-20`. No auth files are read and non-OAuth keys are not sent to these private endpoints. Missing data or lookup failure schedules nothing. No credential or endpoint payload is persisted.

Bridge accepts both `Claude rate limit (five_hour)` and `Claude quota exceeded — rate limit (five_hour)`, with explicit session/five-hour/extra-usage exhaustion. Raw `You've hit your 5-hour limit` also qualifies; optional `Error:`, curly apostrophes, `5 hour`/`five-hour`, and quota-wrapper dash variants are supported. Nothing else may appear in a Bridge report: extra advice, a count or a question schedules nothing. Codex/Anthropic reports that mention a count, a unit such as requests or messages, remaining capacity, a warning or a question also schedule nothing. No city is a default: the resolver reads the zone from the error, while the report formats the resulting instant in Pi’s local zone. Manual waits add a duration directly to the current timestamp. [Worked example](commands.md#timezones-and-waits). It requires one valid printed zoned reset; minutes are optional, so `resets 4pm` means 4:00pm. `recover()` passes the error message's `timestamp` (when finite and not in the future) to `resolveReset()`, and the minute scan starts from that time rather than from now. A buffered reset at or before now that passed no more than six hours ago schedules the continuation at now + 5 seconds with the `resetPassed` headline; an older one records `provider reset is unavailable`. The minute scan handles overnight resets and chooses the later repeated local date/minute after DST rollback; invalid zones/times or deadlines outside the buffered six-hour bound fail closed. All provider resets add 90 seconds before applying the bound.

## State and concurrency invariants

- Activation inspects only the latest active-branch message, never an older error behind newer messages. It uses the settled recovery path and tracks consumed failures to avoid duplicate scheduling. Because Bridge resets are anchored on that message's timestamp, a late `on` or an `on` after `/reload` can find the reset already passed and continue after 5 seconds, within the six-hour stale bound.
- Asynchronous reset lookups recheck pending state and generation before enqueue. Cancellation/restoration aborts each lookup and invalidates its generation. The adapter checks for cancellation after credential retrieval, fetch, and body parsing; fetch combines caller cancellation with its eight-second timeout. The legacy fallback field remains for compatibility, not as a speculative scheduling policy.
- `wait` borrows the session lease for a runtime-only timer. It never writes an enabled preference. Dispatch and cancellation release that lease unless explicit monitoring is on. Failed acquisition or rejected enqueue grants no new ownership and does not disturb a valid timer or manual lease.
- Unexpected helper loss disables Resume, persists off, cancels timers and releases listeners/headless waits. Late events from an old helper must not disable its replacement.
- TUI/RPC remain interactive during waits. Print/JSON `agent_settled` waits block until dispatch/cancellation; retroactive slash activation skips scheduling there. Standalone command waits cannot keep a single-shot process alive after command return.

The custom session-state key belongs to keepgoing. State saved by an installation under an earlier package name is not read, so each session must opt in again with `/jb:keepgoing on`. Pending jobs and sanitized diagnostic outcomes are runtime-only and are never migrated. Restoration can reacquire a lease for saved enabled state, but never recreates a timer.

## Reports and submission history

`on`, `status`, and `off` share the friendly report. Activation without an error clears stale attempt diagnostics and explains automatic monitoring. Newly settled supported errors emit the schedule or rejection report after recovery, unless cancellation/navigation invalidated the attempt. Unknown limit-like errors are console diagnostics only, deduplicated by error object with a runtime `WeakSet`; the UI points to the console and the original error text is not persisted in session entries. `status` returns before restoration, persistence, provider queries, or scheduling. A pending timer stays primary even after a rejected replacement. The legacy continuation counter remains compatible with saved state but is not a scheduling guard or a displayed budget; counts above twelve restore normally. Sleep-protection wording depends on the actual scoped lease. See [report semantics](commands.md#reading-the-report) for the user-facing format.

`lastResume` is written **before** dispatch for the existing five-minute repeat guard; it is not success evidence. After `sendUserMessage` returns without a synchronous throw, `lastContinuationAt` captures the actual clock and `lastContinuationSession` identifies the captured timer owner. A synchronous session switch records nothing. Restore accepts only a finite, Date-representable timestamp owned by the current session; forks/different sessions cannot import it. `off` preserves valid history.

Pi's sender dispatches asynchronously: a later error can follow the recorded call. Do not describe this timestamp as guaranteed acceptance, model start, or completion. Tests cover late dispatch, repeated submissions, synchronous failure, session switching, malformed/legacy state, same-session reload, fork isolation and read-only reports.

## Maintenance checklist

When changing recovery, preserve owner isolation, cancellation, exhaustion-only automatic recovery, the five-minute provider repeat guard, and the six-hour buffered deadline bound. Exercise invalid input and rejected replacement paths as well as happy paths. Update [commands](commands.md) when command behavior or reports change; keep release history in [CHANGELOG](../CHANGELOG.md), not rollback journals in this guide.
