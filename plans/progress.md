# Ralph Progress Log

Started: 2026-09-23
Goal: v0.2.0, live probe mode and a GitHub Action, behind a security gate (see plans/prd.json).

## Codebase Patterns

- TypeScript ESM, Node 20+. `src/core` has types, loader, engine, scoring and line mapping. `src/rules` has one file per rule plus `index.ts`. `src/report` has terminal, markdown, sarif and badge output. `src/cli/index.ts` is the CLI.
- A rule implements `Rule` from `src/core/types.ts`: `run(ctx)` returns `{ status, message, findings[] }`. Findings carry a JSON `pointer`, and the engine turns it into a source line.
- `aggregate(fails, warns, messages)` in `src/rules/util.ts` collapses findings into one outcome.
- Scoring weights are critical 10, high 5, medium 3, low 1, with warn earning half credit. Any `fail` in auth, injection or network blocks the gate and exits 1.
- Tests: `test/fixtures.test.ts` holds a table of bad fixtures and the rule each must trip. `test/core.test.ts` covers units. `test/cli.test.ts` builds and runs `dist/`.
- The OpenAPI parser's own HTTP resolver fails on plain responses, so URL specs are validated from the already-fetched document.

## Key Files

- `scripts/verify.sh`: THE gate. Human-owned.
- `scripts/security-audit.mjs` and `security/policy.json`: 11 security checks and their policy. Human-owned.
- `scripts/ralph/ralph.sh`: the loop. It verifies, reverts false completions, halts on tampering and writes `plans/audit-log.md` plus `scripts/ralph/runs/<id>/audit.jsonl`.
- `.claude/hooks/guard.mjs`: blocks gate edits, pushes, publishes and credential reads while the loop runs.

---

## 2026-09-23 - T-001 report wording (done interactively, not by the loop)

**Changed:** `src/rules/util.ts` gains `all()` ("The 1 X" / "All N Xs") and `agree()` for verb agreement. Every rule message and the terminal footer now use them. META001 reports "N required fields missing, M recommended".
**Tests:** `test/wording.test.ts` renders every fixture in terminal, Markdown and SARIF and rejects "(s)" and "All 1 ". Suite: 71 tests.
**Learned:** the loop never ran any task. `~/.zshrc` exports `CLAUDE_CODE_OAUTH_TOKEN` as the whole keychain credentials JSON, so every headless session got 401. Tasks are being done in an interactive session instead.
