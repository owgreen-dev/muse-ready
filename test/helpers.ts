import { fileURLToPath } from "node:url";
import { check } from "../src/index.js";
import type { Config, Report } from "../src/index.js";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const fixture = (p: string) => fileURLToPath(new URL(`../fixtures/${p}`, import.meta.url));

export async function run(p: string, config: Config = {}): Promise<Report> {
  return check(fixture(p), { config });
}

export function result(report: Report, id: string) {
  const r = report.results.find((x) => x.id === id);
  if (!r) throw new Error(`rule ${id} missing from report`);
  return r;
}
