import { ImportSecurityError } from "./errors.ts";

export const FORBIDDEN_IMPORT_TAGS = new Set([
  "script", "iframe", "object", "embed", "applet", "frame", "frameset",
  "base", "template", "meta", "link", "style", "form", "math",
  "foreignobject", "animate", "animatemotion", "animatetransform", "set", "discard",
]);

export const STORED_URL_ATTRIBUTES = new Set([
  "href", "src", "poster", "cite", "background", "action", "formaction", "xlink:href", "srcset",
]);

export const PRESENTATION_URL_ATTRIBUTES = new Set([
  "fill", "stroke", "filter", "clip-path", "mask",
  "marker-start", "marker-mid", "marker-end", "cursor",
]);

function cssSecurityView(css: string): string {
  // Strip CSS line continuations (backslash + newline) before and after
  // escape decoding: a real CSS engine ignores them, so keywords split
  // across a continuation (for example `u\<LF>rl(`) must be visible here.
  const withoutContinuations = (value: string): string =>
    value.replace(/\\(?:\r\n|[\r\n\f])/gu, "");
  return withoutContinuations(withoutContinuations(css)
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\\([0-9a-fA-F]{1,6})\s?/gu, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    })
    .replace(/\\([^\r\n0-9a-fA-F])/gu, "$1"))
    .toLowerCase();
}

export function sanitizeImportedCssText(
  css: string,
  maxBytes: number,
): { cssText: string | null; unsafe: boolean } {
  if (Buffer.byteLength(css, "utf8") > maxBytes) {
    throw new ImportSecurityError("imported stylesheet exceeds maxCssBytes");
  }
  const view = cssSecurityView(css);
  const unsafe = (
    /@import\b/u.test(view)
    || /expression\s*\(/u.test(view)
    || /url\s*\(/u.test(view)
    || /image-set\s*\(/u.test(view)
    || /image\s*\(/u.test(view)
    || /(?:javascript|vbscript):/u.test(view)
    || /-moz-binding\s*:/u.test(view)
    || /(?:^|[;{])\s*behavior\s*:/u.test(view)
  );
  return { cssText: unsafe ? null : css.trim(), unsafe };
}

export function isForbiddenImportTag(tag: string): boolean {
  const normalized = tag.toLowerCase();
  return FORBIDDEN_IMPORT_TAGS.has(normalized) || normalized.includes("-");
}

export function isSafeStoredUrlReference(value: string): boolean {
  return /^#[^\s]*$/u.test(value) || /^\.\/objects\/[a-f0-9]{64}$/u.test(value);
}
