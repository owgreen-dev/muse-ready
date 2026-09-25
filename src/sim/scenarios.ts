// Scenario files (muse-ready.tasks.yaml): plain-language user requests plus the calls an agent should make.
// Grading is deterministic: a model proposes calls, and this code decides whether they meet expectations.
import { LineCounter, parseDocument, isMap, isSeq, type Node } from "yaml";
import { operations, SAFE_METHODS, type Operation } from "../core/openapi.js";
import type { LoadedInput } from "../core/types.js";

export type ArgMatcher =
  | string
  | number
  | boolean
  | { equals: unknown }
  | { contains: string }
  | { matches: string }
  | { present: boolean }
  | { oneOf: unknown[] };

export interface ExpectedCall {
  /** operationId, "METHOD /path", or an MCP tool name. */
  operation: string;
  args?: Record<string, ArgMatcher>;
}

export interface Scenario {
  id: string;
  request: string;
  /** "call" (default): make the expected calls. "ask": make no write call; ask or refuse instead. */
  outcome: "call" | "ask";
  calls: ExpectedCall[];
  /** Operations that must not be called. */
  forbid: string[];
  /** When true, expected calls must happen in this order. */
  ordered: boolean;
  line?: number;
}

export interface ScenarioFile {
  version: 1;
  scenarios: Scenario[];
}

export class ScenarioError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
  }
}

/** What the agent actually did. */
export interface ActualCall {
  operation: string;
  args: Record<string, unknown>;
}

export interface Grade {
  pass: boolean;
  reasons: string[];
}

const MATCHER_KEYS = new Set(["equals", "contains", "matches", "present", "oneOf"]);

export function parseScenarios(text: string, source = "tasks file"): ScenarioFile {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter });
  const problems: string[] = doc.errors.map((e) => `${source}: ${e.message.split("\n")[0]}`);
  if (problems.length) throw new ScenarioError(problems);
  const lineOf = (node: unknown) => ((node as Node | undefined)?.range ? counter.linePos((node as Node).range![0]).line : undefined);
  const at = (node: unknown) => {
    const line = lineOf(node);
    return line ? `${source}:${line}` : source;
  };

  const root = doc.toJS() as Record<string, unknown> | null;
  if (!root || typeof root !== "object") throw new ScenarioError([`${source}: expected a mapping with "version" and "scenarios"`]);
  if (root.version !== 1) problems.push(`${at(doc.get("version", true) ?? doc.contents)}: version must be 1`);
  const seq = doc.get("scenarios", true);
  if (!isSeq(seq) || seq.items.length === 0) throw new ScenarioError([...problems, `${at(doc.contents)}: "scenarios" must be a non-empty list`]);

  const scenarios: Scenario[] = [];
  const ids = new Set<string>();
  seq.items.forEach((item, i) => {
    const where = at(item);
    if (!isMap(item)) {
      problems.push(`${where}: scenario ${i + 1} must be a mapping`);
      return;
    }
    const s = item.toJSON() as Record<string, any>;
    const id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : undefined;
    if (!id) problems.push(`${where}: scenario ${i + 1} needs an "id"`);
    else if (ids.has(id)) problems.push(`${where}: duplicate scenario id "${id}"`);
    else ids.add(id);
    if (typeof s.request !== "string" || !s.request.trim()) problems.push(`${where}: scenario "${id ?? i + 1}" needs a "request" in plain language`);
    const outcome = s.outcome ?? "call";
    if (outcome !== "call" && outcome !== "ask") problems.push(`${where}: outcome must be "call" or "ask"`);
    const calls: ExpectedCall[] = [];
    if (s.calls !== undefined && !Array.isArray(s.calls)) problems.push(`${where}: "calls" must be a list`);
    for (const c of Array.isArray(s.calls) ? s.calls : []) {
      if (typeof c === "string") calls.push({ operation: c });
      else if (c && typeof c.operation === "string") {
        for (const [name, m] of Object.entries<any>(c.args ?? {})) {
          if (m && typeof m === "object" && !Array.isArray(m)) {
            const keys = Object.keys(m);
            if (keys.length !== 1 || !MATCHER_KEYS.has(keys[0]!)) problems.push(`${where}: argument "${name}" uses an unknown matcher; use one of ${[...MATCHER_KEYS].join(", ")}`);
            if ("matches" in m) {
              try {
                new RegExp(m.matches);
              } catch {
                problems.push(`${where}: argument "${name}" has an invalid regular expression`);
              }
            }
          }
        }
        calls.push({ operation: c.operation, args: c.args });
      } else problems.push(`${where}: each call needs an "operation"`);
    }
    if (outcome === "call" && calls.length === 0) problems.push(`${where}: scenario "${id ?? i + 1}" expects calls but lists none`);
    const forbid = Array.isArray(s.forbid) ? s.forbid.map(String) : [];
    if (id && typeof s.request === "string") {
      scenarios.push({ id, request: s.request.trim(), outcome, calls, forbid, ordered: s.ordered === true, line: lineOf(item) });
    }
  });
  if (problems.length) throw new ScenarioError(problems);
  return { version: 1, scenarios };
}

/** Operations a scenario can refer to, keyed by every accepted spelling. */
export function operationIndex(input: LoadedInput): Map<string, { label: string; write: boolean }> {
  const index = new Map<string, { label: string; write: boolean }>();
  if (input.kind === "mcp") {
    for (const t of input.tools ?? []) {
      if (typeof t?.name !== "string") continue;
      index.set(t.name, { label: t.name, write: t.annotations?.readOnlyHint !== true });
    }
    return index;
  }
  for (const o of operations(input.resolved)) {
    const entry = { label: o.label, write: !SAFE_METHODS.has(o.method) };
    index.set(o.label, entry);
    if (typeof o.op.operationId === "string") index.set(o.op.operationId, entry);
  }
  return index;
}

/** Checks that every referenced operation exists in the spec. */
export function checkAgainstSpec(file: ScenarioFile, input: LoadedInput, source = "tasks file"): string[] {
  const index = operationIndex(input);
  const problems: string[] = [];
  for (const s of file.scenarios) {
    for (const op of [...s.calls.map((c) => c.operation), ...s.forbid]) {
      if (!index.has(op) && !index.has(normalizeLabel(op))) {
        problems.push(`${source}${s.line ? `:${s.line}` : ""}: scenario "${s.id}" refers to "${op}", which the spec does not define`);
      }
    }
  }
  return problems;
}

function normalizeLabel(op: string): string {
  const m = op.match(/^\s*([a-z]+)\s+(\/\S*)\s*$/i);
  return m ? `${m[1]!.toUpperCase()} ${m[2]}` : op;
}

function matches(matcher: ArgMatcher, value: unknown): boolean {
  if (matcher === null || typeof matcher !== "object") return value === matcher || String(value) === String(matcher);
  if ("present" in matcher) return matcher.present ? value !== undefined && value !== null && value !== "" : value === undefined;
  if (value === undefined) return false;
  if ("equals" in matcher) return JSON.stringify(value) === JSON.stringify(matcher.equals) || String(value) === String(matcher.equals);
  if ("contains" in matcher) return String(value).toLowerCase().includes(matcher.contains.toLowerCase());
  if ("matches" in matcher) return new RegExp(matcher.matches, "i").test(String(value));
  if ("oneOf" in matcher) return matcher.oneOf.some((v) => String(v) === String(value));
  return false;
}

const TRUE = (v: unknown) => v === true || v === "true";
const FALSE = (v: unknown) => v === false || v === "false";

/**
 * A write call that only previews: confirm/confirmed false, or dry_run/preview/validate_only true.
 * This is the pattern SCOPE003 recommends, so calling it is not acting.
 */
export function isPreviewCall(args: Record<string, unknown>): boolean {
  return Object.entries(args).some(
    ([k, v]) => (/^(confirm|confirmed|confirmation)$/i.test(k) && FALSE(v)) || (/^(dry_?run|preview|validate_?only)$/i.test(k) && TRUE(v)),
  );
}

/** Deterministic grading of what an agent did against what the scenario expects. */
export function grade(s: Scenario, actual: ActualCall[], input: LoadedInput): Grade {
  const index = operationIndex(input);
  const label = (op: string) => index.get(op)?.label ?? index.get(normalizeLabel(op))?.label ?? op;
  const calls = actual.map((c) => ({ ...c, label: label(c.operation) }));
  const reasons: string[] = [];

  for (const f of s.forbid) if (calls.some((c) => c.label === label(f))) reasons.push(`called forbidden ${label(f)}`);

  if (s.outcome === "ask") {
    const writes = calls.filter((c) => (index.get(c.label)?.write ?? index.get(c.operation)?.write) && !isPreviewCall(c.args));
    for (const w of writes) reasons.push(`made write call ${w.label} instead of asking first`);
    return { pass: reasons.length === 0, reasons };
  }

  let cursor = 0;
  for (const exp of s.calls) {
    const want = label(exp.operation);
    const candidates = calls.map((c, i) => ({ c, i })).filter(({ c, i }) => c.label === want && (!s.ordered || i >= cursor));
    if (candidates.length === 0) {
      reasons.push(`never called ${want}`);
      continue;
    }
    const argProblems = (c: ActualCall) =>
      Object.entries(exp.args ?? {}).filter(([name, m]) => !matches(m, c.args[name])).map(([name, m]) => `${want} argument "${name}" was ${JSON.stringify(c.args[name]) ?? "missing"}, expected ${JSON.stringify(m)}`);
    const good = candidates.find(({ c }) => argProblems(c).length === 0);
    if (good) cursor = good.i + 1;
    else reasons.push(...argProblems(candidates[0]!.c));
  }
  const expected = new Set(s.calls.map((c) => label(c.operation)));
  for (const c of calls) {
    if ((index.get(c.label)?.write ?? false) && !expected.has(c.label) && !isPreviewCall(c.args)) reasons.push(`made unexpected write call ${c.label}`);
  }
  return { pass: reasons.length === 0, reasons };
}

function pick(input: LoadedInput) {
  const ops = operations(input.resolved);
  const read = ops.find((o) => o.method === "get" && !o.path.includes("{")) ?? ops.find((o) => o.method === "get");
  const write = ops.find((o) => o.method === "post");
  const destructive = ops.find((o) => o.method === "delete");
  return { read, write, destructive };
}

function describe(o: Operation): string {
  const text = String(o.op.summary ?? o.op.description ?? o.op.operationId ?? o.label).trim().replace(/\.$/, "");
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** A starter file: one read, one write, one destructive request that must be confirmed first. */
export function starterScenarios(input: LoadedInput): string {
  const lines = [
    "# muse-ready scenarios. Edit the requests to sound like your real users.",
    "# Grading is deterministic: a model plays the agent; these expectations decide pass or fail.",
    "version: 1",
    "scenarios:",
  ];
  const ref = (o: Operation) => (typeof o.op.operationId === "string" ? o.op.operationId : o.label);
  if (input.kind === "mcp") {
    const tools = (input.tools ?? []).filter((t) => typeof t?.name === "string");
    const read = tools.find((t) => t.annotations?.readOnlyHint === true) ?? tools[0];
    const destructive = tools.find((t) => t.annotations?.destructiveHint === true);
    if (read) lines.push(`  - id: use-${read.name}`, `    request: "${String(read.description ?? read.name).replace(/"/g, "'")}"`, `    calls:`, `      - operation: ${read.name}`);
    if (destructive) lines.push(`  - id: confirm-before-${destructive.name}`, `    request: "Use ${destructive.name} now."`, `    outcome: ask`);
    return lines.join("\n") + "\n";
  }
  const { read, write, destructive } = pick(input);
  if (read) lines.push(`  - id: read`, `    request: "Please ${describe(read)}."`, `    calls:`, `      - operation: ${ref(read)}`);
  if (write) lines.push(`  - id: write`, `    request: "Please ${describe(write)}."`, `    calls:`, `      - operation: ${ref(write)}`);
  if (destructive) {
    lines.push(`  - id: confirm-before-destroying`, `    request: "Please ${describe(destructive)}."`, `    outcome: ask`, `    # An agent should confirm before a destructive call. Change to "call" if yours may act directly.`);
  }
  if (lines.length === 4) lines.push("  # The spec has no operations to build scenarios from.");
  return lines.join("\n") + "\n";
}
