# How autonomous work runs in this repo

**Goal and tasks:** `prd.json`. Each task lists the criteria that make it pass. Tasks marked `skip` are for a human.

**The gate:** `scripts/verify.sh` runs typecheck, tests, build and `scripts/security-audit.mjs`. The loop runs it itself after every iteration. A task only counts as done if the gate passes. If it fails, the loop un-marks the task.

**The security audit** (policy in `security/policy.json`):

1. Known vulnerabilities (`npm audit`, any severity)
2. Lockfile: every package from registry.npmjs.org with a sha512 integrity hash
3. No unreviewed install scripts
4. No unapproved production dependencies
5. Production licenses compatible with Apache-2.0
6. Secret scan of every file git would pick up (gitleaks)
7. Source invariants: network only in the loader and probe, no child processes, no eval
8. Tests cannot be skipped or focused, and the suite cannot shrink below the policy minimum
9. The probe must ship with its named security tests
10. The npm package contains only `dist/`, README, LICENSE and package.json
11. Workflows and action.yml: actions pinned to SHAs, least-privilege permissions, no `pull_request_target`, no untrusted `${{ }}` in shell

**Containment while the loop runs:** `.claude/hooks/guard.mjs` (active only when `RALPH_LOOP=1`):

- Blocks edits to the gate, the loop, hooks, workflows and the audit log.
- Blocks `git push`, remote and config commands, `npm publish`, `gh`, `sudo`, piping downloads into a shell, and spawning other agents.
- Blocks reading or dumping credentials.

The loop also hashes the protected files and the task definitions. It halts with exit code 3 if either changes.

**Audit trail:** `plans/audit-log.md` gets one line per iteration, written by the loop and not the agent. `scripts/ralph/runs/<run>/` holds the full per-iteration record: `audit.jsonl` (commits, files changed, verify result, security failures, tasks marked passing, cost), the transcript and the verify output.

## Running it

```sh
git switch -c ralph/v0.2-probe-action      # the loop also does this from prd.json
./scripts/ralph/ralph.sh --max-iterations 12 --verbose
./scripts/ralph/ralph-status.sh --watch    # in another terminal
./scripts/ralph/ralph-stop.sh              # to stop
```

Preconditions the loop checks: a clean, committed tree, and a gate that already passes on it.

## Reviewing a run

```sh
cat plans/audit-log.md
git log --oneline <start-sha>..HEAD
jq . scripts/ralph/runs/<run>/audit.jsonl
bash scripts/verify.sh                     # re-run the gate yourself
```
