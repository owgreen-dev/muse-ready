import type { Rule } from "../core/types.js";

export const META003: Rule = {
  id: "META003",
  title: "Live: listing icon is a reachable 512x512 image",
  category: "metadata",
  severity: "medium",
  subscores: ["directory"],
  appliesTo: ["openapi", "mcp"],
  rationale:
    "Muse's submission form asks for a 512x512 icon (Manufact walkthrough, 22-24 Sep 2026; third-party). Checked live with --probe by reading the image header; nothing is uploaded anywhere.",
  run({ probe, connector }) {
    if (!probe) return { status: "not-applicable", message: "Live check. Run with --probe to include it." };
    if (!connector.iconUrl) return { status: "not-applicable", message: "No icon URL set." };
    const icon = probe.icon;
    if (!icon) return { status: "not-applicable", message: "The icon was not fetched." };
    if (icon.error) return { status: "fail", message: `Could not fetch the icon: ${icon.error}` };
    if (icon.status === undefined || icon.status >= 300) return { status: "fail", message: `The icon URL returned HTTP ${icon.status}.` };
    if (!icon.format) return { status: "fail", message: `The icon is not a PNG or JPEG (content-type ${icon.contentType || "unknown"}).` };
    if (icon.width !== 512 || icon.height !== 512) {
      return { status: "warn", message: `The icon is ${icon.width}x${icon.height} ${icon.format.toUpperCase()}; the form asks for 512x512.` };
    }
    return { status: "pass", message: `The icon is a 512x512 ${icon.format.toUpperCase()}.` };
  },
};
