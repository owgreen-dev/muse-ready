import type { Finding, Pointer, Rule } from "../core/types.js";
import { textFields } from "../core/openapi.js";
import { aggregate, plural, preview } from "./util.js";

// Zero-width characters, bidi controls, BOM and Unicode tag characters: invisible to a human reviewer, read by the model.
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/u;

/** Phrases with no legitimate place in an API description. */
const MALICIOUS: [RegExp, string][] = [
  [/\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+|your\s+)?(previous|prior|above|earlier|preceding|system)\s+(instructions|prompts?|messages|rules|context)/i, "instruction override"],
  [/<\/?\s*(important|system|instructions?|secret|admin)\s*>/i, "fake control tag"],
  [/\b(do\s+not|don'?t|never)\s+(tell|inform|mention|reveal|show|notify)\b[^.]{0,20}\bthe\s+user\b/i, "hides actions from the user"],
  [/\bwithout\s+(telling|informing|asking|notifying)\s+the\s+user\b/i, "hides actions from the user"],
  [/\bsystem\s+prompt\b/i, "references the system prompt"],
  [/~\/\.ssh|\bid_rsa\b|\.aws\/credentials|\bmcp\.json\b|\/etc\/passwd|\.env\b/i, "references local secrets"],
  [/\bexfiltrat/i, "exfiltration language"],
];

/** Phrases that are sometimes legitimate but are common in tool-poisoning attacks. */
const SUSPICIOUS: [RegExp, string][] = [
  [/\b(before|prior\s+to)\s+(using|calling|invoking)\s+(this|any\s+other)\s+tool\b.{0,80}\b(read|send|include|pass|call)\b/i, "pre-call instruction"],
  [/\binstead\s+of\s+(using\s+|calling\s+)?(the\s+)?[\w-]+\s+tool\b/i, "tool shadowing"],
  [/[A-Za-z0-9+/]{120,}={0,2}/, "long encoded blob"],
];

function scan(text: string, pointer: Pointer, where: string, fails: Finding[], warns: Finding[]) {
  if (HIDDEN.test(text)) {
    const cps = [...text].filter((ch) => HIDDEN.test(ch)).map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
    fails.push({ message: `${where} contains invisible Unicode (${[...new Set(cps)].slice(0, 4).join(", ")})`, pointer });
  }
  for (const [re, label] of MALICIOUS) {
    const m = text.match(re);
    if (m) fails.push({ message: `${where}: ${label}: "${preview(m[0], 60)}"`, pointer });
  }
  for (const [re, label] of SUSPICIOUS) {
    const m = text.match(re);
    if (m) warns.push({ message: `${where}: ${label}: "${preview(m[0], 60)}"`, pointer });
  }
}

export const INJ001: Rule = {
  id: "INJ001",
  title: "Descriptions contain no hidden instructions",
  category: "injection",
  severity: "critical",
  subscores: ["directory", "custom"],
  appliesTo: ["openapi", "mcp"],
  rationale:
    "Descriptions are fed straight to the model. Hidden Unicode and embedded instructions are the tool-poisoning pattern documented by Invariant Labs (mcp-scan) and OWASP LLM01.",
  run({ input }) {
    const fails: Finding[] = [];
    const warns: Finding[] = [];
    const fields = textFields(input.doc);
    for (const f of fields) scan(f.text, f.pointer, f.pointer.join("."), fails, warns);
    if (input.kind === "mcp") {
      const base = Array.isArray(input.doc) ? [] : input.doc?.result ? ["result", "tools"] : ["tools"];
      (input.tools ?? []).forEach((t, i) => {
        if (typeof t?.name === "string") scan(t.name, [...base, i, "name"], `tool name "${t.name}"`, fails, []);
      });
    }
    return aggregate(fails, warns, {
      pass: `Scanned ${plural(fields.length, "description")}; nothing suspicious.`,
      fail: `${plural(fails.length, "likely injection payload")} found.`,
      warn: `${plural(warns.length, "suspicious phrase")} to review.`,
    });
  },
};
