import { isStaticHeaderScheme, securitySchemes } from "../core/openapi.js";
import type { LoadedInput } from "../core/types.js";

export const TOKEN_ENV = "MUSE_READY_TOKEN";

/**
 * Builds the credential header for authenticated probing.
 * Header choice: config probe.authHeader, else the spec's static header scheme, else "Authorization: Bearer".
 * The token itself is only ever read from the environment by the caller and never logged.
 */
export function authHeaders(token: string, input: LoadedInput, configured?: string): Record<string, string> {
  if (configured && configured.toLowerCase() !== "authorization") return { [configured]: token };
  if (configured) return { Authorization: /^(bearer|basic)\s/i.test(token) ? token : `Bearer ${token}` };
  if (input.kind === "openapi") {
    const scheme = securitySchemes(input.resolved).map((s) => s.scheme).find(isStaticHeaderScheme);
    if (scheme?.type?.toLowerCase() === "apikey" && typeof scheme.name === "string") return { [scheme.name]: token };
    if (String(scheme?.scheme).toLowerCase() === "basic" || scheme?.type === "basic") {
      return { Authorization: `Basic ${Buffer.from(token).toString("base64")}` };
    }
  }
  return { Authorization: `Bearer ${token}` };
}
