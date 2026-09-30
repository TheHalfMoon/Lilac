import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const origin = 'https://app.paper.design';
const chunks = [
  '/assets/MCPHandlers-CJrIJGpp.js',
  '/assets/main-BsW7aFPG.js',
  '/assets/code-import-0ValKwcj.js',
  '/assets/to-html-CFNC8Out.js',
  '/assets/parse-figma-CkaBPLNN.js',
  '/assets/index-Bml-9gVJ.js',
];

const headers = {
  'user-agent': 'Mozilla/5.0 (compatible; Lilac-public-contract-probe/1.0)',
  accept: 'application/javascript,text/javascript,*/*;q=0.1',
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function stringLiterals(source) {
  const out = [];
  const re = /(["'`])((?:\\.|(?!\1)[\s\S]){1,180}?)\1/g;
  for (const m of source.matchAll(re)) {
    const raw = m[2];
    if (raw.includes('${')) continue;
    const value = raw
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\(["'`\\])/g, '$1');
    out.push({ value, index: m.index ?? 0 });
  }
  return out;
}

function snakeCandidates(literals) {
  const counts = new Map();
  for (const { value } of literals) {
    if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+){1,8}$/.test(value)) continue;
    if (value.length < 4 || value.length > 80) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

const toolVerb = /^(?:get|set|create|update|delete|rename|duplicate|move|find|list|write|export|open|finish|inspect|query|apply|assert|diff|compare|calculate|extract|refactor|configure|bind|check|pan|zoom|batch|insert|generate|transform|populate|localize|autofix|connect|audit|undo|rollback|read|resolve)_[a-z0-9_]+$/;
const styleWords = /^(?:background|backgroundColor|border|borderColor|borderRadius|borderWidth|boxShadow|color|display|fill|fontFamily|fontSize|fontStyle|fontWeight|gap|height|justifyContent|letterSpacing|lineHeight|margin|opacity|overflow|padding|position|rotate|scale|stroke|strokeWidth|textAlign|textDecoration|transform|translate|visibility|width|x|y)$/;
const nodeTypeWords = /^(?:artboard|frame|group|text|image|svg|video|component|instance|page|document|shape|rectangle|ellipse|line|path|vector|canvas|root|slot|variant|symbol)$/i;

function contextualStrings(source, literals, anchors, radius = 2400) {
  const results = new Map();
  for (const anchor of anchors) {
    let from = 0;
    while (true) {
      const pos = source.indexOf(anchor, from);
      if (pos < 0) break;
      const lo = Math.max(0, pos - radius);
      const hi = Math.min(source.length, pos + anchor.length + radius);
      for (const lit of literals) {
        if (lit.index < lo || lit.index > hi) continue;
        if (lit.value.length > 100) continue;
        const key = lit.value;
        if (!results.has(key)) results.set(key, new Set());
        results.get(key).add(anchor);
      }
      from = pos + anchor.length;
    }
  }
  return [...results.entries()].map(([value, anchorSet]) => ({
    value,
    anchors: [...anchorSet].sort(),
  }));
}

function enumLike(literals) {
  const common = new Map();
  const re = /^(?:auto|absolute|relative|fixed|static|flex|grid|block|inline|none|visible|hidden|scroll|clip|row|column|wrap|nowrap|start|center|end|stretch|space-between|space-around|space-evenly|solid|dashed|dotted|left|right|top|bottom|horizontal|vertical|light|dark|mixed|fit-content|min-content|max-content|hug|fill|fixed-width|fixed-height)$/;
  for (const { value } of literals) {
    if (re.test(value)) common.set(value, (common.get(value) || 0) + 1);
  }
  return [...common.entries()].map(([value, count]) => ({ value, count })).sort((a,b)=>b.count-a.count||a.value.localeCompare(b.value));
}

async function fetchChunk(path) {
  const url = new URL(path, origin).href;
  const response = await fetch(url, { headers, redirect: 'follow' });
  const body = await response.text();
  if (!response.ok || !/javascript|ecmascript/i.test(response.headers.get('content-type') || '')) {
    throw new Error(`Expected JavaScript at ${url}; got ${response.status} ${response.headers.get('content-type')}`);
  }
  return { url, body, contentType: response.headers.get('content-type') || '' };
}

const report = {
  generatedAt: new Date().toISOString(),
  source: 'public production client assets served by app.paper.design',
  chunks: [],
  aggregate: {
    toolNames: [],
    stylePropertyCandidates: [],
    nodeTypeCandidates: [],
    enumCandidates: [],
    mcpContextStrings: [],
    transactionContextStrings: [],
  },
};

const aggTools = new Map();
const aggStyles = new Map();
const aggNodes = new Map();
const aggEnums = new Map();
const mcpContext = new Map();
const txContext = new Map();

for (const path of chunks) {
  const { url, body, contentType } = await fetchChunk(path);
  const literals = stringLiterals(body);
  const snakes = snakeCandidates(literals);
  const toolNames = snakes.filter(({ value }) => toolVerb.test(value));
  const stylePropertyCandidates = [];
  const nodeTypeCandidates = [];
  for (const { value } of literals) {
    if (styleWords.test(value)) stylePropertyCandidates.push(value);
    if (nodeTypeWords.test(value)) nodeTypeCandidates.push(value.toLowerCase());
  }
  const enums = enumLike(literals);

  for (const item of toolNames) aggTools.set(item.value, (aggTools.get(item.value) || 0) + item.count);
  for (const value of stylePropertyCandidates) aggStyles.set(value, (aggStyles.get(value) || 0) + 1);
  for (const value of nodeTypeCandidates) aggNodes.set(value, (aggNodes.get(value) || 0) + 1);
  for (const item of enums) aggEnums.set(item.value, (aggEnums.get(item.value) || 0) + item.count);

  const mcp = contextualStrings(body, literals, [
    'dispatchToolCall', 'gatedMCPToolCall', 'resolveMCPHandlers',
    'get_tree_summary', 'get_computed_styles', 'write_html', 'create_artboard',
  ]).filter(({ value }) =>
    toolVerb.test(value) ||
    /^[A-Za-z][A-Za-z0-9_.-]{1,64}$/.test(value) ||
    /^(?:properties|required|type|items|enum|description|additionalProperties)$/.test(value)
  );
  for (const item of mcp) {
    if (!mcpContext.has(item.value)) mcpContext.set(item.value, new Set());
    for (const a of item.anchors) mcpContext.get(item.value).add(a);
  }

  const tx = contextualStrings(body, literals, [
    'transaction', 'undo', 'redo', 'history', 'treeUtils', 'selection',
  ], 1600).filter(({ value }) =>
    /^[A-Za-z][A-Za-z0-9_.-]{1,64}$/.test(value) && value.length <= 65
  );
  for (const item of tx) {
    if (!txContext.has(item.value)) txContext.set(item.value, new Set());
    for (const a of item.anchors) txContext.get(item.value).add(a);
  }

  report.chunks.push({
    url,
    bytes: Buffer.byteLength(body),
    sha256: sha256(body),
    contentType,
    stringLiteralCount: literals.length,
    toolNames,
    enumCandidates: enums,
  });
}

const mapToSorted = (map) => [...map.entries()]
  .map(([value, count]) => ({ value, count }))
  .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

report.aggregate.toolNames = mapToSorted(aggTools);
report.aggregate.stylePropertyCandidates = mapToSorted(aggStyles);
report.aggregate.nodeTypeCandidates = mapToSorted(aggNodes);
report.aggregate.enumCandidates = mapToSorted(aggEnums);
report.aggregate.mcpContextStrings = [...mcpContext.entries()]
  .map(([value, anchors]) => ({ value, anchors: [...anchors].sort() }))
  .sort((a,b)=>a.value.localeCompare(b.value));
report.aggregate.transactionContextStrings = [...txContext.entries()]
  .map(([value, anchors]) => ({ value, anchors: [...anchors].sort() }))
  .sort((a,b)=>a.value.localeCompare(b.value));

await writeFile('paper-editor-contracts.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('PAPER_EDITOR_CONTRACTS_BEGIN');
console.log(JSON.stringify(report, null, 2));
console.log('PAPER_EDITOR_CONTRACTS_END');
