import { LineCounter, parseDocument, isNode } from "yaml";
import type { Pointer } from "./types.js";

/** Maps JSON pointers to 1-based source lines. Falls back to the deepest ancestor that exists. */
export function makeLineLocator(raw: string): (pointer: Pointer) => number | undefined {
  // Minified JSON: every finding would say "line 1", which is noise.
  if (raw.trim().split("\n").length < 2) return () => undefined;
  let doc: ReturnType<typeof parseDocument>;
  const counter = new LineCounter();
  try {
    doc = parseDocument(raw, { lineCounter: counter, keepSourceTokens: false });
  } catch {
    return () => undefined;
  }
  return (pointer) => {
    for (let len = pointer.length; len >= 0; len--) {
      const node = doc.getIn(pointer.slice(0, len), true);
      if (isNode(node) && node.range) return counter.linePos(node.range[0]).line;
    }
    return undefined;
  };
}
