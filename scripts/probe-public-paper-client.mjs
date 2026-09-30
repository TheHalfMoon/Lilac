import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const target = process.env.PAPER_PUBLIC_TARGET ||
  'https://app.paper.design/playground/heatmap?node=01K4PQADK7SX9ZFSZQ72Q7XMV3';
const maxAssets = Number(process.env.PAPER_PROBE_MAX_ASSETS || 160);

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

function publicAssetRefs(body, base) {
  const refs = new Set();
  const patterns = [
    /(?:import\s*\(|from\s*|import\s*)["']([^"']+\.(?:m?js|css|wasm)(?:\?[^"']*)?)["']/g,
    /["']([^"']*\/assets\/[^"']+\.(?:m?js|css|wasm)(?:\?[^"']*)?)["']/g,
    /["']([^"']+\.(?:m?js|css|wasm)(?:\?[^"']*)?)["']/g,
  ];
  for (const re of patterns) {
    for (const match of body.matchAll(re)) {
      try {
        const url = new URL(match[1], base);
        if (url.origin === new URL(base).origin) refs.add(url.href);
      } catch {}
    }
  }
  return [...refs];
}

const signals = {
  runtime: [
    'resolveMCPHandlers', 'dispatchToolCall', 'gatedMCPToolCall', 'write_html',
    'get_tree_summary', 'get_computed_styles', 'get_screenshot', 'get_jsx',
    'create_artboard', 'update_styles', 'set_text_content', 'get_tokens', 'set_tokens',
  ],
  document: [
    'artboard', 'selection', 'computedStyle', 'documentModel', 'treeUtils',
    'undo', 'redo', 'history', 'transaction', 'clipboard', 'snap', 'guide',
  ],
  collaboration: [
    'WebSocket', 'presence', 'multiplayer', 'awareness', 'yjs', 'Y.Doc', 'crdt',
    'sync.paper.design',
  ],
  editor: [
    'canvas', 'viewport', 'camera', 'zoom', 'pan', 'transform', 'resize',
    'richText', 'contenteditable', 'drag', 'drop', 'frame', 'component', 'variant',
  ],
  code: [
    'tailwind', 'jsx', 'react', 'html', 'css', 'sourceBinding', 'codegen', 'export',
  ],
  libraries: [
    'React', 'react-dom', 'zustand', 'jotai', 'valtio', 'mobx', 'redux', 'yjs',
    'tldraw', 'fabric', 'pixi', 'three', 'konva', 'lexical', 'slate', 'tiptap',
    'prosemirror', 'codemirror', 'monaco', 'framer-motion', 'radix', 'floating-ui',
  ],
  paperPackages: [
    '@paper/models', '@paper/assets', '@paper/cli', '@paper/client-desktop-types',
    '@paper/',
  ],
};

function signalHits(body) {
  const out = {};
  for (const [group, terms] of Object.entries(signals)) {
    const hits = [];
    for (const term of terms) {
      let count = 0;
      let from = 0;
      while (true) {
        const at = body.indexOf(term, from);
        if (at < 0) break;
        count += 1;
        from = at + term.length;
      }
      if (count) hits.push({ term, count });
    }
    if (hits.length) out[group] = hits;
  }
  return out;
}

function routeAndEndpointStrings(body) {
  const found = new Set();
  const re = /["'`]((?:https?:\/\/|wss?:\/\/|\/api\/|\/file\/|\/playground\/)[^"'`\\\s]{2,220})["'`]/g;
  for (const match of body.matchAll(re)) {
    const value = match[1];
    if (!value.includes('${') && found.size < 250) found.add(value);
  }
  return [...found].sort();
}

function cssVariables(body) {
  const found = new Set();
  for (const match of body.matchAll(/--[a-zA-Z0-9_-]{2,80}/g)) {
    if (found.size < 400) found.add(match[0]);
  }
  return [...found].sort();
}

async function inspectAsset(url) {
  try {
    const { response, body } = await fetchText(url, { headers: { accept: '*/*' } });
    const contentType = response.headers.get('content-type') || '';
    const isJs = response.ok && (/javascript|ecmascript/i.test(contentType) || /\.m?js(?:\?|$)/i.test(response.url));
    const isCss = response.ok && (/text\/css/i.test(contentType) || /\.css(?:\?|$)/i.test(response.url));
    const record = {
      url,
      finalUrl: response.url,
      status: response.status,
      contentType,
      bytes: Buffer.byteLength(body),
      sha256: sha256(body),
      references: isJs || isCss ? publicAssetRefs(body, response.url) : [],
      signals: isJs ? signalHits(body) : {},
      routesAndEndpoints: isJs ? routeAndEndpointStrings(body) : [],
      cssVariables: isCss ? cssVariables(body) : [],
      sourceMap: null,
    };

    if (isJs) {
      const explicit = body.match(/[#@]\s*sourceMappingURL\s*=\s*([^\s*]+)/g)?.at(-1);
      if (explicit) {
        const raw = explicit.replace(/^.*sourceMappingURL\s*=\s*/, '').trim();
        if (raw.startsWith('data:')) {
          record.sourceMap = { kind: 'inline-data-url' };
        } else {
          const mapUrl = new URL(raw, response.url).href;
          const mapResponse = await fetch(mapUrl, { redirect: 'follow', headers: { ...headers, accept: '*/*' } });
          const mapBody = await mapResponse.text();
          record.sourceMap = {
            kind: 'explicit', url: mapUrl, status: mapResponse.status,
            contentType: mapResponse.headers.get('content-type') || '',
            bytes: Buffer.byteLength(mapBody), sha256: sha256(mapBody),
            looksLikeSourceMap: mapResponse.ok && /"(?:sources|mappings)"\s*:/.test(mapBody.slice(0, 20000)),
          };
        }
      } else {
        const mapUrl = `${response.url}.map`;
        const mapResponse = await fetch(mapUrl, { redirect: 'manual', headers: { ...headers, accept: '*/*' } });
        const mapBody = await mapResponse.text();
        record.sourceMap = {
          kind: 'conventional-probe', url: mapUrl, status: mapResponse.status,
          contentType: mapResponse.headers.get('content-type') || '',
          bytes: Buffer.byteLength(mapBody), sha256: sha256(mapBody),
          looksLikeSourceMap: mapResponse.ok && /json/i.test(mapResponse.headers.get('content-type') || '') &&
            /"(?:sources|mappings)"\s*:/.test(mapBody.slice(0, 20000)),
        };
      }
    }
    return record;
  } catch (error) {
    return { url, error: error instanceof Error ? error.message : String(error), references: [] };
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

const queue = [...new Set([...scripts, ...stylesheets, ...modulePreloads])];
const seen = new Set();
const assets = [];
while (queue.length && seen.size < maxAssets) {
  const url = queue.shift();
  if (seen.has(url)) continue;
  seen.add(url);
  const record = await inspectAsset(url);
  assets.push(record);
  for (const ref of record.references || []) {
    if (!seen.has(ref) && !queue.includes(ref) && seen.size + queue.length < maxAssets) queue.push(ref);
  }
}

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
  scripts, stylesheets, modulePreloads, links,
  graph: {
    discoveredAssetCount: assets.length,
    truncatedAt: maxAssets,
    jsCount: assets.filter((a) => /javascript|ecmascript/i.test(a.contentType || '') || /\.m?js(?:\?|$)/i.test(a.url || '')).length,
    cssCount: assets.filter((a) => /text\/css/i.test(a.contentType || '') || /\.css(?:\?|$)/i.test(a.url || '')).length,
    totalBytes: assets.reduce((sum, a) => sum + (a.bytes || 0), 0),
    sourceMapsFound: assets.filter((a) => a.sourceMap?.looksLikeSourceMap || a.sourceMap?.kind === 'inline-data-url').map((a) => a.url),
  },
  assets,
};

await writeFile('paper-public-client-probe.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('PAPER_PUBLIC_CLIENT_PROBE_BEGIN');
console.log(JSON.stringify(report, null, 2));
console.log('PAPER_PUBLIC_CLIENT_PROBE_END');
