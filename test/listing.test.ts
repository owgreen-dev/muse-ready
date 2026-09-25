import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { check, connectorFrom, loadInput } from "../src/index.js";
import { imageSize } from "../src/probe/image.js";
import { fixture, result } from "./helpers.js";

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width: number, height: number): Buffer {
  // SOI, an APP0 segment, then SOF0 with the frame size.
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0, 0, 0, 0]);
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

async function iconServer(routes: Record<string, [string, Buffer]>) {
  const server = createServer((req, res) => {
    const hit = routes[req.url ?? ""];
    if (!hit) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": hit[0] }).end(hit[1]);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const LOCAL = { request: { allowInsecureHttp: true, addressPolicy: (ip: string) => ip === "127.0.0.1" || ip === "::ffff:127.0.0.1", resolver: async () => [{ address: "93.184.216.34", family: 4 }] } };

describe("listing metadata", () => {
  it("reads PNG and JPEG sizes from their headers", () => {
    expect(imageSize(png(512, 512))).toEqual({ format: "png", width: 512, height: 512 });
    expect(imageSize(jpeg(640, 480))).toEqual({ format: "jpeg", width: 640, height: 480 });
    expect(imageSize(Buffer.from("<svg></svg>"))).toBeUndefined();
  });

  it("collects listing fields from standard OpenAPI fields, info.x-muse and the config, in that order", async () => {
    const input = await loadInput(fixture("good/tasks-api.openapi.yaml"));
    const c = connectorFrom(input, { connector: { company: "Override Ltd" } });
    expect(c).toMatchObject({
      name: "Tasks API",
      websiteUrl: "https://tasks.example.com",
      supportEmail: "support@tasks.example.com",
      docsUrl: "https://tasks.example.com/docs/api",
      iconUrl: "https://tasks.example.com/logo.png",
      company: "Override Ltd",
    });
    expect(c.examplePrompts).toHaveLength(3);
  });

  it("checks the icon live: 512x512 passes, other sizes warn, non-images and errors fail", async () => {
    const base = await iconServer({
      "/good.png": ["image/png", png(512, 512)],
      "/small.jpg": ["image/jpeg", jpeg(128, 128)],
      "/logo.svg": ["image/svg+xml", Buffer.from("<svg/>")],
    });
    const outcome = async (iconUrl: string) =>
      result(await check(fixture("good/tasks-api.openapi.yaml"), { config: { connector: { iconUrl } }, probe: LOCAL }), "META003");
    expect((await outcome(`${base}/good.png`)).status).toBe("pass");
    expect((await outcome(`${base}/small.jpg`)).message).toContain("128x128 JPEG");
    expect((await outcome(`${base}/logo.svg`)).message).toContain("not a PNG or JPEG");
    expect((await outcome(`${base}/missing.png`)).message).toContain("HTTP 404");
    expect(result(await check(fixture("good/tasks-api.openapi.yaml"), { config: {} }), "META003").status).toBe("not-applicable");
  });
});
