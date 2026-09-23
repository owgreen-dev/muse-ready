import type { Rule } from "../core/types.js";
import { AUTH001 } from "./auth001.js";
import { AUTH002 } from "./auth002.js";
import { DESC001 } from "./desc001.js";
import { ERR001 } from "./err001.js";
import { IDEM001 } from "./idem001.js";
import { INJ001 } from "./inj001.js";
import { MCP001 } from "./mcp001.js";
import { META001 } from "./meta001.js";
import { META002 } from "./meta002.js";
import { NET001 } from "./net001.js";
import { PAGE001 } from "./page001.js";
import { SCOPE001 } from "./scope001.js";
import { SCOPE002 } from "./scope002.js";
import { SCOPE003 } from "./scope003.js";
import { SPEC001 } from "./spec001.js";
import { SPEC002 } from "./spec002.js";

/** Built-in rules in report order. */
export const BUILTIN_RULES: Rule[] = [
  SPEC001, SPEC002, MCP001,
  DESC001,
  AUTH001, AUTH002,
  SCOPE001, SCOPE002, SCOPE003, IDEM001,
  INJ001,
  ERR001, PAGE001,
  NET001,
  META001, META002,
];
