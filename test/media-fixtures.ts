/**
 * Tiny media files built byte by byte: just the headers a probe reads, with no real
 * pixels or frames, so tests can name the exact size, codec, and layout they expect.
 */

const u16be = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u16le = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32be = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u32le = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const ascii = (s: string): Buffer => Buffer.from(s, "latin1");

function pngChunk(type: string, data: Buffer): Buffer {
  return Buffer.concat([u32be(data.length), ascii(type), data, u32be(0)]);
}

export function png(width: number, height: number, { animated = false } = {}): Buffer {
  const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...(animated ? [pngChunk("acTL", Buffer.concat([u32be(2), u32be(0)]))] : []),
    pngChunk("IDAT", Buffer.alloc(16)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0]),
    u16be(16),
    ascii("JFIF\0"),
    Buffer.alloc(9),
  ]);
  const sof = Buffer.concat([
    Buffer.from([0xff, 0xc0]),
    u16be(17),
    Buffer.from([8]),
    u16be(height),
    u16be(width),
    Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof,
    Buffer.from([0xff, 0xda]),
    Buffer.alloc(8),
    Buffer.from([0xff, 0xd9]),
  ]);
}

export function gif(width: number, height: number, frames = 1): Buffer {
  const parts = [
    ascii("GIF89a"),
    u16le(width),
    u16le(height),
    Buffer.from([0x80, 0, 0]),
    Buffer.alloc(6),
  ];
  for (let i = 0; i < frames; i++) {
    parts.push(Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]));
    parts.push(
      Buffer.concat([
        Buffer.from([0x2c]),
        u16le(0),
        u16le(0),
        u16le(width),
        u16le(height),
        Buffer.from([0]),
      ]),
    );
    parts.push(Buffer.from([2, 2, 0x4c, 0x01, 0]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

function riff(chunk: string, data: Buffer): Buffer {
  const body = Buffer.concat([ascii("WEBP"), ascii(chunk), u32le(data.length), data]);
  return Buffer.concat([ascii("RIFF"), u32le(body.length), body]);
}

export function webp(
  width: number,
  height: number,
  variant: "VP8" | "VP8L" | "VP8X" = "VP8",
  animated = false,
): Buffer {
  if (variant === "VP8")
    return riff(
      "VP8 ",
      Buffer.concat([
        Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a]),
        u16le(width),
        u16le(height),
        Buffer.alloc(4),
      ]),
    );
  if (variant === "VP8L") {
    const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
    return riff("VP8L", Buffer.concat([Buffer.from([0x2f]), u32le(bits >>> 0), Buffer.alloc(5)]));
  }
  const canvas = Buffer.alloc(10);
  canvas[0] = animated ? 0x02 : 0;
  canvas.writeUIntLE(width - 1, 4, 3);
  canvas.writeUIntLE(height - 1, 7, 3);
  return riff("VP8X", canvas);
}

// ── ISO BMFF ──────────────────────────────────────────────────────────────────

export function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  return Buffer.concat([u32be(8 + body.length), ascii(type), body]);
}

const fullBox = (type: string, version: number, ...payload: Buffer[]): Buffer =>
  box(type, Buffer.from([version, 0, 0, 0]), ...payload);

function tkhd(width: number, height: number): Buffer {
  return fullBox(
    "tkhd",
    0,
    Buffer.alloc(20), // creation, modification, track id, reserved, duration
    Buffer.alloc(8),
    Buffer.alloc(8), // layer, group, volume, reserved
    Buffer.alloc(36),
    u32be(width * 65536),
    u32be(height * 65536),
  );
}

function trak(handler: "vide" | "soun", codec: string, width = 0, height = 0): Buffer {
  const hdlr = fullBox("hdlr", 0, u32be(0), ascii(handler), Buffer.alloc(12), Buffer.from([0]));
  const stsd = fullBox("stsd", 0, u32be(1), box(codec, Buffer.alloc(8)));
  return box("trak", tkhd(width, height), box("mdia", hdlr, box("minf", box("stbl", stsd))));
}

export interface Mp4Options {
  width?: number;
  height?: number;
  seconds?: number;
  codec?: string;
  audio?: boolean;
  faststart?: boolean;
  /** Bytes of fake media data. */
  mdat?: number;
  version1?: boolean;
}

export function mp4({
  width = 1920,
  height = 1080,
  seconds = 30,
  codec = "avc1",
  audio = false,
  faststart = true,
  mdat = 64,
  version1 = false,
}: Mp4Options = {}): Buffer {
  const timescale = 1000;
  const mvhd = version1
    ? fullBox(
        "mvhd",
        1,
        Buffer.alloc(16),
        u32be(timescale),
        Buffer.from(new BigUint64Array([0n]).buffer),
        Buffer.alloc(80),
      )
    : fullBox(
        "mvhd",
        0,
        Buffer.alloc(8),
        u32be(timescale),
        u32be(seconds * timescale),
        Buffer.alloc(80),
      );
  if (version1) mvhd.writeBigUInt64BE(BigInt(seconds * timescale), 8 + 4 + 20);
  const moov = box(
    "moov",
    mvhd,
    trak("vide", codec, width, height),
    ...(audio ? [trak("soun", "mp4a")] : []),
  );
  const ftyp = box("ftyp", ascii("isom"), u32be(512), ascii("isomiso2avc1mp41"));
  const data = box("mdat", Buffer.alloc(mdat));
  return Buffer.concat(faststart ? [ftyp, moov, data] : [ftyp, data, moov]);
}

export function avif(width: number, height: number): Buffer {
  const ftyp = box("ftyp", ascii("avif"), u32be(0), ascii("avifmif1miaf"));
  const ispe = fullBox("ispe", 0, u32be(width), u32be(height));
  const meta = fullBox(
    "meta",
    0,
    fullBox("hdlr", 0, u32be(0), ascii("pict"), Buffer.alloc(13)),
    box("iprp", box("ipco", ispe)),
  );
  return Buffer.concat([ftyp, meta, box("mdat", Buffer.alloc(16))]);
}

// ── EBML ──────────────────────────────────────────────────────────────────────

function idBytes(id: number): Buffer {
  const bytes: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from(bytes);
}

function sizeBytes(size: number): Buffer {
  // Always eight bytes: simple, and legal.
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(size));
  b[0] = 0x01;
  return b;
}

export function el(id: number, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  return Buffer.concat([idBytes(id), sizeBytes(body.length), body]);
}

const uintEl = (id: number, value: number): Buffer => el(id, u32be(value));

export interface WebmOptions {
  width?: number;
  height?: number;
  seconds?: number;
  codec?: string;
  audio?: boolean;
  /** Write the Segment with an unknown size, as live encoders do. */
  unknownSize?: boolean;
}

export function webm({
  width = 1280,
  height = 720,
  seconds = 12.5,
  codec = "V_VP9",
  audio = false,
  unknownSize = false,
}: WebmOptions = {}): Buffer {
  const header = el(0x1a45dfa3, el(0x4282, ascii("webm")));
  const duration = Buffer.alloc(8);
  duration.writeDoubleBE(seconds * 1000);
  const info = el(0x1549a966, uintEl(0x2ad7b1, 1_000_000), el(0x4489, duration));
  const video = el(
    0xae,
    uintEl(0x83, 1),
    el(0x86, ascii(codec)),
    el(0xe0, uintEl(0xb0, width), uintEl(0xba, height)),
  );
  const tracks = el(
    0x1654ae6b,
    video,
    ...(audio ? [el(0xae, uintEl(0x83, 2), el(0x86, ascii("A_OPUS")))] : []),
  );
  const cluster = el(0x1f43b675, Buffer.alloc(32));
  const body = Buffer.concat([info, tracks, cluster]);
  const segment = unknownSize
    ? Buffer.concat([
        idBytes(0x18538067),
        Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
        body,
      ])
    : el(0x18538067, body);
  return Buffer.concat([header, segment]);
}
