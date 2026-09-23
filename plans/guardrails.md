# Ralph Guardrails (Signs)

Learned constraints that prevent repeated failures. Each "sign" is a rule discovered through iteration failures. Add new signs as you encounter failure patterns.

> "Progress should persist. Failures should evaporate." - The Ralph philosophy

---

## Verification Signs

### SIGN-001: Verify Before Complete
**Trigger:** About to output completion promise
**Instruction:** ALWAYS run the verification command (`bash scripts/verify.sh`) and confirm it passes before outputting `<promise>COMPLETE</promise>`
**Reason:** Models tend to declare victory without proper verification

### SIGN-002: Check All Tasks Before Complete
**Trigger:** Completing a task in multi-task mode
**Instruction:** Re-read prd.json and count remaining `passes: false` tasks. Only output completion promise when ALL tasks pass, not just the current one.
**Reason:** Premature completion exits loop with work remaining

---

## Progress Signs

### SIGN-003: Document Learnings
**Trigger:** Completing any task
**Instruction:** Update progress.md with what was learned (patterns discovered, files modified, decisions made) before ending iteration
**Reason:** Future iterations need context to avoid re-discovering the same patterns

### SIGN-004: Small Focused Changes
**Trigger:** Making changes per iteration
**Instruction:** Keep changes small and focused. Commit incrementally when tests pass. Don't try to solve everything in one iteration.
**Reason:** Large changes are harder to debug when verification fails

---

## Task Management Signs

### SIGN-005: Use Skip for Manual Tasks
**Trigger:** Encountering a task that requires manual human intervention (creating accounts, API keys, dashboard configuration)
**Instruction:** Set `skip: true` and `skipReason` in prd.json for tasks that cannot be automated. The Ralph loop will ignore skipped tasks and can complete without them.
**Reason:** Allows loop to complete automatable work without blocking on manual steps

### SIGN-006: Reference Task IDs in Commits
**Trigger:** Committing changes for a prd.json task
**Instruction:** Start the subject with the task ID, e.g. `feat: T-002 - safe HTTP client for probing`. There are no GitHub issues yet, so omit `Fixes #N`.
**Reason:** Auto-closes GitHub issues when merged to main, maintains traceability

---

## Project-Specific Signs

Add signs below as you encounter project-specific failure patterns:

### SIGN-P01: Never Weaken the Gate
**Trigger:** The security audit, a test or the guard hook blocks you
**Instruction:** Fix the code, not the check. Never edit scripts/verify.sh, scripts/security-audit.mjs, security/, scripts/ralph/, .claude/ or .github/workflows/, never delete or skip tests, never lower thresholds. If the policy itself is wrong, write `NEEDS HUMAN: <reason>` at the top of plans/progress.md, leave the task `passes: false`, and exit.
**Reason:** The loop halts on any change to protected files, and a gate the agent can edit proves nothing.
**Added after:** Setup, 2026-09-23

### SIGN-P02: Probe Safety Is Non-Negotiable
**Trigger:** Writing anything under src/probe/ or any code that sends HTTP requests
**Instruction:** Only GET, HEAD and OPTIONS. Resolve DNS yourself and refuse private, loopback and link-local addresses on every connection and every redirect. Cap time and bytes. Credentials go only to the exact target origin. Tests use local servers with allowPrivateNetwork explicitly on, except the test that proves private addresses are refused.
**Reason:** muse-ready will be pointed at arbitrary URLs in CI; an unsafe prober is an SSRF tool.
**Added after:** Setup, 2026-09-23

### SIGN-P03: No Network Outside the Loader and the Probe
**Trigger:** Any fetch, http, https, net, tls or dns import
**Instruction:** Put it in src/core/load.ts or src/probe/. The README promises the tool sends nothing anywhere unless you pass a URL or --probe.
**Reason:** Enforced by the audit's source-invariants check.
**Added after:** Setup, 2026-09-23

### SIGN-P04: Dependencies Are a Human Decision
**Trigger:** Wanting a new package
**Instruction:** Prefer Node built-ins. A new production dependency will fail the audit until a human approves it in security/policy.json. A dev dependency is allowed only with no new install scripts; justify it in plans/progress.md.
**Reason:** Supply-chain risk for a security tool.
**Added after:** Setup, 2026-09-23

### SIGN-P05: Rules Ship With Fixtures and Docs
**Trigger:** Adding or changing a rule
**Instruction:** One rule per file under src/rules/, registered in src/rules/index.ts, with a rationale naming its source. Add a failing case and keep fixtures/good/* passing. Regenerate the README catalog: `npm run build && node scripts/rules-doc.mjs` and paste it into the Rules section (a test checks it).
**Reason:** The fixture library is both the test suite and the documentation.
**Added after:** Setup, 2026-09-23

### SIGN-P06: Installing Packages on This Machine
**Trigger:** `npm install` fails with "Cannot read properties of null (reading 'edgesOut')"
**Instruction:** Use `npx -y npm@11 install ...`. npm 10.9's resolver crashes on vitest 4's peer dependencies. Afterwards confirm `ls node_modules/<pkg>/dist` is not empty: installs here have turned up gutted before.
**Reason:** Cost a reinstall during setup.
**Added after:** Setup, 2026-09-23

### SIGN-P07: No Pushing, Publishing or GitHub CLI
**Trigger:** Any task that seems to need a remote
**Instruction:** Commit locally only. Tasks needing a push, npm publish, gh or account access are human tasks: mark them `skip: true` with a reason.
**Reason:** Outward-facing actions need a human. The guard hook blocks them anyway.
**Added after:** Setup, 2026-09-23
