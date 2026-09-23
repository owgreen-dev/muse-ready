#!/usr/bin/env node
// Security gate for muse-ready. Fails closed: any check that cannot run is a failure.
// Human-owned: the Ralph guard hook blocks agent edits, and the loop halts if this file changes.
// Policy lives in security/policy.json.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const policy = JSON.parse(readFileSync(join(root, "security/policy.json"), "utf8"));
const results = [];

function check(name, fn) {
  const started = Date.now();
  try {
    const problems = fn() ?? [];
    results.push({ name, ok: problems.length === 0, problems, ms: Date.now() - started });
  } catch (err) {
    const why = err.code === "ETIMEDOUT" || err.signal === "SIGTERM" ? "timed out" : err.message.split("\n")[0];
    results.push({ name, ok: false, problems: [`check could not run: ${why}`], ms: Date.now() - started });
  }
}

// Every external call has a timeout: a hung network call must fail the gate, not stall the loop.
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, timeout: 60_000, ...opts });
}

/** Files git would track: tracked plus untracked-but-not-ignored. */
function repoFiles() {
  return run("git", ["ls-files", "-co", "--exclude-standard", "-z"]).split("\0").filter((f) => f && existsSync(join(root, f)));
}

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lockPackages = Object.entries(lock.packages ?? {}).filter(([k, v]) => k !== "" && !v.link);

// 1. Known vulnerabilities in the full dependency tree.
check("dependency advisories (npm audit)", () => {
  let out;
  try {
    out = run("npm", ["audit", "--json", `--audit-level=${policy.auditLevel}`, "--fetch-timeout=30000", "--fetch-retries=1"], { timeout: 120_000 });
  } catch (err) {
    if (err.code === "ETIMEDOUT" || err.signal) throw err;
    out = err.stdout; // npm audit exits non-zero when it finds something
    if (!out) throw new Error("npm audit produced no output (offline?)");
  }
  const report = JSON.parse(out);
  if (report.error) throw new Error(report.error.summary ?? "npm audit failed");
  return Object.entries(report.vulnerabilities ?? {}).map(([name, v]) => {
    const advisories = v.via.filter((x) => typeof x === "object").map((x) => x.url).join(", ");
    return `${name} (${v.severity})${advisories ? `: ${advisories}` : ""}`;
  });
});

// 2. Supply chain: every package comes from the public registry with an integrity hash.
check("lockfile sources and integrity", () => {
  const problems = [];
  if (lock.lockfileVersion < 3) problems.push(`lockfileVersion ${lock.lockfileVersion}; expected 3`);
  for (const [key, v] of lockPackages) {
    if (!String(v.resolved ?? "").startsWith("https://registry.npmjs.org/")) problems.push(`${key} resolved from ${v.resolved ?? "nowhere"}`);
    if (!String(v.integrity ?? "").startsWith("sha512-")) problems.push(`${key} has no sha512 integrity`);
  }
  return problems;
});

// 3. Supply chain: install scripts run arbitrary code at install time.
check("install scripts", () =>
  lockPackages
    .filter(([key, v]) => v.hasInstallScript && !policy.installScriptAllowlist.includes(key))
    .map(([key, v]) => `${key} runs an install script${v.dev ? " (dev)" : ""}; add to security/policy.json only after review`),
);

// 4. New production dependencies need human approval.
check("approved production dependencies", () =>
  Object.keys(pkg.dependencies ?? {})
    .filter((d) => !policy.approvedProductionDependencies.includes(d))
    .map((d) => `${d} is not in approvedProductionDependencies`),
);

// 5. Licenses of everything that ships to users stay compatible with Apache-2.0.
check("production licenses", () =>
  lockPackages
    .filter(([, v]) => !v.dev)
    .filter(([, v]) => !policy.allowedLicenses.includes(v.license))
    .map(([key, v]) => `${key} is licensed ${v.license ?? "UNKNOWN"}`),
);

// 6. Secrets in anything git would pick up.
check("secret scan (gitleaks)", () => {
  const files = repoFiles();
  const problems = [];
  for (const f of files) {
    try {
      run("gitleaks", ["dir", "--no-banner", "--redact", "--exit-code", "1", "--log-level", "error", join(root, f)], { timeout: 30_000 });
    } catch (err) {
      if (err.status === 1 && !err.signal) problems.push(`possible secret in ${f}`);
      else throw err;
    }
  }
  return problems;
});

// 7. The product promise: no network access outside the loader and the probe.
const NETWORK = /\bfetch\s*\(|from\s+["']node:(https?|net|tls|dns|dgram|http2)["']|require\(\s*["'](node:)?(https?|net|tls|dns|dgram|http2)["']\s*\)|\bXMLHttpRequest\b|\bWebSocket\b|\bundici\b/;
const CHILD = /["'](node:)?child_process["']/;
const DANGEROUS = /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.run|\bshell\s*:\s*true/;
const allowed = (file, list) => list.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));
check("source invariants (network, child processes, eval)", () => {
  const problems = [];
  for (const abs of walk(join(root, "src"))) {
    if (!/\.(ts|js|mjs|cjs)$/.test(abs)) continue;
    const file = relative(root, abs);
    // isIP/isIPv4/isIPv6 are pure string checks; importing only those from node:net is not network use.
    const text = readFileSync(abs, "utf8").replace(/^import\s*\{\s*(isIP(v4|v6)?\s*,?\s*)+\}\s*from\s*["']node:net["'];?\s*$/gm, "");
    if (NETWORK.test(text) && !allowed(file, policy.networkAllowedFiles)) problems.push(`${file} uses the network; only ${policy.networkAllowedFiles.join(", ")} may`);
    if (CHILD.test(text) && !allowed(file, policy.childProcessAllowedFiles)) problems.push(`${file} spawns child processes`);
    if (DANGEROUS.test(text)) problems.push(`${file} uses eval, new Function, vm or shell: true`);
  }
  return problems;
});

// 8. Tests cannot be skipped or focused, and the suite cannot shrink.
check("test suite integrity", () => {
  const problems = [];
  for (const abs of walk(join(root, "test"))) {
    const text = readFileSync(abs, "utf8");
    if (/\b(it|test|describe)\.(skip|only|todo)\b|\bx(it|describe)\s*\(/.test(text)) problems.push(`${relative(root, abs)} skips or focuses tests`);
  }
  const countFile = join(root, ".verify-test-count");
  if (!existsSync(countFile)) problems.push("no test count recorded; run scripts/verify.sh");
  else {
    const count = Number(readFileSync(countFile, "utf8"));
    if (!(count >= policy.minimumTestCount)) problems.push(`${count} tests ran; policy minimum is ${policy.minimumTestCount}`);
  }
  return problems;
});

// 9. The probe, once it exists, must ship with its security tests.
check("probe security tests", () => {
  if (!existsSync(join(root, "src/probe"))) return [];
  const { file, requiredTests } = policy.probeSecurityTests;
  if (!existsSync(join(root, file))) return [`src/probe exists but ${file} does not`];
  const text = readFileSync(join(root, file), "utf8");
  return requiredTests.filter((t) => !text.includes(`"${t}"`)).map((t) => `${file} is missing the test "${t}"`);
});

// 10. The npm package ships only what it should.
check("published package contents", () => {
  const [packed] = JSON.parse(run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]));
  const patterns = policy.packageFilesAllowed.map((p) => new RegExp(p));
  return packed.files.map((f) => f.path).filter((p) => !patterns.some((re) => re.test(p))).map((p) => `${p} would be published`);
});

// 11. GitHub workflows and actions: pinned, least privilege, no injection.
check("GitHub workflow hardening", () => {
  const problems = [];
  const files = [...walk(join(root, ".github/workflows")), ...["action.yml", "action.yaml"].map((f) => join(root, f)).filter(existsSync)];
  for (const abs of files) {
    const file = relative(root, abs);
    const text = readFileSync(abs, "utf8");
    for (const m of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      const ref = m[1];
      if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
      if (!/@[0-9a-f]{40}$/.test(ref)) problems.push(`${file}: ${ref} is not pinned to a commit SHA`);
    }
    if (file.startsWith(".github/workflows/")) {
      if (!/^permissions:/m.test(text)) problems.push(`${file}: no top-level permissions block`);
      if (/pull_request_target/.test(text)) problems.push(`${file}: uses pull_request_target`);
    }
    for (const m of text.matchAll(/\$\{\{\s*(github\.event\.[^}]*|github\.head_ref[^}]*|inputs\.[^}]*)\}\}/g)) {
      const line = text.slice(0, m.index).split("\n").length;
      const lineText = text.split("\n")[line - 1];
      const inRun = /^\s*(-\s*)?run:/.test(lineText) || (!/^\s*[\w-]+:/.test(lineText) && /run:\s*\|/.test(text.split("\n").slice(Math.max(0, line - 15), line).join("\n")));
      if (inRun) problems.push(`${file}:${line}: untrusted \${{ ${m[1].trim()} }} interpolated into a shell command; pass it through env`);
    }
  }
  return problems;
});

// Report
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${(r.ms / 1000).toFixed(1)}s)`);
  for (const p of r.problems.slice(0, 20)) console.log(`      - ${p}`);
  if (r.problems.length > 20) console.log(`      - …and ${r.problems.length - 20} more`);
  if (!r.ok) failed++;
}
console.log(failed ? `\nSecurity audit FAILED: ${failed} of ${results.length} checks.` : `\nSecurity audit passed: ${results.length} checks.`);
process.exit(failed ? 1 : 0);
