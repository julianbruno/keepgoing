import { createInhibitor } from "../src/inhibitor.ts";
import { classifyLimit, isUnrecognizedUsageLimit, parseWait, resolveReset, type Provider } from "../src/recovery.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** Final report paragraph naming the installed package version; never throws. */
export function packageVersionLine(manifest: URL = new URL("../package.json", import.meta.url)) {
  try {
    const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown } | null)?.version;
    if (typeof version === "string" && version) return `keepgoing ${version}`;
  } catch { /* fall through to the unknown marker */ }
  return "keepgoing (version unknown)";
}
const versionLine = packageVersionLine();

const commandName = "jb:keepgoing";
const options = ["on", "off", "status", "now", "wait", "inhibit"].map(value => ({ value, label: value }));
const inhibitOptions = ["on", "off", "status"].map(value => ({ value: `inhibit ${value}`, label: value }));
// Fresh identity: saved legacy state is not restored, so resume needs a new opt-in.
const key = "keepgoing.resume";
const abortedKey = "keepgoing.abortedFailure";
// A Claude Bridge reset that passed at most this long ago still continues on its own.
const STALE_RESET_MS = 6 * 60 * 60_000;
// Delay before continuing when the Claude Bridge window already reset.
const PASSED_RESET_DELAY_MS = 5_000;
const decisions = new Set(["ask_user_choice", "ask_user_question"]);
type Controller = ReturnType<typeof createInhibitor>;
interface TimerOptions {
  now(): number;
  schedule(fire: () => void, delay: number): unknown;
  cancel(timer: unknown): void;
  resolve?: typeof resolveReset;
}
const clock: TimerOptions = {
  now: Date.now,
  schedule: (fire, delay) => setTimeout(fire, delay),
  cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
interface State {
  enabled: boolean; resumes: number; fallback: number; lastResume: number;
  lastContinuationAt?: number;
  lastContinuationSession?: string;
}
const validDate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
type FailureFields = Partial<Record<"role" | "stopReason" | "timestamp" | "provider" | "errorMessage", unknown>>;
function sameFailure(a: FailureFields, b: FailureFields) {
  return a === b || (a.role === "assistant" && b.role === "assistant" && a.stopReason === "error" && b.stopReason === "error" &&
    validDate(a.timestamp) && a.timestamp === b.timestamp && a.provider === b.provider && a.errorMessage === b.errorMessage);
}
function localTimestamp(value: number) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = new Date(value);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", year: "numeric" }).format(date);
  return `${time} · ${day} · ${zone}`;
}
// A fork can copy the header ID verbatim. Don't put a local filesystem path in branch records.
function sessionIdentity(ctx: ExtensionContext) {
  const id = ctx.sessionManager.getSessionId();
  const file = ctx.sessionManager.getSessionFile?.();
  return id && file ? createHash("sha256").update(JSON.stringify([id, file])).digest("hex") : "";
}
const initial = (): State => ({ enabled: false, resumes: 0, fallback: 0, lastResume: 0 });

export function createExtension(inhibitor: Controller, platform: NodeJS.Platform = process.platform, timer: TimerOptions = clock) {
  return (pi: ExtensionAPI) => {
    let state = initial();
    let session = "";
    let pending: { session: string; deadline: number; reason: "timed wait" | "provider reset"; resetPassed?: boolean; failure?: object } | undefined;
    let timeout: unknown;
    let tick: unknown;
    let unsubscribeTerminal: (() => void) | undefined;
    let resolveHeadlessWait: (() => void) | undefined;
    let promptDepth = 0;
    const activeDecisions = new Set<string>();
    let lastError: { provider: Provider; text: string; message: object; takenOver?: boolean } | undefined;
    const abortedFailures = new WeakSet<object>();
    const abortedEntryIds = new Set<string>();
    const failureEntries = new WeakMap<object, string>();
    let retryFailure: object | undefined;
    let consumedFailure: object | undefined;
    let generation = 0;
    let activeContext: ExtensionContext | undefined;
    let unsubscribeLoss: (() => void) | undefined;
    const owner = () => `session:${session}`;
    const hasLease = () => inhibitor.active && inhibitor.has(owner());
    function persist() { if (session) pi.appendEntry(key, { ...state, consentOwner: session }); }
    function notify(ctx: ExtensionContext, text: string, level: "info" | "error" | "warning" = "info") {
      if (ctx.hasUI) ctx.ui.notify(text, level);
    }
    // Runtime-only, sanitized observations: never persisted and never recomputed by status.
    let outcome: { kind: "not scheduled" | "cancelled" | "sent"; reason: string; next: string } | undefined;
    function record(kind: NonNullable<typeof outcome>["kind"], reason: string, next?: string) {
      const offAdvice = "Resume is off. Use /jb:keepgoing on to monitor usage limits, or schedule another one-off wait.";
      next ??= kind === "sent" ? (state.enabled ? "Resume will monitor for another usage limit. Use /jb:keepgoing off if you no longer need it." : offAdvice)
        : reason.includes("prompt") || reason.includes("decision") ? "Answer the human prompt, then explicitly schedule a new wait if needed."
        : reason.includes("busy") || reason.includes("queued") ? "Let the agent settle and queued messages finish, then retry."
        : state.enabled ? "Wait for a new eligible exhaustion or use /jb:keepgoing wait <1h|24m>." : offAdvice;
      outcome = { kind, reason, next };
    }
    // Describe markers, never their matched text or associated values. This prefix
    // is only for display; the eligibility checks still see the entire error.
    function debugMarkers(text: string) {
      const prefix = text.slice(0, 512);
      const family = /\brate[ -]limit\b/i.test(prefix) ? "rate-limit"
        : /\b(?:usage|subscription)[ -](?:limit|quota)\b/i.test(prefix) ? "usage-limit" : "unknown";
      const window = /\b(?:five|5)[ _-]?hour\b/i.test(prefix) ? "five-hour"
        : /\bsession[ -]?window\b/i.test(prefix) ? "session" : "unknown";
      const reset = /\b(?:reset(?:s|ting)?|try again|available again)\b/i.test(prefix) ? "present" : "absent";
      return ` family=${family} window=${window} reset-marker=${reset}`;
    }
    const reportedErrors = new WeakSet<object>();
    function diagnoseUnknown(ctx: ExtensionContext, message: { provider: string; errorMessage?: string }, announce = false) {
      const { provider, errorMessage } = message;
      if (!state.enabled || typeof errorMessage !== "string" || !isUnrecognizedUsageLimit(provider, errorMessage)) return false;
      record("not scheduled", "unrecognized usage-limit error; see the console summary",
        "Keep Resume on for a supported error, or use /jb:keepgoing wait <1h|24m> to choose a delay.");
      if (!reportedErrors.has(message)) {
        reportedErrors.add(message);
        // isUnrecognizedUsageLimit checks the exact provider allowlist above.
        const summary = `keepgoing: provider=${provider} reason=unrecognized_usage_limit`;
        const details = process.env.KEEPGOING_DEBUG === "1" ? debugMarkers(errorMessage) : "";
        console.warn((summary + details).slice(0, 160));
        if (announce) notify(ctx, report(ctx), "warning");
      }
      return true;
    }
    const resetLookups = new Map<AbortController, object>();
    function guard(ctx: ExtensionContext, requireEnabled = true): string | undefined {
      if (requireEnabled && !state.enabled) return "resume is off";
      if (promptDepth) return "a UI prompt is open";
      if (activeDecisions.size) return "a human decision is pending";
      if (!session || sessionIdentity(ctx) !== session) return "session navigation changed the session";
      if (!ctx.isIdle()) return "the agent is busy";
      if (ctx.hasPendingMessages()) return "messages are queued";
    }
    const retryStatus = () => {
      if (!pending) return "no recovery scheduled";
      const seconds = Math.max(0, Math.ceil((pending.deadline - timer.now()) / 1000));
      return `retry scheduled at ${new Date(pending.deadline).toTimeString().slice(0, 5)} local; ${pending.reason}; deadline ${new Date(pending.deadline).toString()} (${new Date(pending.deadline).toISOString()}); remaining ${seconds}s (${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s)`;
    };
    function friendlyDetail(text: string) {
      return text.replaceAll("sleep inhibitor backend", "system-sleep protection")
        .replaceAll("sleep inhibitor acquisition failed", "system-sleep protection could not start")
        .replaceAll("reacquire the lease", "restore system-sleep protection")
        .replaceAll("provider reset is unavailable", "Claude's usage reset time is unavailable")
        .replaceAll("provider reset is stale", "Claude's usage reset passed more than six hours ago")
        .replaceAll("latest branch message is not an eligible exhaustion", "the latest message does not report a supported usage limit")
        .replaceAll("latest branch failure was already consumed", "the latest usage-limit error was already handled")
        .replaceAll("enqueue rejected: ", "")
        .replaceAll("continuation enqueue failed", "Pi could not accept the continuation")
        .replaceAll("continuation submitted through the user prompt pipeline", "the continuation was sent to Pi")
        .replaceAll("eligible exhaustion", "supported usage-limit error");
    }
    // First report line: the Resume state at a glance.
    function headline(waiting: typeof pending | false, enabled: boolean, last: typeof outcome) {
      if (waiting) {
        if (waiting.reason === "timed wait") return enabled ? "⏳ Resume is ON. Waiting for your requested time." : "⏳ Resume is OFF. Waiting for your requested time only.";
        return waiting.resetPassed ? "⏳ Resume is ON. Claude's usage window already reset; continuing in a few seconds."
          : "⏳ Resume is ON. Waiting for Claude's usage window to reset.";
      }
      if (!enabled) return "⏸ Resume is OFF. Nothing is scheduled.";
      // The detail paragraph below says why (an error, a rejected wait, a guard).
      if (last?.kind === "not scheduled") return "⚠️ Resume is ON, but nothing was scheduled.";
      return "✅ Resume is ON and watching for Claude's 5-hour usage limit. Nothing is scheduled yet.";
    }
    function report(ctx: ExtensionContext) {
      const scoped = !!session && session === sessionIdentity(ctx);
      const enabled = scoped && state.enabled;
      const waiting = scoped && pending;
      const last = scoped ? outcome : undefined;
      const parts = [headline(waiting, enabled, last)];
      if (waiting) {
        // Round up in the selected unit: minutes from 60s, seconds below 60s.
        const remaining = Math.max(0, waiting.deadline - timer.now());
        const minutes = Math.ceil(remaining / 60_000);
        const countdown = remaining < 60_000 ? `${Math.max(1, Math.ceil(remaining / 1000))}s`
          : minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${minutes}m`;
        parts.push(`Continue at: ${localTimestamp(waiting.deadline)}\nTime remaining: ${countdown}`);
      }
      if (scoped && state.lastContinuationSession === session && validDate(state.lastContinuationAt)) {
        parts.push(`Last continuation at: ${localTimestamp(state.lastContinuationAt)}`);
      }
      if (enabled || waiting) parts.push(`${scoped && hasLease()
        ? "Your computer will stay awake (the screen can still turn off)."
        : "Warning: Resume is not keeping your computer awake."} Keep this Pi session open: timers end when you exit or reload Pi.`);
      if (last) {
        const detail = friendlyDetail(last.reason);
        parts.push(last.kind === "cancelled" ? `Previous wait cancelled ${detail}.`
          : last.kind === "sent" ? `Previously: ${detail}.`
          : `${waiting ? "The new attempt was not scheduled" : "No continuation was scheduled"}: ${detail}.`);
        parts.push(`Next: ${friendlyDetail(last.next)}`);
      } else if (!waiting) parts.push(enabled
        ? "Next: nothing to do. When Claude reports its 5-hour limit, Resume schedules the continuation and shows when it will run. To choose a delay yourself: /jb:keepgoing wait <1h|24m>."
        : "Next: /jb:keepgoing on to turn it on, or /jb:keepgoing wait <1h|24m> for a one-off delay.");
      if (waiting) parts.push("Cancel with /jb:keepgoing off or Escape.");
      parts.push(versionLine);
      return parts.join("\n\n");
    }
    function status(ctx: ExtensionContext) {
      if (ctx.mode !== "tui") return;
      const remaining = pending ? Math.max(0, Math.ceil((pending.deadline - timer.now()) / 60_000)) : 0;
      ctx.ui.setStatus(key, pending ? `keepgoing ⏳ resumes in ${remaining}m` : state.enabled ? "keepgoing ✅ resume on" : undefined);
    }
    function clearTimer() {
      if (timeout !== undefined) { timer.cancel(timeout); timeout = undefined; }
      if (tick !== undefined) { timer.cancel(tick); tick = undefined; }
    }
    // A valid replacement inherits the existing session lease. All other stops
    // release it unless explicit monitoring still owns it.
    function clearWork() {
      generation++;
      for (const lookup of resetLookups.keys()) lookup.abort();
      resetLookups.clear();
      if (unsubscribeTerminal) { unsubscribeTerminal(); unsubscribeTerminal = undefined; }
      pending = undefined;
      clearTimer();
      if (resolveHeadlessWait) { const resolve = resolveHeadlessWait; resolveHeadlessWait = undefined; resolve(); }
    }
    function cancel(ctx: ExtensionContext, reason?: string) {
      if (reason && (pending || resetLookups.size)) record("cancelled", reason);
      if (pending && !state.enabled) inhibitor.release(owner());
      clearWork();
      status(ctx);
    }
    function schedule(ctx: ExtensionContext) {
      try { armTimer(ctx); }
      catch (error) {
        cancel(ctx, "because timer setup failed");
        throw error;
      }
    }
    function armTimer(ctx: ExtensionContext) {
      if (!pending) return;
      if (!hasLease()) { failClosed(ctx); return; }
      clearTimer();
      const current = pending;
      const version = generation;
      const remaining = current.deadline - timer.now();
      if (ctx.mode === "tui" && !unsubscribeTerminal) {
        unsubscribeTerminal = ctx.ui.onTerminalInput(data => {
          if (data !== "\u001b") return undefined;
          cancel(ctx, "by Escape");
          return { consume: true };
        });
      }
      timeout = timer.schedule(() => {
        timeout = undefined;
        if (version !== generation || pending !== current) return;
        if (timer.now() < current.deadline) { schedule(ctx); return; }
        if (!hasLease()) { failClosed(ctx); return; }
        const blocked = guard(ctx, current.reason === "provider reset");
        if (blocked || current.session !== session) {
          cancel(ctx, `because ${blocked ?? "session navigation changed the session"}`);
          return;
        }
        cancel(ctx);
        state.resumes++;
        state.lastResume = timer.now();
        retryFailure = current.failure;
        persist();
        try {
          pi.sendUserMessage(current.reason === "timed wait" ? "Continue" : "Continue the interrupted request after the provider usage window reset. Do not make decisions for the user.", { expandPromptTemplates: false });
          // lastResume above is a pre-send repeat guard, not proof of success.
          // Attribute only to the owning session; a synchronous switch skips history.
          const sentAt = timer.now();
          if (session === current.session && sessionIdentity(ctx) === session && validDate(sentAt)) {
            state.lastContinuationAt = sentAt;
            state.lastContinuationSession = current.session;
            persist();
          }
          record("sent", "continuation submitted through the user prompt pipeline");
        } catch (error) {
          record("not scheduled", "continuation enqueue failed", "Inspect Pi availability and continue manually or schedule a new wait.");
          throw error;
        }
      }, Math.min(Math.max(0, remaining), 60_000));
      if (ctx.mode === "tui") tick = timer.schedule(() => { tick = undefined; status(ctx); if (pending === current && version === generation) schedule(ctx); }, Math.min(Math.max(1000, remaining), 60_000));
      status(ctx);
    }
    function enqueue(ctx: ExtensionContext, deadline: number, failure?: object, resetPassed = false) {
      if (!hasLease()) { failClosed(ctx); return false; }
      const blocked = guard(ctx, Boolean(failure));
      if (blocked || (failure && pending)) {
        record("not scheduled", `enqueue rejected: ${failure && pending ? "a timer already exists" : blocked}`);
        return false;
      }
      if (deadline <= timer.now() || deadline - timer.now() > 6 * 60 * 60_000) {
        record("not scheduled", "enqueue rejected: deadline is outside the future six-hour window", "Use /jb:keepgoing wait <1h|24m> with a duration up to 6h.");
        return false;
      }
      if (!failure) clearWork(); // Replace only after the new requested wait passes every guard.
      pending = { session, deadline, reason: failure ? "provider reset" : "timed wait", ...(resetPassed ? { resetPassed } : {}), failure };
      outcome = undefined;
      if (failure) consumedFailure = failure;
      schedule(ctx);
      return Boolean(pending);
    }
    function failClosed(ctx: ExtensionContext) {
      if (!state.enabled && !pending) return;
      cancel(ctx, "because the sleep inhibitor backend was lost");
      record("cancelled", "because the sleep inhibitor backend was lost", "Check the backend, then use /jb:keepgoing on to reacquire the lease.");
      if (state.enabled) { state.enabled = false; persist(); }
      // Keep the unsettled entry for abort bookkeeping, never for scheduling.
      if (lastError) lastError.takenOver = true;
      retryFailure = undefined;
      status(ctx);
      const message = "keepgoing resume disabled: sleep inhibitor backend was lost.";
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      else console.error(message);
    }
    function watchLoss(ctx: ExtensionContext) {
      activeContext = ctx;
      if (unsubscribeLoss) return;
      unsubscribeLoss = inhibitor.onLoss?.(affected => {
        const current = activeContext;
        if (current && affected.includes(owner()) && sessionIdentity(current) === session) failClosed(current);
      });
    }
    function restore(ctx: ExtensionContext, treeNavigation = false) {
      watchLoss(ctx);
      cancel(ctx);
      inhibitor.release(owner());
      const next = sessionIdentity(ctx);
      // Navigation invalidates recovery but settlement may still need to mark this failure aborted.
      if (treeNavigation && next === session && lastError) lastError.takenOver = true;
      else lastError = undefined;
      session = next;
      outcome = undefined;
      state = initial();
      abortedEntryIds.clear();
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === abortedKey && typeof entry.data === "string") abortedEntryIds.add(entry.data);
      }
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === key && entry.data && typeof entry.data === "object") {
          const data = entry.data as Partial<State> & { consentOwner?: string; consentSession?: string };
          if (typeof data.enabled === "boolean" && Number.isInteger(data.resumes) && data.resumes! >= 0) {
            if (session && data.consentOwner === session) {
              state.enabled = data.enabled;
              state.resumes = data.resumes!;
              state.fallback = Number.isInteger(data.fallback) ? Math.max(0, data.fallback!) : 0;
              state.lastResume = typeof data.lastResume === "number" ? data.lastResume : 0;
            }
            if (session && data.consentOwner === undefined && data.consentSession === ctx.sessionManager.getSessionId()
                && validDate(data.lastResume) && data.lastResume <= timer.now()) {
              state.lastResume = Math.max(state.lastResume, data.lastResume);
            }
            const historyOwner = data.consentOwner === undefined ? ctx.sessionManager.getSessionId() : session;
            if (session && data.lastContinuationSession === historyOwner && validDate(data.lastContinuationAt)) {
              state.lastContinuationAt = data.lastContinuationAt;
              state.lastContinuationSession = session;
            }
          }
        }
      }
      if (state.enabled) {
        try { inhibitor.acquire(owner()); }
        catch { state.enabled = false; record("not scheduled", "sleep inhibitor acquisition failed", "Check the sleep inhibitor backend, then use /jb:keepgoing on."); persist(); }
      }
      retryFailure = undefined;
      consumedFailure = undefined;
      status(ctx);
    }
    // Independent manual lease: never touches resume state, timers, or the session lease.
    function inhibit(arg: string, ctx: ExtensionContext) {
      watchLoss(ctx);
      switch (arg) {
        case "on":
          try { notify(ctx, inhibitor.acquire("manual") ? "Sleep inhibitor enabled." : "Sleep inhibitor is already active."); }
          catch (error) { notify(ctx, `Sleep inhibition unavailable: ${String(error)}`, "error"); }
          break;
        case "off": notify(ctx, inhibitor.release("manual") ? "Sleep inhibitor disabled." : "Sleep inhibitor is already inactive."); break;
        case "status": notify(ctx, inhibitor.has("manual") ? "Sleep inhibitor is active." : "Sleep inhibitor is inactive."); break;
        default: notify(ctx, "Usage: /jb:keepgoing inhibit on|off|status", "warning");
      }
    }
    pi.registerCommand(commandName, {
      description: "Watch usage limits (on), schedule one Continue without enabling monitoring (wait <1h|24m>), manage recovery (off, status, now), or keep the system awake (inhibit on|off|status)",
      getArgumentCompletions: prefix => {
        const matches = (/^inhibit\s/.test(prefix) ? inhibitOptions : options)
          .filter(({ value }) => value.startsWith(prefix.replace(/^inhibit\s+/, "inhibit ")));
        return matches.length ? matches : null;
      },
      handler: async (arg, ctx) => {
        const inhibitArg = /^inhibit(?:\s+(.*))?$/s.exec(arg.trim());
        if (inhibitArg) { inhibit((inhibitArg[1] ?? "").trim(), ctx); return; }
        const command = arg.trim() || "on";
        if (command === "status") { notify(ctx, report(ctx)); return; }
        if (!session || session !== sessionIdentity(ctx)) restore(ctx);
        else watchLoss(ctx);
        if (!session && (command === "on" || command.startsWith("wait "))) {
          notify(ctx, "Resume needs a saved Pi session to identify its owner. Nothing was scheduled.", "warning");
          return;
        }
        if ((state.enabled || pending) && !hasLease()) failClosed(ctx);
        if (command === "on") {
          if (!state.enabled) {
            try { inhibitor.acquire(owner()); }
            catch { record("not scheduled", "sleep inhibitor acquisition failed", "Check the sleep inhibitor backend, then use /jb:keepgoing on."); notify(ctx, report(ctx), "error"); return; }
            state.enabled = true;
            persist();
          }
          // A slash command in a single-shot runtime cannot keep its timer alive.
          // Only agent_settled may block print/JSON until its recovery deadline.
          if (!pending && ctx.mode !== "print" && ctx.mode !== "json") {
            const branch = ctx.sessionManager.getBranch();
            const latest = [...branch].reverse().find(entry => entry.type === "message");
            const message = latest?.type === "message" ? latest.message : undefined;
            if (lastError && (message === lastError.message || (latest?.id && latest.id === failureEntries.get(lastError.message)))) {
              // agent_end isn't a settlement: a user abort can still follow.
              outcome = undefined;
            } else if (message && (message === consumedFailure || abortedFailures.has(message) || (latest && abortedEntryIds.has(latest.id)))) {
              record("not scheduled", "latest branch failure was already consumed");
            } else if (message?.role === "assistant" && message.stopReason === "error" &&
              typeof message.errorMessage === "string" && classifyLimit(message.provider, message.errorMessage)) {
              const version = generation;
              if (latest?.id) failureEntries.set(message, latest.id);
              await recover(ctx, { provider: message.provider as Provider, text: message.errorMessage, message });
              if (version !== generation) return;
            } else if (message?.role === "assistant" && message.stopReason === "error") {
              if (typeof message.errorMessage !== "string" || !diagnoseUnknown(ctx, message)) {
                record("not scheduled", "latest branch message is not an eligible exhaustion");
              }
            } else outcome = undefined;
          } else if (!pending) record("not scheduled", "retroactive recovery is not scheduled in print/JSON mode", "Keep Pi open; only a newly settled exhaustion can wait in this mode.");
          notify(ctx, report(ctx), outcome?.kind === "not scheduled" ? "warning" : "info");
        } else if (command === "off") {
          // Only claim a cancellation when a wait actually existed.
          const hadWait = Boolean(pending);
          cancel(ctx, "by /jb:keepgoing off");
          if (hadWait) record("cancelled", "by /jb:keepgoing off", "Use /jb:keepgoing on to monitor usage limits, or /jb:keepgoing wait <1h|24m> for a one-off delay.");
          else outcome = undefined;
          state.enabled = false;
          inhibitor.release(owner());
          persist();
          notify(ctx, report(ctx));
        } else if (command === "now") {
          if (!pending || promptDepth || activeDecisions.size) notify(ctx, "No safe pending recovery.", "warning");
          else { pending.deadline = timer.now() + 1; schedule(ctx); notify(ctx, "Recovery requested."); }
        } else if (command.startsWith("wait ")) {
          const delay = parseWait(command.slice(5).trim());
          if (!delay || promptDepth || activeDecisions.size ||
            !ctx.isIdle() || ctx.hasPendingMessages()) {
            record("not scheduled", !delay ? "wait duration is invalid (maximum 6h)" : guard(ctx, false) ?? "wait rejected",
              !delay ? "Provide a positive whole-number duration in minutes or hours, up to 6h." : undefined);
            notify(ctx, `No safe wait scheduled.\n${report(ctx)}`, "warning");
          } else {
            if (!state.enabled && !pending) {
              try {
                inhibitor.acquire(owner());
                if (!hasLease()) throw Error("Resume lease unavailable");
              } catch {
                inhibitor.release(owner());
                record("not scheduled", "sleep inhibitor acquisition failed", "Check the sleep inhibitor backend, then retry the wait.");
                notify(ctx, report(ctx), "error");
                return;
              }
            }
            if (enqueue(ctx, timer.now() + delay)) {
              notify(ctx, `${state.enabled ? "Resume wait scheduled" : "One-off wait scheduled (Resume is OFF)"}; ${retryStatus()}. Pi must stay open.`);
            } else {
              if (!state.enabled && !pending) inhibitor.release(owner());
              notify(ctx, `No safe wait scheduled.\n${report(ctx)}`, "warning");
            }
          }
        } else notify(ctx, "Usage: /jb:keepgoing [on|off|status|now|wait <1h|24m>] or /jb:keepgoing inhibit on|off|status", "warning");
        status(ctx);
      },
    });
    pi.on("session_start", (_event, ctx) => restore(ctx));
    pi.on("session_shutdown", (event, ctx) => {
      cancel(ctx, "by session shutdown");
      if (unsubscribeLoss) { unsubscribeLoss(); unsubscribeLoss = undefined; }
      activeContext = undefined;
      inhibitor.release(owner());
      if (event.reason === "quit") inhibitor.release("manual");
    });
    pi.on("session_before_switch", (_event, ctx) => { cancel(ctx, "by session navigation"); inhibitor.release(owner()); });
    pi.on("session_tree", (_event, ctx) => restore(ctx, true));
    pi.on("input", (event, ctx) => { if (event.source !== "extension") { cancel(ctx, "by user input"); if (lastError) lastError.takenOver = true; } });
    pi.on("ui_prompt_start", (_event, ctx) => { promptDepth++; cancel(ctx, "because a UI prompt opened"); });
    pi.on("ui_prompt_end", () => { promptDepth = Math.max(0, promptDepth - 1); });
    pi.on("tool_execution_start", (event, ctx) => { if (decisions.has(event.toolName)) { activeDecisions.add(event.toolCallId); cancel(ctx, "because a human decision opened"); } });
    pi.on("tool_execution_end", event => { if (decisions.has(event.toolName)) activeDecisions.delete(event.toolCallId); });
    pi.on("agent_end", (event, ctx) => {
      const message = event.messages.at(-1);
      lastError = message?.role === "assistant" && message.stopReason === "error" &&
        typeof message.errorMessage === "string" && classifyLimit(message.provider, message.errorMessage)
        ? { provider: message.provider as Provider, text: message.errorMessage, message } : undefined;
      if (lastError && message?.role === "assistant") {
        const latest = ctx.sessionManager.getBranch().findLast(entry => entry.type === "message");
        if (latest?.type === "message" && latest.id && sameFailure(latest.message, message)) {
          failureEntries.set(message, latest.id);
        }
      }
      if (!lastError && message?.role === "assistant" && message.stopReason === "error" &&
        typeof message.errorMessage === "string") diagnoseUnknown(ctx, message, true);
    });
    async function recover(ctx: ExtensionContext, error: { provider: Provider; text: string; message: object }) {
      if (state.enabled && !hasLease()) { failClosed(ctx); return; }
      if (!state.enabled || pending || promptDepth || activeDecisions.size ||
        session !== sessionIdentity(ctx) || !ctx.isIdle() || ctx.hasPendingMessages()) {
        record("not scheduled", pending ? "a timer already exists" : guard(ctx) ?? "recovery guard rejected the attempt");
        return;
      }
      const now = timer.now();
      // An immediate repeat within five minutes is a loop, not a fresh exhaustion event.
      const lastSubmission = state.lastContinuationAt ?? 0;
      const last = Math.max(state.lastResume, lastSubmission <= now ? lastSubmission : 0);
      if (last && now - last < 300_000) { record("not scheduled", "five-minute repeat guard rejected the attempt", "Wait at least five minutes after the last resume before a new exhaustion attempt."); return; }
      const version = generation;
      const lookup = new AbortController();
      resetLookups.set(lookup, error.message);
      let reset: number | null | undefined;
      // Anchor wall-clock resets ("resets 4pm") to when the error happened, not to now:
      // after a reload or a late /jb:keepgoing on, that reset may already be in the past.
      const errorAt = (error.message as { timestamp?: unknown }).timestamp;
      const anchor = typeof errorAt === "number" && Number.isFinite(errorAt) && errorAt <= now ? errorAt : undefined;
      try { reset = await (timer.resolve ?? resolveReset)(error.provider, error.text, ctx.modelRegistry, fetch, now, ctx.model, anchor, lookup.signal); }
      finally { resetLookups.delete(lookup); }
      if (abortedFailures.has(error.message) || version !== generation || session !== sessionIdentity(ctx) || !state.enabled || pending ||
        promptDepth || activeDecisions.size) return;
      if (!hasLease()) { failClosed(ctx); return; }
      // Never guess a reset: exhaustion without a usable deadline requires human action.
      if (reset == null) {
        record("not scheduled", "provider reset is unavailable", "Use /jb:keepgoing wait <1h|24m> for an explicit delay.");
        return;
      }
      // Only Claude Bridge resets are anchored on the error timestamp, so only they can
      // legitimately be in the past. A passed reset at most STALE_RESET_MS old means the
      // window is open again; older is stale. Other providers keep failing closed in enqueue.
      const resetPassed = error.provider === "claude-bridge" && reset <= now;
      if (resetPassed && now - reset > STALE_RESET_MS) {
        record("not scheduled", "provider reset is stale", "Use /jb:keepgoing wait <1h|24m> for an explicit delay.");
        return;
      }
      const deadline = resetPassed ? now + PASSED_RESET_DELAY_MS : reset;
      if (ctx.mode === "json" || ctx.mode === "print") {
        // Single-shot Pi modes dispose the extension when this handler returns.
        // Keep the settled handler alive until the continuation or cancellation.
        await new Promise<void>(resolve => {
          resolveHeadlessWait = resolve;
          if (!enqueue(ctx, deadline, error.message, resetPassed)) {
            resolveHeadlessWait = undefined;
            resolve();
          }
        });
      } else enqueue(ctx, deadline, error.message, resetPassed);
    }
    pi.on("agent_settled", async (event, ctx) => {
      if (retryFailure) retryFailure = undefined;
      const error = lastError;
      lastError = undefined;
      if (event.aborted) {
        const failures = new Set(resetLookups.values());
        if (error) failures.add(error.message);
        if (pending?.failure) failures.add(pending.failure);
        if (pending?.failure || resetLookups.size) cancel(ctx);
        // Consent is branch-local, but a discarded failure must stay discarded when revisited.
        const ids = new Set<string>();
        for (const message of failures) {
          abortedFailures.add(message);
          const known = failureEntries.get(message);
          if (known) ids.add(known);
          else for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.id && sameFailure(entry.message, message)) ids.add(entry.id);
          }
        }
        for (const id of ids) if (!abortedEntryIds.has(id)) {
          pi.appendEntry(abortedKey, id);
          abortedEntryIds.add(id);
        }
        return;
      }
      if (error && !error.takenOver && !abortedFailures.has(error.message) &&
        !abortedEntryIds.has(failureEntries.get(error.message) ?? "") && state.enabled) {
        const version = generation;
        await recover(ctx, error);
        // Do not announce stale lookups after takeover, navigation, or shutdown.
        if (version === generation && state.enabled && session === sessionIdentity(ctx)) {
          notify(ctx, report(ctx), pending ? "info" : "warning");
        }
      }
    });
    pi.on("context", event => retryFailure ? { messages: event.messages.filter(message => message !== retryFailure &&
      !(message.role === "assistant" && message.stopReason === "error" && message.errorMessage && classifyLimit(message.provider, message.errorMessage))) } : undefined);
    pi.on("agent_start", () => { lastError = undefined; });
  };
}

const registryKey = Symbol.for("keepgoing.inhibitor.controller");
export function getProcessInhibitor<T>(scope: object, factory: () => T): T {
  const registry = scope as Record<symbol, T | undefined>;
  return registry[registryKey] ??= factory();
}
export default createExtension(getProcessInhibitor(globalThis, createInhibitor));
