// OAuth discovery as the MCP authorization spec defines it: RFC 9728 protected-resource metadata, then
// RFC 8414 (or OpenID Connect) authorization-server metadata. GET only, never with credentials.
import type { OAuthDiscovery } from "../core/types.js";
import { ProbeError, redactUrl, safeRequest, type SafeRequestOptions } from "./http.js";

type RequestOptions = Pick<SafeRequestOptions, "allowPrivateNetwork" | "allowInsecureHttp" | "addressPolicy" | "resolver" | "ca">;

/** RFC 9728 section 3.1: insert the well-known path between the host and the resource path. */
export function resourceMetadataUrls(resource: string): string[] {
  const u = new URL(resource);
  const path = u.pathname.replace(/\/+$/, "");
  const root = `${u.origin}/.well-known/oauth-protected-resource`;
  return path ? [`${root}${path}`, root] : [root];
}

/** RFC 8414 section 3.1, then the OpenID Connect locations. */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    ...(path ? [`${u.origin}${path}/.well-known/openid-configuration`] : []),
  ];
}

async function getJson(urls: string[], request: RequestOptions): Promise<{ url?: string; status?: number; json?: any; error?: string }> {
  let last: { url?: string; status?: number; error?: string } = {};
  for (const url of urls) {
    try {
      const r = await safeRequest(url, { ...request, timeoutMs: 15_000, maxBytes: 256 * 1024, headers: { accept: "application/json" } });
      if (r.status >= 200 && r.status < 300) {
        try {
          return { url: redactUrl(url), status: r.status, json: JSON.parse(r.body) };
        } catch {
          last = { url: redactUrl(url), status: r.status, error: "response is not JSON" };
          continue;
        }
      }
      last = { url: redactUrl(url), status: r.status };
    } catch (err) {
      last = { url: redactUrl(url), error: err instanceof ProbeError ? err.message : "request failed" };
    }
  }
  return last;
}

export async function discoverOAuth(resource: string, reason: OAuthDiscovery["reason"], request: RequestOptions): Promise<OAuthDiscovery> {
  const prm = await getJson(resourceMetadataUrls(resource), request);
  const servers = Array.isArray(prm.json?.authorization_servers) ? prm.json.authorization_servers.filter((s: unknown) => typeof s === "string") : undefined;
  const discovery: OAuthDiscovery = {
    reason,
    resourceMetadata: { url: prm.url, status: prm.status, authorizationServers: servers, ...(prm.error ? { error: prm.error } : {}) },
  };
  if (!servers?.length) return discovery;

  let issuer: string;
  try {
    issuer = new URL(servers[0]).toString();
  } catch {
    discovery.authorizationServer = { error: "authorization_servers[0] is not a valid URL" };
    return discovery;
  }
  const as = await getJson(authorizationServerMetadataUrls(issuer), request);
  const m = as.json;
  discovery.authorizationServer = m
    ? {
        url: as.url,
        status: as.status,
        s256: Array.isArray(m.code_challenge_methods_supported) && m.code_challenge_methods_supported.includes("S256"),
        cimd: m.client_id_metadata_document_supported === true,
        dcr: typeof m.registration_endpoint === "string",
        iss: m.authorization_response_iss_parameter_supported === true,
      }
    : { url: as.url, status: as.status, error: as.error ?? `no metadata found (HTTP ${as.status ?? "error"})` };
  return discovery;
}
