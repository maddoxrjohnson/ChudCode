/**
 * page.ts: what a web page says about its media and how it will be shared.
 *
 * A small scanner over one HTML file, with no parser dependency: it finds the
 * `<meta>` tags that decide a link preview (Open Graph, Twitter cards, description),
 * every `<img>` with its alt text and declared size, every `<video>` with the
 * attributes that decide whether it plays inline and muted, its poster and its
 * caption tracks, and the local files the page references. It does not run scripts
 * or apply CSS, so anything a script adds later is invisible here, which the report
 * says.
 *
 * Links that start with `/` are collected separately: on a GitHub Pages project site
 * the page lives under `/<repo>/`, so a root-absolute link points outside the site.
 */

export interface PageImage {
  src: string;
  alt: string | null;
  width: string | null;
  height: string | null;
  loading: string | null;
  line: number;
}

export interface PageVideo {
  /** The `src` attribute, or the first `<source>`'s. */
  src: string | null;
  sources: string[];
  autoplay: boolean;
  muted: boolean;
  playsinline: boolean;
  loop: boolean;
  controls: boolean;
  poster: string | null;
  preload: string | null;
  /** `<track>` elements with kind captions or subtitles. */
  captions: string[];
  line: number;
}

export interface PageEmbed {
  /** An iframe's host, such as www.youtube.com. */
  host: string;
  line: number;
}

export interface PageScan {
  title: string | null;
  lang: string | null;
  /** `og:*`, `twitter:*`, `description`, keyed by property or name, first value wins. */
  meta: Record<string, string>;
  viewport: boolean;
  images: PageImage[];
  videos: PageVideo[];
  embeds: PageEmbed[];
  /** Local files the page references: images, video, posters, captions, styles, scripts. */
  assets: string[];
  /** href/src values starting with a single `/`. */
  rootAbsolute: Array<{ value: string; line: number }>;
}

interface Tag {
  name: string;
  attrs: Map<string, string>;
  line: number;
  /** Index just past the tag's `>`. */
  end: number;
}

const TAG =
  /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Same length, newlines kept, so indices and line numbers still match the source. */
const blank = (text: string): string => text.replace(/[^\n]/g, " ");

/** The tags of `html`, outside comments and the bodies of scripts and styles. */
function tags(html: string): Tag[] {
  const visible = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, blank)
    .replace(
      /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>|$)/gi,
      (_m, open: string, _name: string, body: string, close: string) => open + blank(body) + close,
    );
  const lineStarts = [0];
  for (let i = 0; i < html.length; i++) if (html[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const out: Tag[] = [];
  for (const match of visible.matchAll(TAG)) {
    const attrs = new Map<string, string>();
    for (const attr of (match[2] ?? "").matchAll(ATTR)) {
      const key = (attr[1] as string).toLowerCase();
      if (!attrs.has(key)) attrs.set(key, decode(attr[2] ?? attr[3] ?? attr[4] ?? ""));
    }
    const index = match.index ?? 0;
    out.push({
      name: (match[1] as string).toLowerCase(),
      attrs,
      line: lineOf(index),
      end: index + match[0].length,
    });
  }
  return out;
}

const has = (tag: Tag, name: string): boolean => tag.attrs.has(name);
const get = (tag: Tag, name: string): string | null => tag.attrs.get(name) ?? null;

/** Whether a reference names a file in the same site rather than another origin. */
export function isLocalRef(value: string): boolean {
  const v = value.trim();
  if (!v || v.startsWith("#") || v.startsWith("//")) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(v);
}

/** A local reference without its query or fragment, or null for remote ones. */
export function localPath(value: string): string | null {
  if (!isLocalRef(value)) return null;
  const clean = value.trim().split(/[?#]/)[0] as string;
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
  }
}

export function scanPage(html: string): PageScan {
  const scan: PageScan = {
    title: null,
    lang: null,
    meta: {},
    viewport: false,
    images: [],
    videos: [],
    embeds: [],
    assets: [],
    rootAbsolute: [],
  };
  const assets = new Set<string>();
  const addAsset = (value: string | null): void => {
    const local = value === null ? null : localPath(value);
    if (local) assets.add(local);
  };
  const noteLink = (value: string | null, line: number): void => {
    if (value && /^\/(?!\/)/.test(value.trim()))
      scan.rootAbsolute.push({ value: value.trim(), line });
  };

  const list = tags(html);
  let video: PageVideo | null = null;
  let videoEnd = -1;
  for (const tag of list) {
    for (const key of ["href", "src", "poster"]) noteLink(get(tag, key), tag.line);
    if (video && tag.end > videoEnd) video = null;
    switch (tag.name) {
      case "html":
        scan.lang = get(tag, "lang");
        break;
      case "meta": {
        const key = (get(tag, "property") ?? get(tag, "name") ?? "").toLowerCase();
        const content = get(tag, "content");
        if (key === "viewport") scan.viewport = true;
        if (content !== null && /^(og:|twitter:|description$)/.test(key) && !(key in scan.meta))
          scan.meta[key] = content.trim();
        break;
      }
      case "img":
        scan.images.push({
          src: get(tag, "src") ?? "",
          alt: get(tag, "alt"),
          width: get(tag, "width"),
          height: get(tag, "height"),
          loading: get(tag, "loading"),
          line: tag.line,
        });
        addAsset(get(tag, "src"));
        break;
      case "video": {
        video = {
          src: get(tag, "src"),
          sources: [],
          autoplay: has(tag, "autoplay"),
          muted: has(tag, "muted"),
          playsinline: has(tag, "playsinline"),
          loop: has(tag, "loop"),
          controls: has(tag, "controls"),
          poster: get(tag, "poster"),
          preload: get(tag, "preload"),
          captions: [],
          line: tag.line,
        };
        scan.videos.push(video);
        const close = html.toLowerCase().indexOf("</video", tag.end);
        videoEnd = close === -1 ? tag.end : close;
        addAsset(video.src);
        addAsset(video.poster);
        break;
      }
      case "source":
        if (video) {
          const src = get(tag, "src");
          if (src) {
            video.sources.push(src);
            video.src ??= src;
            addAsset(src);
          }
        } else addAsset(get(tag, "srcset")?.split(/\s/)[0] ?? null);
        break;
      case "track": {
        const kind = (get(tag, "kind") ?? "subtitles").toLowerCase();
        const src = get(tag, "src");
        if (video && src && (kind === "captions" || kind === "subtitles")) {
          video.captions.push(src);
          addAsset(src);
        }
        break;
      }
      case "iframe": {
        const src = get(tag, "src") ?? "";
        const host = /^(?:https?:)?\/\/([^/?#]+)/i.exec(src)?.[1];
        if (host) scan.embeds.push({ host: host.toLowerCase(), line: tag.line });
        break;
      }
      case "link": {
        const rel = (get(tag, "rel") ?? "").toLowerCase().split(/\s+/);
        if (rel.includes("stylesheet") || rel.includes("icon") || rel.includes("preload"))
          addAsset(get(tag, "href"));
        break;
      }
      case "script":
        addAsset(get(tag, "src"));
        break;
    }
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  if (title !== undefined) scan.title = decode(title).replace(/\s+/g, " ").trim();
  scan.assets = [...assets];
  return scan;
}

/** Image references in Markdown: `![alt](src)` and inline `<img>`/`<video>` HTML. */
export function scanMarkdown(markdown: string): {
  images: PageImage[];
  videos: PageVideo[];
  assets: string[];
} {
  const images: PageImage[] = [];
  const lines = markdown.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const match of line.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g))
      images.push({
        src: match[2] as string,
        alt: match[1] as string,
        width: null,
        height: null,
        loading: null,
        line: i + 1,
      });
  }
  const html = scanPage(markdown);
  const all = [...images, ...html.images].sort((a, b) => a.line - b.line);
  const assets = new Set(html.assets);
  for (const image of images) {
    const local = localPath(image.src);
    if (local) assets.add(local);
  }
  return { images: all, videos: html.videos, assets: [...assets] };
}
