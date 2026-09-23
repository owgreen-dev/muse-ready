// Prints the README rule catalog from the built rules: npm run build && node scripts/rules-doc.mjs
import { BUILTIN_RULES } from "../dist/index.js";

const lines = ["| ID | Check | Severity | Applies to | Sub-score |", "|---|---|---|---|---|"];
for (const r of BUILTIN_RULES) {
  lines.push(`| [${r.id}](#${r.id.toLowerCase()}) | ${r.title} | ${r.severity} | ${r.appliesTo.join(", ")} | ${r.subscores.join(", ")} |`);
}
lines.push("");
for (const r of BUILTIN_RULES) lines.push(`### ${r.id}`, "", `**${r.title}.** ${r.rationale}`, "");
console.log(lines.join("\n"));
