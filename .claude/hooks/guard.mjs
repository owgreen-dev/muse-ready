#!/usr/bin/env node
// PreToolUse guard for autonomous Ralph iterations in muse-ready.
// Active only when RALPH_LOOP=1 (set by scripts/ralph/ralph.sh) or a same-session loop state file exists,
// so interactive sessions are unaffected. Hooks still run under --dangerously-skip-permissions.
// Human-owned: the loop halts if this file changes.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const active = process.env.RALPH_LOOP === "1" || existsSync(resolve(project, ".claude/ralph-loop.local.md"));
if (!active) process.exit(0);

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  deny("guard could not parse hook input");
}
const tool = input.tool_name;
const args = input.tool_input ?? {};

// Paths the agent may read but never write.
const PROTECTED = [
  "scripts/verify.sh",
  "scripts/security-audit.mjs",
  "security/",
  "scripts/ralph/",
  ".claude/",
  ".github/workflows/",
  "plans/audit-log.md",
  "LICENSE",
];
// Paths the agent may not even read.
const home = homedir();
const SECRET_PATHS = [".ssh", ".aws", ".npmrc", ".netrc", ".config/gh", ".gnupg", ".docker/config.json", ".kube", "Library/Keychains"].map((p) => resolve(home, p));

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Ralph guard: ${reason}` },
    }),
  );
  process.exit(0);
}

function rel(p) {
  const abs = isAbsolute(p) ? p : resolve(project, p);
  return { abs, rel: relative(project, abs) };
}

// The loop's own runtime state files may be created and removed (e.g. by /ralph-cancel).
const LOOP_STATE = /\.claude\/ralph-[\w.-]*\.local\.(md|json)/g;

function isProtected(r) {
  if (new RegExp(`^${LOOP_STATE.source}$`).test(r)) return false;
  return PROTECTED.some((p) => (p.endsWith("/") ? r === p.slice(0, -1) || r.startsWith(p) : r === p));
}

function isSecretPath(abs) {
  return SECRET_PATHS.some((s) => abs === s || abs.startsWith(s + "/")) || /(^|\/)\.env(\.|$)/.test(abs);
}

if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const path = args.file_path ?? args.notebook_path;
  if (typeof path !== "string") deny("write without a file path");
  const { abs, rel: r } = rel(path);
  if (r.startsWith("..") || isAbsolute(r)) deny(`writing outside the project (${path})`);
  if (isProtected(r)) deny(`${r} is part of the human-owned gate. If it blocks you, write NEEDS HUMAN in plans/progress.md and stop.`);
  if (isSecretPath(abs)) deny(`writing secret files (${r})`);
  process.exit(0);
}

if (tool === "Read" || tool === "Grep" || tool === "Glob") {
  const path = args.file_path ?? args.path;
  if (typeof path === "string" && isSecretPath(rel(path).abs)) deny(`reading credentials (${path})`);
  process.exit(0);
}

if (tool === "Bash") {
  const cmd = String(args.command ?? "");
  const rules = [
    [/\bgit\s+(push|remote|config|filter-branch|filter-repo|update-ref|replace|gc|reflog\s+expire)\b/, "git history, remotes and config are off limits"],
    [/--no-verify\b|\bgit\s+commit\b[^\n]*\s-n\b/, "skipping git hooks"],
    [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\b)/, "discarding work (reset --hard, clean -f, checkout --, restore)"],
    [/\bnpm\s+(publish|unpublish|deprecate|dist-tag|owner|access|adduser|login|logout|token|config\s+set|team)\b/, "npm registry and account commands"],
    [/\b(npx|pnpm|yarn)\s+[^\n]*\bpublish\b/, "publishing"],
    [/(^|[;&|(\s])gh\s/, "the GitHub CLI"],
    [/(curl|wget)[^|\n]*\|\s*(ba|z)?sh\b/, "piping downloads into a shell"],
    [/(^|[;&|(\s])sudo\s/, "sudo"],
    [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$)/, "recursive delete of / or home"],
    [/(^|[;&|(\s])(claude|codex|aider)\s/, "spawning other agents"],
    [/--dangerously|bypassPermissions/, "bypass flags"],
    [/\bsecurity\s+(find|dump)-/, "keychain access"],
    [/(^|\s)(env|printenv|set)\s*($|[|;&>])/, "dumping environment variables"],
    [/RALPH_LOOP\s*=/, "changing loop flags"],
  ];
  for (const [re, why] of rules) if (re.test(cmd)) deny(`${why}: \`${cmd.slice(0, 120)}\``);

  for (const s of SECRET_PATHS) {
    const short = s.replace(home, "~");
    if (cmd.includes(s) || cmd.includes(short) || cmd.includes(s.replace(home, "$HOME"))) deny(`touching credentials (${short})`);
  }

  // A command that mentions a protected path may only read it.
  const scrubbed = cmd.replace(LOOP_STATE, "");
  const mentions = PROTECTED.filter((p) => scrubbed.includes(p.replace(/\/$/, "")));
  if (mentions.length) {
    const writes = /(^|[^<>&0-9])>{1,2}(?!&)|\btee\b|\bsed\b[^|;&]*\s-i|\bperl\b[^|;&]*\s-[a-z]*i|\b(mv|cp|rm|rmdir|chmod|chown|truncate|ln|touch|install|dd|patch|unlink)\b|\bgit\s+(checkout|restore|rm|mv|apply|stash)\b|writeFile|open\([^)]*['"]w/;
    if (writes.test(cmd)) deny(`this command could modify ${mentions.join(", ")}, which is part of the human-owned gate`);
  }
  process.exit(0);
}

process.exit(0);
