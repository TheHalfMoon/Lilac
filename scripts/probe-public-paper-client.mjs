import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const target = process.env.PAPER_PUBLIC_TARGET ||
  'https://app.paper.design/playground/heatmap?node=01K4PQADK7SX9ZFSZQ72Q7XMV3';

const headers = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function attrUrls(html, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*?\\b${attr}\\s*=\\s*(["'])(.*?)\\1`, 'gi');
  const values = [];
  for (const match of html.matchAll(re)) values.push(match[2]);
  return values;
}

function resolveAll(values, base) {
  return [...new Set(values.map((v) => new URL(v, base).href))];
}

async function fetchText(url, init = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  const body = await response.text();
  return { response, body };
}

async function inspectAsset(url) {
  try {
    const { response, body } = await fetchText(url, {
      headers: { accept: '*/*' },
    });
    const contentType = response.headers.get('content-type') || '';
    const record = {
      url,
      finalUrl: response.url,
      status: response.status,
      contentType,
      bytes: Buffer.byteLength(body),
      sha256: sha256(body),
      sourceMap: null,
    };

    if (response.ok && /javascript|ecmascript|text\//i.test(contentType)) {
      const explicit = body.match(/[#@]\s*sourceMappingURL\s*=\s*([^\s*]+)/g)?.at(-1);
      if (explicit) {
        const raw = explicit.replace(/^.*sourceMappingURL\s*=\s*/, '').trim();
        if (raw.startsWith('data:')) {
          record.sourceMap = { kind: 'inline-data-url' };
        } else {
          const mapUrl = new URL(raw, response.url).href;
          const mapResponse = await fetch(mapUrl, {
            redirect: 'follow',
            headers: { ...headers, accept: '*/*' },
          });
          const mapBody = await mapResponse.text();
          record.sourceMap = {
            kind: 'explicit',
            url: mapUrl,
            status: mapResponse.status,
            contentType: mapResponse.headers.get('content-type') || '',
            bytes: Buffer.byteLength(mapBody),
            sha256: sha256(mapBody),
          };
        }
      } else if (/javascript|ecmascript/i.test(contentType) || /\.m?js(?:\?|$)/i.test(url)) {
        const mapUrl = `${response.url}.map`;
        const mapResponse = await fetch(mapUrl, {
          redirect: 'manual',
          headers: { ...headers, accept: '*/*' },
        });
        const mapBody = await mapResponse.text();
        record.sourceMap = {
          kind: 'conventional-probe',
          url: mapUrl,
          status: mapResponse.status,
          contentType: mapResponse.headers.get('content-type') || '',
          bytes: Buffer.byteLength(mapBody),
          sha256: sha256(mapBody),
          looksLikeSourceMap:
            mapResponse.ok && /json/i.test(mapResponse.headers.get('content-type') || '') &&
            /"(?:sources|mappings)"\s*:/.test(mapBody.slice(0, 10000)),
        };
      }
    }

    return record;
  } catch (error) {
    return { url, error: error instanceof Error ? error.message : String(error) };
  }
}

const { response, body: html } = await fetchText(target);
const base = response.url;

const scripts = resolveAll(attrUrls(html, 'script', 'src'), base);
const links = resolveAll(attrUrls(html, 'link', 'href'), base);
const stylesheets = links.filter((url) => /\.css(?:\?|$)/i.test(url));
const modulePreloads = resolveAll(
  [...html.matchAll(/<link\b[^>]*?rel\s*=\s*(["'])modulepreload\1[^>]*?href\s*=\s*(["'])(.*?)\2/gi)].map((m) => m[3]),
  base,
);

const assetUrls = [...new Set([...scripts, ...stylesheets, ...modulePreloads])];
const assets = [];
for (const assetUrl of assetUrls) assets.push(await inspectAsset(assetUrl));

const report = {
  generatedAt: new Date().toISOString(),
  target,
  page: {
    status: response.status,
    finalUrl: response.url,
    contentType: response.headers.get('content-type') || '',
    bytes: Buffer.byteLength(html),
    sha256: sha256(html),
  },
  scripts,
  stylesheets,
  modulePreloads,
  links,
  assets,
};

await writeFile('paper-public-client-probe.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('PAPER_PUBLIC_CLIENT_PROBE_BEGIN');
console.log(JSON.stringify(report, null, 2));
console.log('PAPER_PUBLIC_CLIENT_PROBE_END');
