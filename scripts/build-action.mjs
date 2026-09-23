// Bundles the GitHub Action into action/dist/index.mjs. Deterministic: the staleness test rebuilds and compares.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export const OPTIONS = {
  entryPoints: [fileURLToPath(new URL("../src/action/index.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  legalComments: "none",
  minify: false,
  sourcemap: false,
  // Bundled CommonJS dependencies call require(); give ESM output a real one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
};

export async function bundle(write = true) {
  const outfile = fileURLToPath(new URL("../action/dist/index.mjs", import.meta.url));
  const result = await build({ ...OPTIONS, outfile, write });
  return write ? outfile : Buffer.from(result.outputFiles[0].contents).toString("utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`wrote ${await bundle()}`);
}
