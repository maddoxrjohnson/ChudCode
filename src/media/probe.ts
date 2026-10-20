/**
 * probe.ts: what an image or video file is, from its headers alone.
 *
 * A media lab measures the learner's demo video and promo images without ffprobe or a
 * browser, so this reads the few bytes each format puts its facts in: PNG's IHDR, a
 * JPEG frame header, GIF's screen descriptor and frame count, WebP's VP8/VP8L/VP8X
 * header, SVG's width/height/viewBox, AVIF's `ispe`, and for video the ISO BMFF boxes
 * of an MP4 (duration, size, codec, an audio track, whether `moov` precedes `mdat`) or
 * the EBML elements of a WebM. The format comes from magic bytes, never the extension.
 *
 * Nothing here decodes pixels or frames, and every read is bounded: a file is probed
 * through positioned reads that together stay under `PROBE_LIMITS.bytes`, boxes and
 * elements are counted and nested only so deep, and a truncated or hostile file comes
 * back with `error` set rather than a throw.
 */

import * as fs from "node:fs";

export const PROBE_LIMITS = {
  /** Bytes read from one file, across every positioned read. */
  bytes: 1024 * 1024,
  /** Boxes, chunks, or elements visited in one file. */
  nodes: 20_000,
  depth: 12,
};

export type MediaFormat =
  "png" | "jpeg" | "gif" | "webp" | "svg" | "avif" | "mp4" | "webm" | "unknown";

export interface MediaInfo {
  format: MediaFormat;
  kind: "image" | "video" | null;
  bytes: number;
  width: number | null;
  height: number | null;
  /** Images: more than one frame (GIF, APNG, animated WebP). */
  animated?: boolean;
  /** GIF: frames counted within the read budget. */
  frames?: number;
  durationSeconds?: number | null;
  /** The video track's codec: a fourcc for MP4 (avc1, hvc1, av01), a CodecID for WebM. */
  videoCodec?: string | null;
  audio?: boolean;
  /** MP4: `moov` comes before `mdat`, so playback can start before the download ends. */
  faststart?: boolean | null;
  /** Why the facts are missing or partial, when they are. */
  error?: string;
}

/** Positioned reads over a file or a buffer, with a byte budget shared by all of them. */
export interface ByteSource {
  size: number;
  read(offset: number, length: number): Buffer;
}

class Budget {
  used = 0;
  nodes = 0;
  private readonly source: ByteSource;
  private readonly limit: number;
  constructor(source: ByteSource, limit: number) {
    this.source = source;
    this.limit = limit;
  }
  get size(): number {
    return this.source.size;
  }
  read(offset: number, length: number): Buffer {
    if (offset < 0 || offset >= this.source.size || length <= 0) return Buffer.alloc(0);
    const want = Math.min(length, this.source.size - offset, this.limit - this.used);
    if (want <= 0) throw new ProbeStop("read budget spent");
    this.used += want;
    return this.source.read(offset, want);
  }
  visit(): void {
    if (++this.nodes > PROBE_LIMITS.nodes) throw new ProbeStop("too many boxes");
  }
}

class ProbeStop extends Error {}

export function bufferSource(buffer: Buffer): ByteSource {
  return {
    size: buffer.length,
    read: (offset, length) => buffer.subarray(offset, offset + length),
  };
}

/** Probe a file on disk. The caller has already decided the path is safe to open. */
export function probeFile(file: string, limit = PROBE_LIMITS.bytes): MediaInfo {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return blank("unknown", 0, "could not be opened");
  }
  try {
    const size = fs.fstatSync(fd).size;
    const source: ByteSource = {
      size,
      read(offset, length) {
        const buffer = Buffer.alloc(length);
        const read = fs.readSync(fd, buffer, 0, length, offset);
        return buffer.subarray(0, read);
      },
    };
    return probeSource(source, limit);
  } finally {
    fs.closeSync(fd);
  }
}

export function probeBuffer(buffer: Buffer, limit = PROBE_LIMITS.bytes): MediaInfo {
  return probeSource(bufferSource(buffer), limit);
}

export function probeSource(source: ByteSource, limit = PROBE_LIMITS.bytes): MediaInfo {
  if (source.size === 0) return blank("unknown", 0, "empty");
  const budget = new Budget(source, limit);
  const head = budget.read(0, 64);
  const format = sniff(head);
  const info = blank(format, source.size);
  try {
    switch (format) {
      case "png":
        probePng(budget, info);
        break;
      case "jpeg":
        probeJpeg(budget, info);
        break;
      case "gif":
        probeGif(budget, info);
        break;
      case "webp":
        probeWebp(budget, info);
        break;
      case "svg":
        probeSvg(budget, info);
        break;
      case "avif":
      case "mp4":
        probeIsoBmff(budget, info);
        break;
      case "webm":
        probeWebm(budget, info);
        break;
      case "unknown":
        info.error = "not an image or video format ChudCode reads";
    }
  } catch (err) {
    info.error = err instanceof ProbeStop ? err.message : "unreadable";
  }
  if (!info.error && (info.width === null || info.height === null))
    info.error = "no dimensions found";
  return info;
}

function blank(format: MediaFormat, bytes: number, error?: string): MediaInfo {
  const kind =
    format === "mp4" || format === "webm" ? "video" : format === "unknown" ? null : "image";
  const info: MediaInfo = { format, kind, bytes, width: null, height: null };
  if (kind === "video") {
    info.durationSeconds = null;
    info.videoCodec = null;
    info.audio = false;
  }
  if (format === "mp4") info.faststart = null;
  if (error) info.error = error;
  return info;
}

function sniff(head: Buffer): MediaFormat {
  if (
    head.length >= 8 &&
    head.readUInt32BE(0) === 0x89504e47 &&
    head.readUInt32BE(4) === 0x0d0a1a0a
  )
    return "png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  const ascii = head.toString("latin1");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "webp";
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return "webm";
  if (ascii.slice(4, 8) === "ftyp") {
    const brand = ascii.slice(8, 12);
    return brand === "avif" || brand === "avis" ? "avif" : "mp4";
  }
  const text = head
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (/^<(\?xml|svg|!--)/i.test(text)) return "svg";
  return "unknown";
}

// ── Images ────────────────────────────────────────────────────────────────────

function probePng(budget: Budget, info: MediaInfo): void {
  let offset = 8;
  info.animated = false;
  while (offset + 8 <= budget.size) {
    budget.visit();
    const header = budget.read(offset, 8);
    if (header.length < 8) break;
    const length = header.readUInt32BE(0);
    const type = header.toString("latin1", 4, 8);
    if (type === "IHDR") {
      const data = budget.read(offset + 8, 8);
      if (data.length < 8) throw new ProbeStop("truncated");
      info.width = data.readUInt32BE(0);
      info.height = data.readUInt32BE(4);
    } else if (type === "acTL") info.animated = true;
    // Animation control must come before the first image data.
    if (type === "IDAT" || type === "IEND") break;
    offset += 12 + length;
  }
}

function probeJpeg(budget: Budget, info: MediaInfo): void {
  let offset = 2;
  while (offset + 4 <= budget.size) {
    budget.visit();
    const marker = budget.read(offset, 4);
    if (marker.length < 4) break;
    if (marker[0] !== 0xff) throw new ProbeStop("unreadable");
    const code = marker[1] as number;
    if (code === 0xff) {
      offset += 1;
      continue;
    }
    if (code === 0xd8 || code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (code === 0xd9 || code === 0xda) break;
    const length = marker.readUInt16BE(2);
    if (length < 2) throw new ProbeStop("unreadable");
    const isFrame = code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc;
    if (isFrame) {
      const frame = budget.read(offset + 4, 5);
      if (frame.length < 5) throw new ProbeStop("truncated");
      info.height = frame.readUInt16BE(1);
      info.width = frame.readUInt16BE(3);
      return;
    }
    offset += 2 + length;
  }
}

function probeGif(budget: Budget, info: MediaInfo): void {
  const screen = budget.read(6, 7);
  if (screen.length < 7) throw new ProbeStop("truncated");
  info.width = screen.readUInt16LE(0);
  info.height = screen.readUInt16LE(2);
  const flags = screen[4] as number;
  let offset = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  let frames = 0;
  const skipSubBlocks = (): void => {
    for (;;) {
      budget.visit();
      const size = budget.read(offset, 1)[0];
      if (size === undefined) throw new ProbeStop("truncated");
      offset += 1 + size;
      if (size === 0) return;
    }
  };
  try {
    while (offset < budget.size) {
      budget.visit();
      const block = budget.read(offset, 1)[0];
      if (block === 0x3b || block === undefined) break;
      if (block === 0x21) {
        offset += 2;
        skipSubBlocks();
      } else if (block === 0x2c) {
        frames++;
        if (frames > 1) break;
        const descriptor = budget.read(offset + 1, 9);
        if (descriptor.length < 9) break;
        const local = descriptor[8] as number;
        offset += 10 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0) + 1;
        skipSubBlocks();
      } else break;
    }
  } catch (err) {
    // A large GIF can outrun the budget after its first frame; what was counted stands.
    if (!(err instanceof ProbeStop) || frames === 0) throw err;
  }
  if (frames === 0) throw new ProbeStop("no frames");
  info.frames = frames;
  info.animated = frames > 1;
}

function probeWebp(budget: Budget, info: MediaInfo): void {
  const chunk = budget.read(12, 18);
  if (chunk.length < 18) throw new ProbeStop("truncated");
  const type = chunk.toString("latin1", 0, 4);
  info.animated = false;
  if (type === "VP8 ") {
    if (chunk[11] !== 0x9d || chunk[12] !== 0x01 || chunk[13] !== 0x2a)
      throw new ProbeStop("unreadable");
    info.width = chunk.readUInt16LE(14) & 0x3fff;
    info.height = chunk.readUInt16LE(16) & 0x3fff;
  } else if (type === "VP8L") {
    if (chunk[8] !== 0x2f) throw new ProbeStop("unreadable");
    const bits = chunk.readUInt32LE(9);
    info.width = (bits & 0x3fff) + 1;
    info.height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (type === "VP8X") {
    info.animated = ((chunk[8] as number) & 0x02) !== 0;
    info.width = chunk.readUIntLE(12, 3) + 1;
    info.height = chunk.readUIntLE(15, 3) + 1;
  } else throw new ProbeStop("unreadable");
}

function probeSvg(budget: Budget, info: MediaInfo): void {
  const text = budget.read(0, 16 * 1024).toString("utf8");
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) throw new ProbeStop("no <svg> element");
  const attr = (name: string): string | undefined =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
  const px = (value: string | undefined): number | null => {
    const match = value ? /^\s*([\d.]+)\s*(px)?\s*$/.exec(value) : null;
    return match ? Math.round(Number(match[1])) : null;
  };
  info.width = px(attr("width"));
  info.height = px(attr("height"));
  const box = attr("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box && box.length === 4 && box.every(Number.isFinite)) {
    info.width ??= Math.round(box[2] as number);
    info.height ??= Math.round(box[3] as number);
  }
}

// ── ISO BMFF: MP4, MOV, AVIF ──────────────────────────────────────────────────

interface Box {
  type: string;
  /** Where the box's payload starts and ends. */
  start: number;
  end: number;
  offset: number;
}

function* boxes(budget: Budget, start: number, end: number, depth: number): Generator<Box> {
  if (depth > PROBE_LIMITS.depth) throw new ProbeStop("boxes nested too deep");
  let offset = start;
  while (offset + 8 <= end) {
    budget.visit();
    const header = budget.read(offset, 16);
    if (header.length < 8) return;
    let size = header.readUInt32BE(0);
    const type = header.toString("latin1", 4, 8);
    let headerBytes = 8;
    if (size === 1) {
      if (header.length < 16) return;
      size = Number(header.readBigUInt64BE(8));
      headerBytes = 16;
    } else if (size === 0) size = end - offset;
    if (size < headerBytes || offset + size > end) {
      // A box that runs past its parent: report what came before it and stop.
      yield { type, start: offset + headerBytes, end, offset };
      return;
    }
    yield { type, start: offset + headerBytes, end: offset + size, offset };
    offset += size;
  }
}

function child(budget: Budget, parent: Box, type: string, depth: number, skip = 0): Box | null {
  for (const box of boxes(budget, parent.start + skip, parent.end, depth))
    if (box.type === type) return box;
  return null;
}

function probeIsoBmff(budget: Budget, info: MediaInfo): void {
  let moov: Box | null = null;
  let mdatAt: number | null = null;
  let meta: Box | null = null;
  for (const box of boxes(budget, 0, budget.size, 0)) {
    if (box.type === "moov") moov ??= box;
    else if (box.type === "mdat") mdatAt ??= box.offset;
    else if (box.type === "meta") meta ??= box;
  }
  if (info.format === "avif") {
    // meta is a full box: four bytes of version and flags before its children.
    const iprp = meta && child(budget, meta, "iprp", 1, 4);
    const ipco = iprp && child(budget, iprp, "ipco", 2);
    const ispe = ipco && child(budget, ipco, "ispe", 3);
    if (!ispe) throw new ProbeStop("no image size box");
    const data = budget.read(ispe.start, 12);
    if (data.length < 12) throw new ProbeStop("truncated");
    info.width = data.readUInt32BE(4);
    info.height = data.readUInt32BE(8);
    return;
  }
  if (!moov) {
    info.error = mdatAt === null ? "no movie header" : "no movie header within the read budget";
    return;
  }
  info.faststart = mdatAt === null ? true : moov.offset < mdatAt;
  for (const box of boxes(budget, moov.start, moov.end, 1)) {
    if (box.type === "mvhd") {
      const data = budget.read(box.start, 32);
      const v1 = data[0] === 1;
      const timescale = v1 ? data.readUInt32BE(20) : data.readUInt32BE(12);
      const duration = v1 ? Number(data.readBigUInt64BE(24)) : data.readUInt32BE(16);
      if (timescale > 0) info.durationSeconds = Math.round((duration / timescale) * 100) / 100;
    } else if (box.type === "trak") probeTrack(budget, box, info);
  }
}

function probeTrack(budget: Budget, trak: Box, info: MediaInfo): void {
  const mdia = child(budget, trak, "mdia", 2);
  const hdlr = mdia && child(budget, mdia, "hdlr", 3);
  const handler = hdlr ? budget.read(hdlr.start + 8, 4).toString("latin1") : "";
  if (handler === "soun") {
    info.audio = true;
    return;
  }
  if (handler !== "vide" || info.videoCodec) return;
  const tkhd = child(budget, trak, "tkhd", 2);
  if (tkhd) {
    const version = budget.read(tkhd.start, 1)[0];
    const at = tkhd.start + (version === 1 ? 88 : 76);
    const size = budget.read(at, 8);
    if (size.length === 8) {
      info.width = size.readUInt32BE(0) >>> 16;
      info.height = size.readUInt32BE(4) >>> 16;
    }
  }
  const minf = mdia && child(budget, mdia, "minf", 3);
  const stbl = minf && child(budget, minf, "stbl", 4);
  const stsd = stbl && child(budget, stbl, "stsd", 5);
  if (stsd) {
    const entry = budget.read(stsd.start + 8, 8);
    if (entry.length === 8) info.videoCodec = entry.toString("latin1", 4, 8);
  }
}

// ── EBML: WebM and Matroska ───────────────────────────────────────────────────

const EBML = {
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackType: 0x83,
  codecId: 0x86,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cluster: 0x1f43b675,
};

interface Element {
  id: number;
  start: number;
  end: number;
}

/** A variable-length integer at `offset`: its value and how many bytes it took. */
function vint(
  budget: Budget,
  offset: number,
  keepMarker: boolean,
): { value: number; length: number; unknown: boolean } {
  const first = budget.read(offset, 1)[0];
  if (first === undefined || first === 0) throw new ProbeStop("unreadable");
  const length = Math.clz32(first) - 23;
  const bytes = budget.read(offset, length);
  if (bytes.length < length) throw new ProbeStop("truncated");
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + (bytes[i] as number);
    if (bytes[i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function* elements(budget: Budget, start: number, end: number, depth: number): Generator<Element> {
  if (depth > PROBE_LIMITS.depth) throw new ProbeStop("elements nested too deep");
  let offset = start;
  while (offset < end) {
    budget.visit();
    const id = vint(budget, offset, true);
    const size = vint(budget, offset + id.length, false);
    const dataStart = offset + id.length + size.length;
    const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
    yield { id: id.value, start: dataStart, end: dataEnd };
    if (size.unknown) return;
    offset = dataStart + size.value;
  }
}

function uint(budget: Budget, element: Element): number {
  const bytes = budget.read(element.start, Math.min(8, element.end - element.start));
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

function probeWebm(budget: Budget, info: MediaInfo): void {
  const [header] = elements(budget, 0, budget.size, 0);
  if (!header) throw new ProbeStop("unreadable");
  let scale = 1_000_000;
  let duration: number | null = null;
  for (const top of elements(budget, header.end, budget.size, 0)) {
    if (top.id !== EBML.segment) continue;
    for (const section of elements(budget, top.start, top.end, 1)) {
      if (section.id === EBML.cluster) break;
      if (section.id === EBML.info) {
        for (const field of elements(budget, section.start, section.end, 2)) {
          if (field.id === EBML.timecodeScale) scale = uint(budget, field);
          else if (field.id === EBML.duration) {
            const bytes = budget.read(field.start, field.end - field.start);
            duration =
              bytes.length === 4
                ? bytes.readFloatBE(0)
                : bytes.length === 8
                  ? bytes.readDoubleBE(0)
                  : null;
          }
        }
      } else if (section.id === EBML.tracks) {
        for (const entry of elements(budget, section.start, section.end, 2)) {
          if (entry.id === EBML.trackEntry) probeWebmTrack(budget, entry, info);
        }
      }
    }
    break;
  }
  if (duration !== null) info.durationSeconds = Math.round(((duration * scale) / 1e9) * 100) / 100;
}

function probeWebmTrack(budget: Budget, entry: Element, info: MediaInfo): void {
  let type = 0;
  let codec = "";
  let width: number | null = null;
  let height: number | null = null;
  for (const field of elements(budget, entry.start, entry.end, 3)) {
    if (field.id === EBML.trackType) type = uint(budget, field);
    else if (field.id === EBML.codecId)
      codec = budget.read(field.start, Math.min(32, field.end - field.start)).toString("latin1");
    else if (field.id === EBML.video) {
      for (const video of elements(budget, field.start, field.end, 4)) {
        if (video.id === EBML.pixelWidth) width = uint(budget, video);
        else if (video.id === EBML.pixelHeight) height = uint(budget, video);
      }
    }
  }
  if (type === 2) info.audio = true;
  if (type === 1 && !info.videoCodec) {
    info.videoCodec = codec.replace(/\0+$/, "");
    info.width = width;
    info.height = height;
  }
}
