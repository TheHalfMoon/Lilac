import { ImportSecurityError } from "./errors.ts";

export const FORBIDDEN_IMPORT_TAGS = new Set([
  "script", "iframe", "object", "embed", "applet", "frame", "frameset",
  "base", "template", "meta", "link", "style", "form", "math",
  "foreignobject", "animate", "animatemotion", "animatetransform", "animatecolor", "set", "discard",
]);

export const STORED_URL_ATTRIBUTES = new Set([
  "href", "src", "poster", "cite", "background", "action", "formaction", "xlink:href", "srcset",
]);

// Attributes that carry form submission authority: a submission target, or a
// form-owner association that could attach an imported control to a host form.
export const FORM_AUTHORITY_ATTRIBUTES = new Set([
  "action", "formaction", "form", "formmethod", "formtarget", "formenctype", "formnovalidate",
]);

// Attributes that make the browser contact a URL outside the resource model (beacons,
// attribution reporting, preload candidates, plugin and description URLs, base URLs).
export const REMOTE_AUTHORITY_ATTRIBUTES = new Set([
  "ping", "attributionsrc", "imagesrcset", "codebase", "archive", "classid", "longdesc",
  "xml:base", "profile", "manifest", "dynsrc", "lowsrc", "itemid", "icon",
]);

// Attributes that let imported markup act on host-page elements or upgrade into host
// custom elements.
export const HOST_AUTHORITY_ATTRIBUTES = new Set([
  "is", "commandfor", "command", "popovertarget", "popovertargetaction", "interestfor",
  "invoketarget", "invokeaction",
]);

export const PRESENTATION_URL_ATTRIBUTES = new Set([
  "fill", "stroke", "filter", "clip-path", "mask",
  "marker-start", "marker-mid", "marker-end", "cursor",
]);

function cssSecurityView(rawCss: string): string {
  // CSS input preprocessing first: CR LF, CR and FF become LF, so an escape followed by
  // CR LF consumes the whole line break as a browser does (for example `\75<CR><LF>rl(`
  // is `url(`), and NUL becomes U+FFFD.
  const css = rawCss.replace(/\r\n|[\r\f]/gu, "\n").replace(/\0/gu, "\ufffd");
  // Strip CSS line continuations (backslash + newline) before and after
  // escape decoding: a real CSS engine ignores them, so keywords split
  // across a continuation (for example `u\<LF>rl(`) must be visible here.
  const withoutContinuations = (value: string): string =>
    value.replace(/\\(?:\r\n|[\r\n\f])/gu, "");
  const decoded = withoutContinuations(css)
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\\([0-9a-fA-F]{1,6})\s?/gu, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    })
    .replace(/\\([^\r\n0-9a-fA-F])/gu, "$1");
  return withoutContinuations(decoded).toLowerCase();
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
  // Fragment-only references stay inert only when they cannot break out of
  // a downstream serialized attribute or carry control characters: reject
  // quotes, angle brackets, backticks, backslashes, and C0/C1 controls while
  // still allowing internationalized fragment text.
  if (/^#[^\s]*$/u.test(value) && !/["'<>`\\\u0000-\u001f\u007f-\u009f]/u.test(value)) return true;
  return /^\.\/objects\/[a-f0-9]{64}$/u.test(value);
}
