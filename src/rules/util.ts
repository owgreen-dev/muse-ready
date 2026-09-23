import type { Finding, RuleOutcome } from "../core/types.js";
import { splitWords } from "../core/openapi.js";

/** Verbs that mean an operation changes state. Only the first word of a name is checked. */
export const WRITE_VERBS = new Set([
  "create", "add", "insert", "new", "update", "edit", "modify", "set", "patch", "put", "replace",
  "delete", "remove", "destroy", "purge", "erase", "drop", "clear", "reset", "cancel", "revoke",
  "archive", "send", "submit", "publish", "approve", "reject", "transfer", "pay", "charge", "refund",
  "purchase", "buy", "invite", "upload", "import", "execute", "run", "trigger", "move", "rename",
  "write", "save", "restore", "merge", "assign", "unassign", "subscribe", "unsubscribe", "enable",
  "disable", "start", "stop", "kill", "terminate", "deploy", "mark", "post",
]);

export const READ_VERBS = new Set([
  "get", "list", "fetch", "retrieve", "read", "search", "find", "query", "lookup", "show", "view",
  "count", "describe", "browse", "export",
]);

export const DESTRUCTIVE_VERBS = new Set([
  "delete", "remove", "destroy", "purge", "erase", "drop", "clear", "reset", "cancel", "revoke",
  "terminate", "kill",
]);

/** Operations whose effects leave the user's account: money, messages, public posts, deletion. */
export const HIGH_IMPACT_VERBS = new Set([
  ...DESTRUCTIVE_VERBS, "send", "email", "message", "publish", "post", "transfer", "pay", "charge",
  "refund", "purchase", "buy", "order", "book", "invite", "deploy", "execute", "trigger",
]);

export const CONFIRM_PARAM = /^(confirm|confirmed|confirmation|dry_?run|preview|validate_?only)$/i;

export function firstWord(text: unknown): string | undefined {
  return typeof text === "string" ? splitWords(text)[0] : undefined;
}

export function preview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Collapse fail and warn findings into one outcome: any fail wins, then any warn, else pass. */
export function aggregate(
  fails: Finding[],
  warns: Finding[],
  messages: { pass: string; fail: string; warn: string },
): RuleOutcome {
  if (fails.length) return { status: "fail", message: messages.fail, findings: [...fails, ...warns] };
  if (warns.length) return { status: "warn", message: messages.warn, findings: warns };
  return { status: "pass", message: messages.pass };
}

/** "1 operation", "3 operations". */
export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** "The 1 operation" for one, "All 3 operations" for more. */
export function all(n: number, word: string, pluralWord = `${word}s`): string {
  return n === 1 ? `The 1 ${word}` : `All ${n} ${pluralWord}`;
}

/** Picks the verb form that agrees with n: agree(1, "is", "are") is "is". */
export function agree(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
