#!/bin/bash
# Ralph Loop - Fresh Context Mode
# External bash loop that spawns fresh Claude sessions for each iteration
#
# This follows Geoffrey Huntley's original vision:
# - Fresh context per iteration (no accumulated transcript)
# - File I/O as state (prd.json, progress.md, guardrails.md)
# - Deterministic setup (same files loaded every iteration)
# - Guardrails (signs) prevent repeated failures
#
# Usage:
#   ./scripts/ralph/ralph.sh [--max-iterations N] [--branch NAME] [--verbose|-v] [--monitor|-m]
#
# Based on:
# - Geoffrey Huntley's original Ralph pattern
# - Gordon Mickel's flow-next architecture
# - Anthropic's long-running agent guidance

set -euo pipefail

# ============================================
# CUSTOMIZATION - Edit these for your project
# ============================================

# Verification command - change to match your project
# Examples:
#   Node/Next.js: "pnpm verify" or "npm run test && npm run lint"
#   Python: "pytest && mypy . && ruff check ."
#   Go: "go test ./... && go vet ./..."
# muse-ready: the gate is a human-owned script and is NOT overridable from prd.json.
VERIFY_COMMAND="bash scripts/verify.sh"

# Files the agent must never change. The loop halts if their contents change.
PROTECTED_PATHS=(scripts/verify.sh scripts/security-audit.mjs security scripts/ralph .claude/hooks .claude/settings.json .claude/commands .github/workflows)
AUDIT_LOG_MD="plans/audit-log.md"

# Context files location (relative to project root)
PRD_FILE="plans/prd.json"
PROGRESS_FILE="plans/progress.md"
GUARDRAILS_FILE="plans/guardrails.md"

# ============================================
# Configuration (usually no changes needed)
# ============================================

MAX_ITERATIONS=50
BRANCH=""
VERBOSE=false
MONITOR=false
SCREENSHOT=false
STATE_FILE=".claude/ralph-state.local.md"
RUNS_DIR="scripts/ralph/runs"
STATUS_FILE=".claude/ralph-status.local.json"
PROJECT_DIR="$(pwd)"

# Token tracking (accumulated across iterations)
TOTAL_INPUT_TOKENS=0
TOTAL_OUTPUT_TOKENS=0
TOTAL_CACHE_READ=0
TOTAL_CACHE_WRITE=0
TOTAL_COST_USD=0

# ============================================
# Parse Arguments
# ============================================

while [[ $# -gt 0 ]]; do
  case $1 in
    --max-iterations)
      MAX_ITERATIONS="$2"
      shift 2
      ;;
    --branch)
      BRANCH="$2"
      shift 2
      ;;
    --verbose|-v)
      VERBOSE=true
      shift
      ;;
    --monitor|-m)
      MONITOR=true
      shift
      ;;
    --screenshot|-s)
      SCREENSHOT=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: ./ralph.sh [--max-iterations N] [--branch NAME] [--verbose|-v] [--monitor|-m] [--screenshot|-s]"
      exit 1
      ;;
  esac
done

# ============================================
# Helper Functions
# ============================================

# Verbose logging
log_verbose() {
  if [ "$VERBOSE" = true ]; then
    echo "[VERBOSE] $*"
  fi
}

# Open monitor in split pane (macOS)
open_monitor_pane() {
  if [ "$(uname)" != "Darwin" ]; then
    echo "Auto-monitor only supported on macOS. Run in another terminal:"
    echo "  ./scripts/ralph/ralph-status.sh --watch"
    return
  fi

  # Check if iTerm2 is running or installed, prefer it over Terminal
  if pgrep -x "iTerm2" > /dev/null || [ -d "/Applications/iTerm.app" ]; then
    osascript <<EOF
tell application "iTerm"
  tell current session of current window
    set newSession to (split vertically with default profile)
  end tell
  tell newSession
    write text "cd '$PROJECT_DIR' && ./scripts/ralph/ralph-status.sh --watch"
  end tell
end tell
EOF
    echo "Opened monitor in vertical split pane"
  else
    # Terminal.app doesn't support split panes, fall back to new window
    osascript <<EOF
tell application "Terminal"
  activate
  do script "cd '$PROJECT_DIR' && ./scripts/ralph/ralph-status.sh --watch"
end tell
EOF
    echo "Opened monitor in new Terminal window (split not supported)"
  fi
}

# Update status file for monitoring (uses jq for safe JSON escaping)
update_status() {
  local status="$1"
  local task_id="${2:-}"
  local task_title="${3:-}"

  jq -n \
    --arg run_id "$RUN_ID" \
    --argjson iteration "$ITERATION" \
    --argjson max_iterations "$MAX_ITERATIONS" \
    --arg status "$status" \
    --arg task_id "$task_id" \
    --arg task_title "$task_title" \
    --argjson remaining "$REMAINING_TASKS" \
    --arg started_at "$START_TIME" \
    --arg updated_at "$(date -Iseconds)" \
    --arg branch "${BRANCH:-$(git branch --show-current)}" \
    --arg log_file "$RUN_DIR/iteration-$ITERATION.txt" \
    --argjson total_input_tokens "$TOTAL_INPUT_TOKENS" \
    --argjson total_output_tokens "$TOTAL_OUTPUT_TOKENS" \
    --argjson total_cache_read "$TOTAL_CACHE_READ" \
    --argjson total_cache_write "$TOTAL_CACHE_WRITE" \
    --arg total_cost_usd "$TOTAL_COST_USD" \
    '{
      run_id: $run_id,
      iteration: $iteration,
      max_iterations: $max_iterations,
      status: $status,
      current_task: {
        id: $task_id,
        title: $task_title
      },
      remaining_tasks: $remaining,
      started_at: $started_at,
      updated_at: $updated_at,
      branch: $branch,
      log_file: $log_file,
      tokens: {
        input: $total_input_tokens,
        output: $total_output_tokens,
        cache_read: $total_cache_read,
        cache_write: $total_cache_write,
        cost_usd: $total_cost_usd
      }
    }' > "$STATUS_FILE"
}

# ============================================
# Setup
# ============================================

# Create runs directory for this session
RUN_ID=$(date +%Y%m%d-%H%M%S)
RUN_DIR="$RUNS_DIR/$RUN_ID"
START_TIME=$(date -Iseconds)
ITERATION=0
REMAINING_TASKS=0
mkdir -p "$RUN_DIR"

echo "=============================================="
echo "Ralph Loop - Fresh Context Mode"
echo "=============================================="
echo "Run ID: $RUN_ID"
echo "Max Iterations: $MAX_ITERATIONS"
echo "Branch: ${BRANCH:-<current>}"
echo "Verify: $VERIFY_COMMAND"
echo "Verbose: $VERBOSE"
echo "Monitor: $MONITOR"
echo "Screenshot: $SCREENSHOT"
echo "Status: $STATUS_FILE"
echo "Logs: $RUN_DIR/"
echo "=============================================="
echo ""

# Open monitor pane if requested
if [ "$MONITOR" = true ]; then
  open_monitor_pane
else
  echo "Monitor with: ./scripts/ralph/ralph-status.sh --watch"
  echo "Tail logs:    ./scripts/ralph/ralph-tail.sh"
fi
echo ""

log_verbose "Run directory created at $RUN_DIR"
log_verbose "Start time: $START_TIME"

# Handle branch - use from prd.json if not specified via CLI
if [ -z "$BRANCH" ] && [ -f "$PRD_FILE" ]; then
  PRD_BRANCH=$(jq -r '.branchName // .branch // empty' "$PRD_FILE")
  if [ -n "$PRD_BRANCH" ]; then
    BRANCH="$PRD_BRANCH"
    log_verbose "Using branch from prd.json: $BRANCH"
  fi
fi

if [ -n "$BRANCH" ]; then
  if git branch --list "$BRANCH" | grep -q "$BRANCH"; then
    git checkout "$BRANCH"
  else
    git checkout -b "$BRANCH"
  fi
  echo "Working on branch: $BRANCH"
fi

if [ -f "$PRD_FILE" ] && jq -e '.verifyCommand' "$PRD_FILE" > /dev/null 2>&1; then
  echo "Note: prd.json verifyCommand is ignored. The gate is always: $VERIFY_COMMAND"
fi

# Check if there are tasks to work on
if [ ! -f "$PRD_FILE" ]; then
  echo "Error: $PRD_FILE not found"
  exit 1
fi

# Count tasks that are incomplete AND not skipped
REMAINING_TASKS=$(jq '[.features[] | select(.passes == false and .skip != true)] | length' "$PRD_FILE")
SKIPPED_TASKS=$(jq '[.features[] | select(.skip == true)] | length' "$PRD_FILE")
if [ "$REMAINING_TASKS" -eq 0 ]; then
  if [ "$SKIPPED_TASKS" -gt 0 ]; then
    echo "All automatable tasks complete! ($SKIPPED_TASKS tasks skipped)"
  else
    echo "All tasks in prd.json are already complete!"
  fi
  rm -f "$STATUS_FILE"
  exit 0
fi

echo "Found $REMAINING_TASKS pending tasks"
echo ""

update_status "starting" "" ""
log_verbose "Initial task count: $REMAINING_TASKS"

# ============================================
# Integrity helpers (muse-ready)
# ============================================

protected_hash() {
  find "${PROTECTED_PATHS[@]}" -type f -not -path 'scripts/ralph/runs/*' 2>/dev/null | LC_ALL=C sort | while read -r f; do
    printf '%s  ' "$f"; shasum -a 256 < "$f" | cut -d' ' -f1
  done | shasum -a 256 | cut -d' ' -f1
}

# Hash of the task definitions, ignoring the fields the agent is allowed to change.
prd_spec_hash() {
  jq -S 'del(.features[].passes, .features[].completed_at, .features[].notes)' "$PRD_FILE" | shasum -a 256 | cut -d' ' -f1
}

passing_ids() {
  jq -r '[.features[] | select(.passes == true) | .id] | sort | join(",")' "$PRD_FILE"
}

audit_event() {
  # audit_event <json-object>  -> appends one line to the run's audit trail
  echo "$1" >> "$RUN_DIR/audit.jsonl"
}

halt_tampered() {
  local what="$1"
  echo ""
  echo "=============================================="
  echo "HALTED: $what changed during iteration $ITERATION."
  echo "This loop is not allowed to modify its own gate or task definitions."
  echo "Review with: git diff $START_SHA -- ${PROTECTED_PATHS[*]} $PRD_FILE"
  echo "=============================================="
  audit_event "$(jq -cn --argjson i "$ITERATION" --arg what "$what" --arg at "$(date -Iseconds)" '{event:"halted_tampering", iteration:$i, what:$what, at:$at}')"
  printf '\n- %s run %s: **HALTED**, %s changed in iteration %s.\n' "$(date -Iseconds)" "$RUN_ID" "$what" "$ITERATION" >> "$AUDIT_LOG_MD"
  update_status "halted_tampering" "${TASK_ID:-}" "${TASK_TITLE:-}"
  rm -f "$STATE_FILE"
  exit 3
}

# ============================================
# Pre-flight (muse-ready)
# ============================================

for bin in jq claude gitleaks git node npx; do
  command -v "$bin" > /dev/null || { echo "Error: $bin is required"; exit 1; }
done
git rev-parse --verify HEAD > /dev/null 2>&1 || { echo "Error: no commits yet. Commit a baseline first."; exit 1; }
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working tree is not clean. Commit or stash first so every change the loop makes is reviewable."
  exit 1
fi
echo "Checking the gate passes on the baseline before starting..."
if ! $VERIFY_COMMAND > "$RUN_DIR/baseline-verify.txt" 2>&1; then
  echo "Error: $VERIFY_COMMAND fails on the baseline. Fix it first. Output: $RUN_DIR/baseline-verify.txt"
  exit 1
fi
START_SHA=$(git rev-parse HEAD)
PROTECTED_HASH=$(protected_hash)
PRD_SPEC_HASH=$(prd_spec_hash)
[ -f "$AUDIT_LOG_MD" ] || printf '# Ralph audit log\n\nOne line per loop iteration, written by scripts/ralph/ralph.sh (not by the agent).\n' > "$AUDIT_LOG_MD"
audit_event "$(jq -cn --arg run "$RUN_ID" --arg sha "$START_SHA" --arg ph "$PROTECTED_HASH" --arg prd "$PRD_SPEC_HASH" --arg at "$(date -Iseconds)" '{event:"run_started", run:$run, start_sha:$sha, protected_hash:$ph, prd_spec_hash:$prd, at:$at}')"

# ============================================
# Main Loop
# ============================================

while [ $ITERATION -lt $MAX_ITERATIONS ]; do
  ITERATION=$((ITERATION + 1))

  echo ""
  echo "=============================================="
  echo "Iteration $ITERATION of $MAX_ITERATIONS"
  echo "=============================================="

  # Get next task info (structured) - excludes completed and skipped tasks
  NEXT_TASK_JSON=$(jq '
    .features
    | map(select(.passes == false and .skip != true))
    | sort_by(
        if .priority == "high" then 0
        elif .priority == "medium" then 1
        else 2 end
      )
    | first
  ' "$PRD_FILE")

  TASK_ID=$(echo "$NEXT_TASK_JSON" | jq -r '.id // "unknown"')
  TASK_TITLE=$(echo "$NEXT_TASK_JSON" | jq -r '.title // "unknown"')
  TASK_ISSUE=$(echo "$NEXT_TASK_JSON" | jq -r '.github_issue // "N/A"')

  if [ "$TASK_ID" = "null" ] || [ "$TASK_ID" = "unknown" ]; then
    echo "All tasks complete!"
    update_status "complete" "" ""
    rm -f "$STATE_FILE"
    exit 0
  fi

  echo "Task: $TASK_ID - $TASK_TITLE"
  echo "GitHub: #$TASK_ISSUE"
  echo ""

  update_status "running" "$TASK_ID" "$TASK_TITLE"
  log_verbose "Starting task $TASK_ID at $(date -Iseconds)"

  # Read guardrails if they exist
  GUARDRAILS_CONTENT=""
  if [ -f "$GUARDRAILS_FILE" ]; then
    GUARDRAILS_CONTENT=$(cat "$GUARDRAILS_FILE")
  fi

  # Build screenshot instructions if enabled
  SCREENSHOT_INSTRUCTIONS=""
  if [ "$SCREENSHOT" = true ]; then
    SCREENSHOT_INSTRUCTIONS="
## Screenshot Capture

After completing UI-related work, use Playwright MCP to capture screenshots:
1. Navigate to the affected page(s) using browser_navigate
2. Take screenshots using browser_take_screenshot with descriptive filenames
3. Save to: $RUN_DIR/screenshots/iteration-$ITERATION-{description}.png

This documents visual changes for verification.
"
    mkdir -p "$RUN_DIR/screenshots"
  fi

  # Create state file for this iteration
  cat > "$STATE_FILE" << EOF
---
iteration: $ITERATION
max_iterations: $MAX_ITERATIONS
run_id: "$RUN_ID"
mode: fresh
---

## Guardrails (Signs)

Follow these learned constraints to avoid repeated failures:

$GUARDRAILS_CONTENT

---
$SCREENSHOT_INSTRUCTIONS
## Instructions

You are in a Ralph loop (fresh-context mode). **Each iteration = ONE task.**

1. Read $PRD_FILE and find the first task where passes: false
2. Read $PROGRESS_FILE for context from previous iterations
3. Read and follow the Guardrails above - they prevent repeated mistakes
4. Work on **ONE task** until acceptance criteria are met
5. Run verification: $VERIFY_COMMAND
6. When the current task is complete:
   - Update prd.json: set passes: true and add completed_at
   - Update progress.md with what you learned
   - **COMMIT your changes** with message: "feat: [task-id] - description\n\nFixes #[github_issue]" (if github_issue is present in the task)
7. After completing ONE task, check prd.json:
   - If ALL tasks pass: output <promise>COMPLETE</promise>
   - If tasks remain: **EXIT immediately** - do NOT continue to other tasks

**Critical:** This is fresh-context mode. Complete ONE task, commit, then EXIT.
The bash loop will spawn a fresh session for the next task. Do NOT work on multiple tasks.
EOF

  # Spawn fresh Claude session
  echo "Spawning fresh Claude session..."
  OUTPUT_FILE="$RUN_DIR/iteration-$ITERATION.txt"
  JSON_FILE="$RUN_DIR/iteration-$ITERATION.json"
  CLAUDE_START=$(date +%s)

  log_verbose "Output will be saved to $OUTPUT_FILE"

  # Use claude CLI with print mode and JSON output to capture tokens
  # The prompt re-anchors from files every iteration
  # --dangerously-skip-permissions required for non-interactive mode
  ITER_COST=0
  HEAD_BEFORE=$(git rev-parse HEAD)
  PASSING_BEFORE=$(passing_ids)
  # RALPH_LOOP=1 switches on the PreToolUse guard hook (.claude/hooks/guard.mjs), which still
  # runs under --dangerously-skip-permissions and blocks edits to the gate, pushes and publishes.
  RALPH_LOOP=1 claude --print --output-format json --dangerously-skip-permissions \
    "You are in a Ralph loop (fresh-context mode). Read .claude/ralph-state.local.md for instructions, \
     then read $PRD_FILE to find the next failing task, \
     and $PROGRESS_FILE for context. Follow all guardrails in the state file. \
     Complete ONE task only, run '$VERIFY_COMMAND' to verify, commit your changes, \
     and update prd.json when complete. \
     CRITICAL: Complete ONE task then EXIT. Do NOT continue to other tasks. \
     Output <promise>COMPLETE</promise> only when ALL tasks pass." \
    > "$JSON_FILE" 2>&1 || true

  CLAUDE_END=$(date +%s)
  CLAUDE_DURATION=$((CLAUDE_END - CLAUDE_START))
  log_verbose "Claude session completed in ${CLAUDE_DURATION}s"

  # Extract result text for backward compatibility
  jq -r '.result // empty' "$JSON_FILE" > "$OUTPUT_FILE" 2>/dev/null || cp "$JSON_FILE" "$OUTPUT_FILE"

  # Parse token usage from JSON output
  if [ -f "$JSON_FILE" ] && jq -e '.usage' "$JSON_FILE" > /dev/null 2>&1; then
    ITER_INPUT=$(jq -r '.usage.input_tokens // 0' "$JSON_FILE")
    ITER_OUTPUT=$(jq -r '.usage.output_tokens // 0' "$JSON_FILE")
    ITER_CACHE_READ=$(jq -r '.usage.cache_read_input_tokens // 0' "$JSON_FILE")
    ITER_CACHE_WRITE=$(jq -r '.usage.cache_creation_input_tokens // 0' "$JSON_FILE")
    ITER_COST=$(jq -r '.total_cost_usd // 0' "$JSON_FILE")

    # Accumulate totals
    TOTAL_INPUT_TOKENS=$((TOTAL_INPUT_TOKENS + ITER_INPUT))
    TOTAL_OUTPUT_TOKENS=$((TOTAL_OUTPUT_TOKENS + ITER_OUTPUT))
    TOTAL_CACHE_READ=$((TOTAL_CACHE_READ + ITER_CACHE_READ))
    TOTAL_CACHE_WRITE=$((TOTAL_CACHE_WRITE + ITER_CACHE_WRITE))
    # For cost, use awk for floating point
    TOTAL_COST_USD=$(awk "BEGIN {printf \"%.6f\", $TOTAL_COST_USD + $ITER_COST}")

    log_verbose "Iteration tokens: in=$ITER_INPUT out=$ITER_OUTPUT cache_read=$ITER_CACHE_READ cost=\$$ITER_COST"
    log_verbose "Total tokens: in=$TOTAL_INPUT_TOKENS out=$TOTAL_OUTPUT_TOKENS cost=\$$TOTAL_COST_USD"

    # Update status with token data so dashboard reflects current usage
    update_status "processing" "$TASK_ID" "$TASK_TITLE"
  fi

  # Show output summary in verbose mode
  if [ "$VERBOSE" = true ]; then
    OUTPUT_LINES=$(wc -l < "$OUTPUT_FILE")
    echo "[VERBOSE] Output: $OUTPUT_LINES lines"
    echo "[VERBOSE] Last 10 lines:"
    tail -10 "$OUTPUT_FILE" | sed 's/^/  | /'
  fi

  # Integrity: the agent must not touch the gate or the task definitions.
  [ "$(protected_hash)" = "$PROTECTED_HASH" ] || halt_tampered "a protected gate file"
  [ "$(prd_spec_hash)" = "$PRD_SPEC_HASH" ] || halt_tampered "a task definition in $PRD_FILE"

  # Verification ALWAYS runs, and runs before any completion claim is believed.
  # (Template bug fixed: `$(cmd) || true; X=$?` always recorded 0.)
  echo ""
  echo "Running verification..."
  update_status "verifying" "$TASK_ID" "$TASK_TITLE"
  VERIFY_START=$(date +%s)
  VERIFY_EXIT=0
  $VERIFY_COMMAND > "$RUN_DIR/verify-$ITERATION.txt" 2>&1 || VERIFY_EXIT=$?
  VERIFY_END=$(date +%s)
  VERIFY_DURATION=$((VERIFY_END - VERIFY_START))
  SECURITY_FAILS=$(grep -E '^FAIL  ' "$RUN_DIR/verify-$ITERATION.txt" | sed 's/^FAIL  //' | paste -sd ';' - || true)

  PASSING_AFTER=$(passing_ids)
  NEWLY_PASSING=$(comm -13 <(echo "$PASSING_BEFORE" | tr ',' '\n' | sed '/^$/d') <(echo "$PASSING_AFTER" | tr ',' '\n' | sed '/^$/d') | paste -sd ',' - || true)

  if [ $VERIFY_EXIT -eq 0 ]; then
    echo "Verification PASSED (${VERIFY_DURATION}s)"
  else
    echo "Verification FAILED (exit $VERIFY_EXIT, ${VERIFY_DURATION}s)"
    tail -20 "$RUN_DIR/verify-$ITERATION.txt"
    # A task is not done if the gate fails: un-mark anything the agent marked this iteration.
    if [ -n "$NEWLY_PASSING" ]; then
      for id in ${NEWLY_PASSING//,/ }; do
        tmp=$(mktemp)
        jq --arg id "$id" --arg note "Reverted by ralph.sh: verify failed after iteration $ITERATION. See $RUN_DIR/verify-$ITERATION.txt" \
          '(.features[] | select(.id == $id)) |= (.passes = false | del(.completed_at) | .notes = ((.notes // "") + " " + $note))' \
          "$PRD_FILE" > "$tmp" && mv "$tmp" "$PRD_FILE"
        echo "Un-marked $id: verification failed."
      done
      PRD_SPEC_HASH=$(prd_spec_hash)
    fi
  fi

  HEAD_AFTER=$(git rev-parse HEAD)
  CHANGED_FILES=$(git diff --name-only "$HEAD_BEFORE" "$HEAD_AFTER" | paste -sd ',' - || true)
  DIRTY=$([ -n "$(git status --porcelain)" ] && echo true || echo false)
  audit_event "$(jq -cn \
    --argjson i "$ITERATION" --arg task "$TASK_ID" --arg before "$HEAD_BEFORE" --arg after "$HEAD_AFTER" \
    --arg files "$CHANGED_FILES" --argjson verify_exit "$VERIFY_EXIT" --arg security_fails "$SECURITY_FAILS" \
    --arg newly "$NEWLY_PASSING" --argjson dirty "$DIRTY" --argjson secs "$CLAUDE_DURATION" --arg cost "${ITER_COST:-0}" --arg at "$(date -Iseconds)" \
    '{event:"iteration", iteration:$i, task:$task, head_before:$before, head_after:$after,
      files_changed:($files|split(",")|map(select(.!=""))), verify:(if $verify_exit==0 then "pass" else "fail" end),
      security_failures:($security_fails|split(";")|map(select(.!=""))), marked_passing:($newly|split(",")|map(select(.!=""))),
      uncommitted_changes:$dirty, claude_seconds:$secs, cost_usd:$cost, at:$at}')"
  printf -- '- %s run %s iter %s, %s: verify **%s**%s, commits %s..%s%s\n' \
    "$(date -Iseconds)" "$RUN_ID" "$ITERATION" "$TASK_ID" "$([ $VERIFY_EXIT -eq 0 ] && echo pass || echo FAIL)" \
    "$([ -n "$SECURITY_FAILS" ] && echo " (security: $SECURITY_FAILS)")" "${HEAD_BEFORE:0:7}" "${HEAD_AFTER:0:7}" \
    "$([ "$DIRTY" = true ] && echo ", uncommitted changes left")" >> "$AUDIT_LOG_MD"

  # Completion is only believed when the gate passes and no automatable task remains.
  if [ $VERIFY_EXIT -eq 0 ] && tail -10 "$OUTPUT_FILE" | grep -qE "^[[:space:]]*<promise>COMPLETE</promise>"; then
    REMAINING_CHECK=$(jq '[.features[] | select(.passes == false and .skip != true)] | length' "$PRD_FILE")
    if [ "$REMAINING_CHECK" -eq 0 ]; then
      echo ""
      echo "=============================================="
      echo "Completion promise detected and verified."
      echo "=============================================="
      update_status "complete" "$TASK_ID" "$TASK_TITLE"
      rm -f "$STATE_FILE"
      exit 0
    fi
    echo "Completion promise ignored: $REMAINING_CHECK task(s) still pending."
  fi

  # Check remaining tasks (excluding skipped)
  REMAINING_TASKS=$(jq '[.features[] | select(.passes == false and .skip != true)] | length' "$PRD_FILE")
  echo ""
  echo "Remaining tasks: $REMAINING_TASKS"

  if [ "$REMAINING_TASKS" -eq 0 ]; then
    echo ""
    echo "=============================================="
    echo "All automatable tasks complete!"
    echo "=============================================="
    update_status "complete" "" ""
    rm -f "$STATE_FILE" "$STATUS_FILE"
    exit 0
  fi

  log_verbose "Iteration $ITERATION complete, $REMAINING_TASKS tasks remaining"

  # Brief pause between iterations
  sleep 2
done

echo ""
echo "=============================================="
echo "Max iterations ($MAX_ITERATIONS) reached"
echo "Remaining tasks: $REMAINING_TASKS"
echo "=============================================="
update_status "max_iterations" "$TASK_ID" "$TASK_TITLE"
rm -f "$STATE_FILE"
exit 1
