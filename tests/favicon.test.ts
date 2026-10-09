import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const favicon = readFileSync(new URL("../src/app/favicon.ico", import.meta.url));

describe("Tally favicon", () => {
  it("serves a valid 32px ICO image for the browser favicon route", () => {
    expect(favicon.readUInt16LE(0)).toBe(0);
    expect(favicon.readUInt16LE(2)).toBe(1);
    expect(favicon.readUInt16LE(4)).toBeGreaterThan(0);
    expect(favicon[6]).toBe(32);
    expect(favicon[7]).toBe(32);
    expect(favicon.readUInt16LE(10)).toBe(1);
    expect(favicon.readUInt16LE(12)).toBe(32);
    const imageSize = favicon.readUInt32LE(14);
    const imageOffset = favicon.readUInt32LE(18);
    expect(imageOffset).toBeGreaterThanOrEqual(22);
    expect(imageOffset + imageSize).toBeLessThanOrEqual(favicon.length);
    expect(favicon.subarray(imageOffset, imageOffset + 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  });
});
