import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { probeBuffer, probeFile, PROBE_LIMITS } from "../src/media/probe.ts";
import { avif, box, gif, jpeg, mp4, png, webm, webp } from "./media-fixtures.ts";

describe("images", () => {
  it("reads PNG, JPEG, GIF, WebP, AVIF, and SVG sizes from their headers", () => {
    expect(probeBuffer(png(1200, 630))).toMatchObject({
      format: "png",
      kind: "image",
      width: 1200,
      height: 630,
      animated: false,
    });
    expect(probeBuffer(png(64, 64, { animated: true })).animated).toBe(true);
    expect(probeBuffer(jpeg(1280, 640))).toMatchObject({
      format: "jpeg",
      width: 1280,
      height: 640,
    });
    expect(probeBuffer(gif(800, 450, 3))).toMatchObject({
      format: "gif",
      width: 800,
      height: 450,
      frames: 2,
      animated: true,
    });
    expect(probeBuffer(gif(10, 10, 1))).toMatchObject({ frames: 1, animated: false });
    expect(probeBuffer(webp(1200, 630, "VP8"))).toMatchObject({
      format: "webp",
      width: 1200,
      height: 630,
    });
    expect(probeBuffer(webp(1201, 631, "VP8L"))).toMatchObject({ width: 1201, height: 631 });
    expect(probeBuffer(webp(640, 360, "VP8X", true))).toMatchObject({
      width: 640,
      height: 360,
      animated: true,
    });
    expect(probeBuffer(avif(1600, 900))).toMatchObject({
      format: "avif",
      kind: "image",
      width: 1600,
      height: 900,
    });
    const svg = Buffer.from(
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"></svg>',
    );
    expect(probeBuffer(svg)).toMatchObject({ format: "svg", width: 120, height: 40 });
    const sized = Buffer.from('<svg width="48px" height="24" viewBox="0 0 10 10"/>');
    expect(probeBuffer(sized)).toMatchObject({ width: 48, height: 24 });
  });

  it("trusts magic bytes, not names, and says what it cannot read", () => {
    expect(probeBuffer(Buffer.from("just some text"))).toMatchObject({
      format: "unknown",
      kind: null,
    });
    expect(probeBuffer(Buffer.alloc(0)).error).toBe("empty");
    expect(probeBuffer(png(10, 10).subarray(0, 18)).error).toBe("truncated");
    expect(probeBuffer(jpeg(10, 10).subarray(0, 22)).error).toBeTruthy();
  });
});

describe("video", () => {
  it("reads an MP4's duration, size, codec, audio, and faststart", () => {
    expect(probeBuffer(mp4({ width: 1920, height: 1080, seconds: 42, audio: true }))).toEqual({
      format: "mp4",
      kind: "video",
      bytes: expect.any(Number),
      width: 1920,
      height: 1080,
      durationSeconds: 42,
      videoCodec: "avc1",
      audio: true,
      faststart: true,
    });
    const slow = probeBuffer(mp4({ codec: "hvc1", faststart: false, seconds: 5, version1: true }));
    expect(slow).toMatchObject({
      videoCodec: "hvc1",
      faststart: false,
      audio: false,
      durationSeconds: 5,
    });
  });

  it("finds a moov at the end of a large file within the read budget", () => {
    const big = mp4({ faststart: false, mdat: 8 * 1024 * 1024 });
    const info = probeBuffer(big);
    expect(info).toMatchObject({ width: 1920, faststart: false, durationSeconds: 30 });
  });

  it("reads a WebM's duration, size, codec, and audio, including an unknown-size segment", () => {
    expect(
      probeBuffer(webm({ width: 1280, height: 720, seconds: 12.5, audio: true })),
    ).toMatchObject({
      format: "webm",
      kind: "video",
      width: 1280,
      height: 720,
      durationSeconds: 12.5,
      videoCodec: "V_VP9",
      audio: true,
    });
    expect(probeBuffer(webm({ codec: "V_AV1", unknownSize: true }))).toMatchObject({
      videoCodec: "V_AV1",
      width: 1280,
    });
  });

  it("never throws on hostile or broken files", () => {
    const cases: Buffer[] = [
      mp4().subarray(0, 40),
      Buffer.concat([
        box("ftyp", Buffer.from("isom")),
        Buffer.from([0, 0, 0, 1, 0x6d, 0x6f, 0x6f, 0x76]),
      ]),
      // A box claiming to be larger than the file.
      Buffer.concat([
        box("ftyp", Buffer.from("isom")),
        Buffer.from([0x7f, 0xff, 0xff, 0xff]),
        Buffer.from("moov"),
      ]),
      // Boxes nested past the depth limit.
      Buffer.concat([
        box("ftyp", Buffer.from("isom")),
        Array.from({ length: 40 }).reduce<Buffer>((inner) => box("trak", inner), Buffer.alloc(0)),
      ]),
      webm().subarray(0, 30),
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]),
      Buffer.concat([
        Buffer.from("GIF89a"),
        Buffer.from([10, 0, 10, 0, 0x80, 0, 0]),
        Buffer.from([0x21, 0xf9, 0xff]),
      ]),
      Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8 "), Buffer.alloc(4)]),
    ];
    for (const buffer of cases) {
      const info = probeBuffer(buffer);
      expect(info.error, info.format).toBeTruthy();
    }
  });

  it("stops at the byte budget", () => {
    const info = probeBuffer(mp4({ faststart: false, mdat: 4096 }), 120);
    expect(info.width).toBeNull();
    expect(info.error).toBeTruthy();
    expect(PROBE_LIMITS.bytes).toBe(1024 * 1024);
  });
});

describe("probeFile", () => {
  it("probes a file on disk through positioned reads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chudcode-probe-"));
    try {
      const file = path.join(dir, "demo.mp4");
      fs.writeFileSync(file, mp4({ seconds: 61, faststart: false, mdat: 2 * 1024 * 1024 }));
      const info = probeFile(file);
      expect(info).toMatchObject({
        durationSeconds: 61,
        faststart: false,
        bytes: fs.statSync(file).size,
      });
      expect(probeFile(path.join(dir, "missing.png")).error).toBe("could not be opened");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
