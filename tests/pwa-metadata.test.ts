import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const publicDirectory = new URL("../public/", import.meta.url);

function pngDimensions(file: Buffer) {
  expect(file.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(file.toString("ascii", 12, 16)).toBe("IHDR");
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
}

describe("Tally install metadata", () => {
  it("publishes the standalone manifest and correctly sized Tally icons", () => {
    const paths = ["manifest.webmanifest", "tally-pwa-192.png", "tally-pwa-512.png", "apple-touch-icon.png"];
    for (const path of paths) expect(existsSync(new URL(path, publicDirectory))).toBe(true);

    const manifest = JSON.parse(readFileSync(new URL("manifest.webmanifest", publicDirectory), "utf8"));
    expect(manifest).toMatchObject({
      name: "Tally",
      short_name: "Tally",
      start_url: "/",
      scope: "/",
      display: "standalone",
      theme_color: "#f5f6f2",
      background_color: "#f5f6f2",
      icons: [
        { src: "/tally-pwa-192.png", sizes: "192x192", type: "image/png" },
        { src: "/tally-pwa-512.png", sizes: "512x512", type: "image/png" },
      ],
    });

    expect(pngDimensions(readFileSync(new URL("tally-pwa-192.png", publicDirectory)))).toEqual({ width: 192, height: 192 });
    expect(pngDimensions(readFileSync(new URL("tally-pwa-512.png", publicDirectory)))).toEqual({ width: 512, height: 512 });
    expect(pngDimensions(readFileSync(new URL("apple-touch-icon.png", publicDirectory)))).toEqual({ width: 180, height: 180 });
  });
});
