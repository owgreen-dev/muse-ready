import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { root } from "./helpers.js";

const text = readFileSync(join(root, "docs/examples/muse-ready.yml"), "utf8");
const wf = parse(text);
const steps: any[] = Object.values<any>(wf.jobs).flatMap((j) => j.steps ?? []);

describe("example workflow", () => {
  it("triggers on pull_request and never pull_request_target", () => {
    expect(wf.on).toHaveProperty("pull_request");
    expect(text).not.toContain("pull_request_target");
  });

  it("is read-only at the top level and grants security-events: write only to the job that uploads SARIF", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    for (const [name, job] of Object.entries<any>(wf.jobs)) {
      const uploads = (job.steps ?? []).some((s: any) => String(s.uses ?? "").startsWith("github/codeql-action/upload-sarif"));
      expect(job.permissions, name).toEqual(uploads ? { contents: "read", "security-events": "write" } : undefined);
    }
  });

  it("pins every action to a 40-character SHA with a version comment", () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBe(3);
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/@[0-9a-f]{40}$/);
      expect(rest, ref).toMatch(/#\s*v\d+\.\d+\.\d+/);
    }
    expect(text).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1");
    expect(text).toContain("github/codeql-action/upload-sarif@1c5b675653bb5c22dbe9b12b556ec555138e09fd # v4.38.1");
  });

  it("does not persist checkout credentials and interpolates nothing untrusted into shell", () => {
    const checkout = steps.find((s) => String(s.uses).startsWith("actions/checkout@"));
    expect(checkout.with["persist-credentials"]).toBe(false);
    expect(steps.some((s) => s.run)).toBe(false);
    expect(text).not.toMatch(/\$\{\{\s*github\.event\./);
  });

  it("uses the action with inputs that exist in action.yml", () => {
    const action = parse(readFileSync(join(root, "action.yml"), "utf8"));
    const muse = steps.find((s) => String(s.uses).includes("/muse-ready@"));
    for (const key of Object.keys(muse.with)) expect(Object.keys(action.inputs)).toContain(key);
    const upload = steps.find((s) => String(s.uses).startsWith("github/codeql-action/upload-sarif@"));
    expect(upload.with.sarif_file).toBe(action.inputs["sarif-file"].default);
  });
});
