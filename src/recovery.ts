// The usage APIs are private provider interfaces; failures must never trigger an unsafe retry.
export type Provider = "openai-codex" | "anthropic" | "claude-bridge";
const minute = 60_000;
const buffer = 90_000;
const maxWait = 6 * 60 * minute;
const exclusions = /auth|api.key|credential|billing|credit|payment|context.window|token.limit|model|network|timeout|tool|server|internal.error|subscription.required|\bmonthly\b|\bweekly\b|\bapi.usage\b/i;
const windowSignal = /\b(?:five[ -]?hour|5[ -]?hour|five_hour|session[ -]?window)\b/i;
const usageLimit = /(?:usage|subscription).{0,60}(?:limit|window|exhaust|quota)|(?:limit|window|exhaust|quota).{0,60}(?:usage|subscription)/i;
const resetSignal = /\b(?:reset(?:s|ting)?|try again|available again)\b/i;
// Match an assertion about the cap itself, not e.g. “you've reached 80% of your usage limit”.
const capExhausted = /\b(?:usage (?:is |has been )?exhausted|(?:usage|subscription|five[ -]hour|5[ -]hour)(?:[ _-]usage)?[ _-](?:limit|quota|window)(?: (?:has been|is|was))?[ _-](?:reached|hit|exhausted|exceeded|depleted))\b/i;
const exhaustedCap = /\byou(?:['’]ve| have)? (?:hit|reached|exhausted|exceeded) (?:your|the) (?:chatgpt(?: plus| pro)? |claude )?(?:(?:5|five)[ -]hour |session |subscription )?(?:usage )?(?:limit|quota|window)\b(?![ -](?:warning[ -])?threshold\b)/i;
// Exhaustion is recognised only in an exact, known shape. Anything else fails closed and
// schedules nothing, so an unlisted wording can never authorize an unrequested Continue.
const questionMark = /[?？؟‽﹖¿]/;
const capacityWord = /\b(?:remain\w*|left|unused|spare|balance|percent|unlimited|plenty|lots|(?<!learn\s)more|still|continue)\b|%/i;
// Warnings and conditions describe a limit that has not been reached yet.
// A stated reset beyond the five-hour window belongs to another limit; never schedule against it.
const farReset = new RegExp([
  String.raw`(?:\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|few|several)\s*(?:days?|weeks?|months?)`,
  String.raw`(?:next|this|later this|after the)\s+(?:week|weekend|month)`,
  String.raw`(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|tonight|overnight|fortnight`,
  String.raw`(?:[6-9]|\d{2,})(?:\.\d+)?\s*(?:hours?|hrs?|h)|(?:six|seven|eight|nine|ten|eleven|twelve|twenty[ -]four)\s*(?:hours?|hrs?)`,
  String.raw`(?:3[6-9]\d|[4-9]\d\d|\d{4,})\s*(?:minutes?|mins?)`,
].map(part => String.raw`\b(?:${part})\b`).join("|"), "i");
const warningWord = /\b(?:warnings?|alerts?|notices?|threshold|level|soon|shortly|upcoming|caution|heads[ -]up|almost|nearly|nearing|approaching|close to)\b/i;
const unitWord = /\b(?:requests?|reqs?|messages?|msgs?|prompts?|turns?|tokens?|credits?|quer(?:y|ies)|calls?|conversations?|chats?|responses?|completions?|uses)\b/i;
// Numbers are explained only by the window label or by a time that follows a reset or
// retry phrase; any other number or count word means capacity may remain.
const windowLabel = /\b(?:5|five)[ _-]?hours?\b/gi;
const zone = String.raw`\s*(?:\((?:[A-Z][A-Za-z_]*\/)+[A-Za-z_+\-0-9]+\)|\(?(?:UTC|GMT)(?:\s*[+-]\s*\d{1,2}(?::?\d\d)?)?\)?)`;
const timeValue = String.raw`(?:\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?)?(?:Z|[+-]\d\d:?\d\d)?|1\d{9}(?:\d{3})?|\d{1,2}(?::\d\d){0,2}\s*[ap]\.?\s*m\.?(?![a-z])|\d{1,2}:\d\d(?::\d\d)?|(?:\d+(?:\.\d+)?|an?|a few|several|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty|sixty)\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)(?![a-z])|\d+h(?:\s*\d+m)?(?![a-z]))`;
const resetTime = new RegExp(String.raw`\b(?:resets?(?:\s+(?:time|will be|is))?|try(?:ing)? again|retry|available again)(?:\s+(?:at|in|after|on|from))?\s*[:=]?\s*${timeValue}(?:${zone})?(?:\s*(?:,|and)?\s*${timeValue}(?:${zone})?)*`, "gi");
const knownNumbers = [resetTime, windowLabel, /\bsome time\b/gi];
const anyCount = /\p{N}|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|dozens?|hundreds?|thousands?|millions?|couple|many|handful|some|several|a few)\b/iu;
// The only unit wording allowed is a reset hint with no count: “Messages will be available again”.
const resetHint = /(?:^|[.;:!]\s*|\s—\s)(?:requests|messages)\s+(?:(?:will\s+be|are)\s+)?available again\b/gi;
const mentionsUnit = (text: string) => unitWord.test(text.replace(resetHint, " "));
const hasUnexplainedCount = (text: string) => anyCount.test(knownNumbers.reduce((rest, known) => rest.replace(known, " "), text));
function hasExhaustion(text: string): boolean {
  return text.split(/[;!()\n]|\.(?=\s|$)/).some(clause => {
    const claim = exhaustedCap.exec(clause) ?? capExhausted.exec(clause);
    if (!claim) return false;
    const prefix = clause.slice(0, claim.index);
    // Only window labels attached to the claim conflict; a daily summary elsewhere does not.
    const suffix = clause.slice(claim.index + claim[0].length);
    if (/\b(?:daily|per[ -]day|(?!5[ -]hour)\d+[ -](?:hour|day))[ -]+$/i.test(prefix) ||
      /^\s+for (?:today|the day|the week)\b/i.test(suffix)) return false;
    if (/^\s+when you use all\b/i.test(suffix)) return false;
    if (/\b(?:when|whenever|after|if|before|until|unless|once|whether|have|has|is|was|did|do|does)\b/i.test(prefix)) return false;
    // “Depleted by <amount>” describes a change, not an empty quota.
    return !/\bdepleted\s+by\b/i.test(clause);
  });
}
// The whole Bridge report must be: optional `Error:`, optional five_hour header, one
// exhaustion assertion and an optional `· resets <time> (<Area/City>)`. Nothing else.
const bridgeHeader = /^Claude (?:rate limit|quota exceeded\s*[—–-]\s*rate limit) \(five_hour\)\s*(?:[—–-]\s*resets (?:at )?\d{1,2}:\d{2}(?::\d{2})?\s*[ap]m\s*)?[:—–-]?\s*/i;
const bridgeAssertion = String.raw`(?:you(?:['’]ve| have) hit your (?:session|(?:5|five)[ -]hour) limit|you(?:['’]re| are) out of extra usage|(?:your )?(?:session limit (?:reached|exceeded)|session (?:usage )?exhausted|extra usage (?:limit (?:reached|exceeded)|exhausted)))`;
// Exactly the reset shape bridgeResetFromText can resolve: hour, optional minutes, am/pm and an Area/City zone.
const bridgeReset = String.raw`(?:\s*[·•]\s*resets\s+(?:1[0-2]|0?[1-9])(?::[0-5]\d)?(?:am|pm)\s*\([A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+\))?`;
const bridgeBody = new RegExp(String.raw`^${bridgeAssertion}${bridgeReset}\s*\.?$`, "i");
const rawBridge = new RegExp(String.raw`^you(?:['’]ve| have) hit your (?:5|five)[ -]hour limit${bridgeReset}\s*\.?$`, "i");
export function classifyLimit(provider: string, text: string): provider is Provider {
  if (provider === "claude-bridge") {
    if (exclusions.test(text)) return false;
    const message = text.trim().replace(/^Error:\s*/i, "");
    const header = bridgeHeader.exec(message);
    return header ? bridgeBody.test(message.slice(header[0].length)) : rawBridge.test(message);
  }
  return (provider === "openai-codex" || provider === "anthropic") && !exclusions.test(text) &&
    usageLimit.test(text) && (windowSignal.test(text) || resetSignal.test(text)) &&
    !questionMark.test(text) && !warningWord.test(text) && !farReset.test(text) && !capacityWord.test(text) && !mentionsUnit(text) && !hasUnexplainedCount(text) && hasExhaustion(text);
}
// Broader signals are diagnostic only: never use them to authorize a continuation.
export function isUnrecognizedUsageLimit(provider: string, text: string): boolean {
  return (provider === "claude-bridge" || provider === "openai-codex" || provider === "anthropic") &&
    !exclusions.test(text) && !/\bwarning\b|\b\d{1,2}%/i.test(text) && !classifyLimit(provider, text) &&
    (usageLimit.test(text) || windowSignal.test(text) || /\brate[ -]limit\b/i.test(text));
}
export function boundedDeadline(timestamp: number, now: number): number | undefined {
  const deadline = timestamp + buffer;
  return Number.isFinite(deadline) && deadline > now && deadline - now <= maxWait ? deadline : undefined;
}
export function resetFromText(text: string, now = Date.now()): number | undefined {
  const instants = /\b(?:\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)|1\d{9})\b/gi;
  const instruction = /\b(?:reset(?:s|ting)?|try again|retry|available(?: again)?|(?:reached|exhausted|exceeded) until)(?:[ _-](?:time|timestamp))?(?:[ _-]is)?(?:[ _-](?:at|after|on|from))?[\s"':=]*$/i;
  const labelledReset = /\b(?:reset\s+(?:(?:is\s+)?scheduled\s+for\s+|\(UTC\)\s*:\s*)|next\s+reset\s+will\s+be\s+at\s+)$/i;
  const metadata = /\b(?:logged|observed|reported|recorded|window started)\s+(?:at\s+)?$/i;
  let reset: number | undefined;
  let end = 0;
  for (const { 0: instant, index } of text.matchAll(instants)) {
    const prefix = text.slice(end, index);
    end = index + instant.length;
    const epoch = /^\d+$/.test(instant);
    if (!instruction.test(prefix) && !labelledReset.test(prefix) && (epoch || text.trim() !== instant)) {
      // An unlabelled alternative to a reset is ambiguous, unlike a leading log timestamp.
      if (reset !== undefined && !metadata.test(prefix)) return undefined;
      continue;
    }
    const candidate = epoch ? Number(instant) * 1000 : Date.parse(instant);
    if (reset !== undefined && reset !== candidate) return undefined;
    reset = candidate;
  }
  return reset === undefined ? undefined : boundedDeadline(reset, now);
}
// Bridge errors print a zoned wall-clock minute, not an ISO instant. Search beyond
// the six-hour deadline only to detect a repeated local date/minute during a clock rollback.
// The later occurrence is safe even when the provider meant the earlier one.
// `from` is the instant to search forward from: the error time when known, otherwise now.
export function bridgeResetFromText(text: string, from = Date.now()): number | undefined {
  // Minutes are optional: the bridge prints "resets 4pm" on the hour and "resets 4:30pm" otherwise.
  const matches = [...text.matchAll(/\bresets\s+(\d{1,2})(?::(\d{2}))?(am|pm)\s*\(([A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)\)/gi)];
  if (matches.length !== 1) return undefined;
  const [, hours, minutes, period, zone] = matches[0];
  const hour = Number(hours), minuteOfHour = Number(minutes ?? 0);
  if (hour < 1 || hour > 12 || minuteOfHour > 59) return undefined;
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  catch { return undefined; }
  const targetHour = (hour % 12) + (period.toLowerCase() === "pm" ? 12 : 0);
  let candidate: number | undefined;
  let date: string | undefined;
  for (let instant = Math.floor(from / minute) * minute + minute; instant <= from + maxWait + 24 * 60 * minute; instant += minute) {
    const parts = formatter.formatToParts(instant);
    if (Number(parts.find(part => part.type === "hour")?.value) !== targetHour ||
      Number(parts.find(part => part.type === "minute")?.value) !== minuteOfHour) continue;
    const localDate = ["year", "month", "day"].map(type => parts.find(part => part.type === type)?.value).join("-");
    if (date === undefined) date = localDate;
    if (localDate === date) candidate = instant;
  }
  return candidate === undefined ? undefined : boundedDeadline(candidate, from);
}
export function fallbackDeadline(attempt: number, now = Date.now()): number {
  return now + [10, 20, 40, 60][Math.min(Math.max(0, attempt), 3)] * minute;
}
export function parseWait(text: string): number | undefined {
  const match = /^(\d+)(m|h)$/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]) * (match[2] === "h" ? 60 : 1) * minute;
  return value > 0 && value <= maxWait ? value : undefined;
}

interface OAuthRegistry {
  isUsingOAuth?: (model: unknown) => boolean;
  getApiKeyForProvider: (provider: string) => Promise<string | undefined>;
}
interface UsageResponse { ok: boolean; json(): Promise<unknown> }
type Request = (url: string, init: RequestInit) => Promise<UsageResponse>;
function accountId(jwt: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    const value = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof value === "string" && /^[\w-]+$/.test(value) ? value : undefined;
  } catch { return undefined; }
}
function parseProviderReset(provider: Exclude<Provider, "claude-bridge">, json: unknown): number | undefined {
  if (!json || typeof json !== "object") return undefined;
  const value = provider === "openai-codex"
    ? (json as any).rate_limit?.primary_window?.reset_at
    : (json as any).five_hour?.resets_at;
  if (provider === "openai-codex") return typeof value === "number" ? value * 1000 : undefined;
  return typeof value === "string" ? Date.parse(value) : undefined;
}
export async function resolveReset(provider: Provider, text: string, registry: OAuthRegistry,
  request: Request = fetch, now = Date.now(), model?: unknown, errorAt?: number, signal?: AbortSignal): Promise<number | undefined> {
  if (signal?.aborted) return undefined;
  // Claude Bridge tokens must never be sent to either provider's private API.
  // The bridge prints a wall-clock time, so resolve it relative to when the error happened.
  if (provider === "claude-bridge") return bridgeResetFromText(text, errorAt ?? now);
  const fromError = resetFromText(text, now);
  if (fromError) return fromError;
  // Only Pi-managed OAuth tokens may be sent to these private usage endpoints.
  try {
    if (model && (typeof model !== "object" || (model as { provider?: string }).provider !== provider)) return undefined;
    if (typeof registry.isUsingOAuth !== "function" || !registry.isUsingOAuth(model)) return undefined;
    const token = await registry.getApiKeyForProvider(provider);
    if (!token || signal?.aborted) return undefined;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const url = provider === "openai-codex" ? "https://chatgpt.com/backend-api/wham/usage" : "https://api.anthropic.com/api/oauth/usage";
    if (provider === "openai-codex") {
      const account = accountId(token);
      if (account) headers["ChatGPT-Account-Id"] = account;
    } else headers["anthropic-beta"] = "oauth-2025-04-20";
    const timeout = AbortSignal.timeout(8000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await request(url, { headers, signal: requestSignal });
    if (!response.ok || requestSignal.aborted) return undefined;
    const body = await response.json();
    if (requestSignal.aborted) return undefined;
    const reset = parseProviderReset(provider, body);
    return reset === undefined ? undefined : boundedDeadline(reset, now);
  } catch { return undefined; }
}
