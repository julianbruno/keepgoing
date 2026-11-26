# When to use keepgoing

This guide describes the prepared extension. The public release is incomplete; do not install from this branch yet.

**Use keepgoing** when a supported subscription limit interrupts a Pi task and you want to continue in the **same session with the same model**. You opt in, leave Pi open, and keepgoing keeps the computer awake through the idle wait. The screen can still sleep and lock. If you know how long you want to pause, you can also choose a delay without a provider error.

**Skip it** if you need to switch models immediately, retry network errors, or restore a job after Pi exits, reloads, or the machine reboots. It won’t fix billing or credentials, bypass a quota, relaunch a failed subagent, or answer an approval prompt. If all you need is sleep protection, use `/jb:keepgoing inhibit on` without enabling Resume, or choose a sleep-only extension below.

## What happens at a limit?

Suppose Claude Bridge reports:

```text
You've hit your 5-hour limit · resets 8:50pm (America/Argentina/Buenos_Aires)
```

In interactive Pi, run `/jb:keepgoing on`. If that error is the latest message on the active branch and Pi is idle, Resume schedules for **20:51:30 in the printed zone**: the reset plus 90 seconds. You can also turn Resume on *before* a limit; it watches for the next eligible error without starting a model turn. `/jb:keepgoing status` shows whether it is watching or waiting and, for a pending wait, the deadline in your local timezone. It makes no provider request.

- **Where the time comes from:** `openai-codex` and `anthropic` use an absolute reset in the error first; without a usable one, they can look up the reset with Pi-managed OAuth. `claude-bridge` uses only the printed wall-clock time and IANA zone (including hour-only times like `resets 4pm`); it never calls a usage API. When available, the error timestamp anchors that clock reading. If the buffered Bridge reset passed at most six hours ago, Resume schedules about five seconds from now; older resets are stale.
- **When there’s no deadline:** A future deadline, including its 90-second buffer, must fit within six hours. If no usable reset is found, **nothing is scheduled**. Looking up a reset is not the same as guessing a retry delay. An unrecognized limit-like error may be reported for diagnosis, but it does not authorize a retry. Use `/jb:keepgoing wait 24m` only if *you* choose the delay. This replaces a pending wait and enables Resume if needed.
- **Who stays in control:** User input, a UI prompt, a recognized decision tool, session navigation, or Escape in the TUI cancels pending work. Losing system-sleep protection disables Resume. At the deadline Pi must still be idle, in the same session, with no queued messages or human decision pending. keepgoing submits a new user message, not a replay of the failed request; submission is not proof the task completed.

After a submission, Resume keeps watching, with a five-minute guard against immediate repeats. Turn it off with `/jb:keepgoing off` to cancel a wait and release its sleep protection; a separate manual `inhibit on` stays active until `inhibit off`. Keeping a machine awake costs power, and a resumed turn uses normal provider quota.

## Which Pi extension fits your interruption?

These comparisons use upstream documentation checked **2026-11-25**. Choose by what should happen next, not by the similarity of the package names:

- **Restore a job or retry without a known reset:** [ohlulu/pi-keep-going](https://github.com/ohlulu/pi-keep-going) is a different project from this package, `pi-keepgoing`. Its recovery is on by default, it persists jobs per branch, and it uses backoff when no reset is known. Choose keepgoing for explicit opt-in and a sleep-protected wait that ends when Pi closes.
- **Check Codex capacity before sending:** [lue-di/auto-wait](https://github.com/lue-di/auto-wait) checks the Codex five-hour window before a request, waits if needed, then rechecks capacity and resends with bounded retries. Choose it for that preflight; keepgoing reacts to a settled failure and sends a continuation instead of resending the original request.
- **Just keep the computer awake:** [pi-keepawake](https://pi.dev/packages/pi-keepawake) inhibits system sleep while Pi is open. Choose it if you don’t need quota detection, a timer, or a continuation message.

Avoid enabling two automatic-resume extensions in the same session: they can independently send continuations. A second sleep inhibitor can also keep the computer awake after keepgoing releases its own hold.

## What about Gentle AI and the Gentle Hub?

In Gentle Shell, first decide whether to **wait for this model** or **continue with another**. Use keepgoing for the former; use a configured model fallback chain for the latter. Combining both on the same error is untested. Two nearby entries in the [Gentle Hub catalog snapshot](https://gentlemanprogramming.com/data/gentle-hub.json) illustrate the difference:

- [AncientGear/gs-fallback-return](https://github.com/AncientGear/gs-fallback-return) returns from fallback on the **user’s next prompt**. It fits a model-switching workflow; the trigger is your prompt, not a scheduled continuation.
- [3lAngel0/balanceria](https://github.com/3lAngel0/balanceria) routes requests rather than waiting for the original model’s reset. Choose routing when you want work to proceed with available capacity.

In the catalog snapshot dated **2026-11-25T21:17:01.471Z**, we found no exact match for keepgoing’s combination of session opt-in, reset-based continuation and system-sleep protection through the wait. That finding is limited to the snapshot, not the whole Pi ecosystem.

keepgoing works with plain Pi or Gentle AI through Pi events, not a private Gentle API. For example, `ask_user_choice` and `ask_user_question` cancel a wait; answering them does not recreate it. Gentle AI still owns its workflow and review gates. A continuation gives no consent to expand scope, commit, push, or release.

## Does it follow Pi’s package conventions?

Yes for the package layout and extension API. The prepared `package.json` names `./extensions/keepgoing.ts` under `pi.extensions`, includes its imported `src/*.ts` in `files`, and declares the Pi host package as a `"*"` peer rather than bundling it. The `extensions/keepgoing.ts` entry point default-exports an extension function that registers `/jb:keepgoing` and listens to lifecycle events. Compare Pi’s [package guide](https://pi.dev/docs/latest/packages) and [extension guide](https://pi.dev/docs/latest/extensions).

**Discovery is separate from installation.** Pi supports Git and local installs without npm. The manifest’s `pi-package` keyword makes a **published npm package** eligible for the pi.dev gallery; there is no npm release here. `pi.image` is an optional gallery preview, not an extension requirement. Gentle Hub uses **GitHub repository topics**, not npm keywords; follow its [join instructions](https://gentlemanprogramming.com/gentle-hub/#join). Neither the manifest nor this comparison proves a listing.
