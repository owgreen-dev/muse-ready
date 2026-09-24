import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Build dist/ exactly once, before any test file runs. Building in each file's beforeAll raced:
// one file could execute dist/cli/index.js while another was rewriting it (seen on CI, Node 20).
export default function setup() {
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit" });
}
