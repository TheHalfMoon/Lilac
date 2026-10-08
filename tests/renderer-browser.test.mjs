import test from "node:test";
import assert from "node:assert/strict";

import { createDocument } from "../packages/document-model/src/index.mjs";
import { applyTransaction } from "../packages/history/src/index.mjs";
import { TEST_ORIGIN, browserTestOptions, launchPage } from "./support/browser.mjs";

// PC2 (#146): the renderer in a real Chromium. Web semantics inside a sandboxed frame with a
// stable node -> DOM identity, incremental patches from history's affectedNodeIds, and no
// script execution or network from rendered content. Advances PC gate 2.

const HARNESS = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="canvas"></div>
<script type="module">
  import * as renderer from "/packages/renderer/src/index.mjs";
  window.ninerrRenderer = renderer;
  window.ready = true;
</script></body></html>`;

async function harness() {
  const session = await launchPage({ extraRoutes: { "/harness.html": { status: 200, contentType: "text/html", body: HARNESS } } });
  await session.page.goto(`${TEST_ORIGIN}/harness.html`);
  await session.page.waitForFunction(() => window.ready === true);
  await session.page.evaluate(async () => {
    const mounted = await window.ninerrRenderer.mountSandboxedRenderer(document.getElementById("canvas"));
    window.frame = mounted.frame;
    window.r = mounted.renderer;
  });
  return session;
}

const baseDocument = () => createDocument({
  id: "doc",
  nodes: [
    { id: "page", type: "frame", children: ["hero", "list"], props: { tag: "main", style: { display: "flex", "flex-direction": "column", gap: "8px" } } },
    { id: "hero", type: "element", parentId: "page", children: ["title", "cta"], props: { tag: "section", attributes: { class: "hero", "aria-label": "Hero" }, style: { padding: "16px", background: "#eef" } } },
    { id: "title", type: "text", parentId: "hero", props: { tag: "h1", text: "Pricing" } },
    { id: "cta", type: "element", parentId: "hero", props: { tag: "a", text: "Choose", attributes: { href: "https://example.com/buy", onclick: "window.parent.hacked = true" } } },
    { id: "list", type: "element", parentId: "page", children: ["a", "b"], props: { tag: "ul" } },
    { id: "a", type: "element", parentId: "list", props: { tag: "li", text: "Alpha" } },
    { id: "b", type: "element", parentId: "list", props: { tag: "li", text: "Beta" } },
  ],
});

test("renders web semantics with stable identity inside a script-free sandbox", browserTestOptions(), async () => {
  const session = await harness();
  try {
    const { page } = session;
    const result = await page.evaluate((doc) => {
      window.r.render(doc);
      const frameDoc = window.frame.contentDocument;
      const root = frameDoc.querySelector("[data-ninerr-root]");
      return {
        sandbox: window.frame.getAttribute("sandbox"),
        html: root.innerHTML,
        size: window.r.size,
        heading: frameDoc.querySelector("h1").textContent,
        link: frameDoc.querySelector("a").getAttribute("data-ninerr-href"),
        liveHref: frameDoc.querySelector("a").getAttribute("href"),
        onclick: frameDoc.querySelector("a").getAttribute("onclick"),
        idsMatch: [...root.querySelectorAll("[data-ninerr-id]")].every((el) => window.r.elementFor(el.getAttribute("data-ninerr-id")) === el),
        hitTest: window.r.nodeIdFor(frameDoc.querySelector("h1").firstChild.parentElement),
        csp: frameDoc.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute("content"),
        heroStyle: frameDoc.querySelector("section").style.padding,
      };
    }, baseDocument());
    assert.equal(result.sandbox, "allow-same-origin");
    assert.equal(result.size, 7);
    assert.equal(result.heading, "Pricing");
    assert.equal(result.link, "https://example.com/buy");
    assert.equal(result.liveHref, null, "links are rendered inert");
    assert.equal(result.onclick, null, "event handlers are never rendered");
    assert.equal(result.idsMatch, true);
    assert.equal(result.hitTest, "title");
    assert.match(result.csp, /^default-src 'none'/u);
    assert.equal(result.heroStyle, "16px");
    assert.match(result.html, /^<main data-ninerr-id="page" data-ninerr-type="frame" style="[^"]*">/u);

    // Clicking or keyboard-activating a rendered link runs no script, makes no request, and
    // leaves the canvas document in place.
    // The rendered content is inert, so a real pointer at the link's position is the test.
    const box = await page.frameLocator("iframe").locator("a").boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "middle" });
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({
      hacked: window.hacked === true,
      alive: window.frame.contentDocument?.querySelector("[data-ninerr-root]") !== null && window.r.elementFor("title")?.isConnected === true,
      href: window.frame.contentDocument?.querySelector("a")?.getAttribute("href") ?? null,
    }));
    assert.deepEqual(after, { hacked: false, alive: true, href: null });
    assert.equal(await page.evaluate(() => window.frame.contentDocument.querySelector("[data-ninerr-root]").inert), true, "rendered controls are not interactive");
    assert.equal(session.requests.filter((url) => url.includes("example.com")).length, 0, "the link target was never requested");
    assert.equal(new URL(page.url()).pathname, "/harness.html");
    assert.deepEqual(session.errors, []);
  } finally {
    await session.close();
  }
});

test("patches touch only the affected nodes and keep element identity", browserTestOptions(), async () => {
  const session = await harness();
  try {
    const { page } = session;
    let doc = baseDocument();
    await page.evaluate((d) => window.r.render(d), doc);
    const step = async (operations) => {
      const result = applyTransaction(doc, { id: `t${Math.random()}`, actor: "u", operations });
      doc = result.document;
      return page.evaluate(({ d, affected }) => {
        const before = { ...window.r.stats };
        const keep = window.r.elementFor("title");
        window.r.patch(d, affected);
        const root = window.frame.contentDocument.querySelector("[data-ninerr-root]");
        return {
          created: window.r.stats.created - before.created,
          removed: window.r.stats.removed - before.removed,
          sameTitle: window.r.elementFor("title") === keep,
          order: [...root.querySelectorAll("li")].map((li) => li.textContent),
          ids: [...root.querySelectorAll("[data-ninerr-id]")].map((el) => el.getAttribute("data-ninerr-id")),
          title: window.r.elementFor("title")?.textContent ?? null,
        };
      }, { d: doc, affected: result.affectedNodeIds });
    };
    let after = await step([{ type: "set-props", nodeId: "title", set: { text: "Plans", style: { color: "red" } } }]);
    assert.equal(after.title, "Plans");
    assert.equal(after.created, 0, "an edit creates no elements");
    assert.equal(after.sameTitle, true, "the edited element keeps its identity");
    after = await step([{ type: "insert-node", node: { id: "c", type: "element", props: { tag: "li", text: "Gamma" } }, parentId: "list", index: 0 }]);
    assert.deepEqual(after.order, ["Gamma", "Alpha", "Beta"]);
    assert.equal(after.created, 1);
    after = await step([{ type: "move-node", nodeId: "c", parentId: "list", index: 2 }]);
    assert.deepEqual(after.order, ["Alpha", "Beta", "Gamma"]);
    assert.equal(after.created, 0, "a move reuses the element");
    after = await step([{ type: "move-node", nodeId: "b", parentId: "hero", index: 0 }]);
    assert.ok(after.ids.indexOf("b") < after.ids.indexOf("title"), "moved into another parent");
    assert.equal(after.created, 0);
    after = await step([{ type: "remove-node", nodeId: "list" }]);
    assert.deepEqual(after.order, ["Beta"], "the list and its items are gone; the moved item remains");
    assert.equal(after.removed, 3, "list, a and c are forgotten");
    // A full re-render from the same document produces the same DOM as the patched one.
    const consistent = await page.evaluate((d) => {
      const root = window.frame.contentDocument.querySelector("[data-ninerr-root]");
      const patched = root.innerHTML;
      window.r.render(d);
      return patched === root.innerHTML;
    }, doc);
    assert.equal(consistent, true, "patching and rendering from scratch agree");
  } finally {
    await session.close();
  }
});

test("rendered content cannot fetch: remote images are dropped and the frame blocks requests", browserTestOptions(), async () => {
  const session = await harness();
  try {
    const { page, requests } = session;
    const doc = createDocument({
      id: "doc",
      nodes: [
        { id: "img", type: "image", props: { attributes: { src: "https://evil.example/track.png", alt: "Tracked" } } },
        { id: "bg", type: "element", props: { style: { background: "url(https://evil.example/bg.png)", color: "blue" } } },
        { id: "ok", type: "image", props: { attributes: { src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", alt: "Pixel" } } },
      ],
    });
    const result = await page.evaluate(({ d, origin }) => {
      window.r.render(d);
      const frameDoc = window.frame.contentDocument;
      // Even an image inserted behind the renderer's back is blocked by the frame's CSP.
      const rogue = frameDoc.createElement("img");
      rogue.src = `${origin}/rogue.png`;
      frameDoc.body.appendChild(rogue);
      return new Promise((resolve) => setTimeout(() => resolve({
        src: frameDoc.querySelector('[data-ninerr-id="img"]').getAttribute("src"),
        alt: frameDoc.querySelector('[data-ninerr-id="img"]').getAttribute("alt"),
        bg: frameDoc.querySelector('[data-ninerr-id="bg"]').style.background,
        okSrc: frameDoc.querySelector('[data-ninerr-id="ok"]').getAttribute("src"),
      }), 300));
    }, { d: doc, origin: TEST_ORIGIN });
    assert.equal(result.src, null);
    assert.equal(result.alt, "Tracked");
    assert.equal(result.bg, "");
    assert.match(result.okSrc, /^data:image\/gif/u);
    assert.deepEqual(requests.filter((url) => !/\/(harness\.html|packages\/renderer\/src\/index\.mjs)$/u.test(url)), [], "no request left the page");
  } finally {
    await session.close();
  }
});

test("a 10,000-node document renders and patches within the PC gate 13 budgets", browserTestOptions(), async () => {
  const session = await harness();
  try {
    const { page } = session;
    const nodes = [{ id: "root", type: "frame", children: [], props: { tag: "main" } }];
    for (let i = 0; i < 9_999; i += 1) {
      nodes[0].children.push(`n${i}`);
      nodes.push({ id: `n${i}`, type: "text", parentId: "root", props: { tag: "p", text: `Row ${i}`, style: { margin: "0" } } });
    }
    let doc = createDocument({ id: "big", nodes });
    const firstMs = await page.evaluate((d) => {
      const start = performance.now();
      window.r.render(d);
      return performance.now() - start;
    }, doc);
    const patchMs = [];
    for (let i = 0; i < 20; i += 1) {
      const result = applyTransaction(doc, { id: `p${i}`, actor: "u", operations: [{ type: "set-props", nodeId: `n${i * 37}`, set: { text: `Edited ${i}` } }] });
      doc = result.document;
      patchMs.push(await page.evaluate(({ d, affected }) => {
        const start = performance.now();
        window.r.patch(d, affected);
        return performance.now() - start;
      }, { d: doc, affected: result.affectedNodeIds }));
    }
    patchMs.sort((a, b) => a - b);
    const p95 = patchMs[Math.ceil(patchMs.length * 0.95) - 1];
    process.stdout.write(`# renderer budget: first render ${firstMs.toFixed(0)} ms, patch p95 ${p95.toFixed(1)} ms\n`);
    assert.ok(firstMs <= 2000, `first render of 10,000 nodes took ${firstMs.toFixed(0)} ms; budget 2000 ms`);
    assert.ok(p95 <= 100, `single-node patch p95 ${p95.toFixed(1)} ms; budget 100 ms`);
    assert.equal(await page.evaluate(() => window.r.size), 10_000);
  } finally {
    await session.close();
  }
});

test("SVG keeps its required case, and a tag change patches like a fresh render", browserTestOptions(), async () => {
  const session = await harness();
  try {
    const { page } = session;
    let doc = createDocument({
      id: "doc",
      nodes: [
        { id: "icon", type: "vector", children: ["shape"], props: { attributes: { viewBox: "0 0 24 12", width: "48" } } },
        { id: "shape", type: "element", parentId: "icon", props: { tag: "rect", attributes: { width: "24", height: "12", fill: "teal" } } },
        { id: "heading", type: "text", children: ["inner"], props: { tag: "h1", text: "Title", style: { color: "red !important", width: "banana" } } },
        { id: "inner", type: "text", parentId: "heading", props: { tag: "em", text: "!" } },
      ],
    });
    const svg = await page.evaluate((d) => {
      window.r.render(d);
      const el = window.r.elementFor("icon");
      return { width: el.viewBox.baseVal.width, height: el.viewBox.baseVal.height, rect: window.r.elementFor("shape") instanceof window.frame.contentWindow.SVGRectElement, color: window.r.elementFor("heading").style.getPropertyPriority("color"), dropped: window.r.stats.dropped };
    }, doc);
    assert.deepEqual(svg, { width: 24, height: 12, rect: true, color: "important", dropped: 1 }, "viewBox applies, !important is a priority, an invalid value is counted");
    const result = applyTransaction(doc, { id: "t", actor: "u", operations: [{ type: "set-props", nodeId: "heading", set: { tag: "h2" } }] });
    doc = result.document;
    const patched = await page.evaluate(({ d, affected }) => {
      window.r.patch(d, affected);
      const root = window.frame.contentDocument.querySelector("[data-ninerr-root]");
      const html = root.innerHTML;
      const tag = window.r.elementFor("heading").localName;
      const innerKept = window.r.elementFor("inner")?.parentElement === window.r.elementFor("heading");
      window.r.render(d);
      return { tag, innerKept, same: html === root.innerHTML };
    }, { d: doc, affected: result.affectedNodeIds });
    assert.deepEqual(patched, { tag: "h2", innerKept: true, same: true });
  } finally {
    await session.close();
  }
});

test("patching agrees with a fresh render over a seeded random edit sequence", browserTestOptions(), async () => {
  const session = await harness();
  try {
    const { page } = session;
    let seed = 20261007;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (items) => items[Math.floor(random() * items.length)];
    const TAGS = ["div", "section", "p", "span", "h2", "ul", "li", "svg"];
    let doc = createDocument({ id: "fuzz", nodes: [{ id: "root", type: "frame", props: { tag: "main" } }] });
    // The renderer under test only ever patches; a separate reference renderer renders each
    // state from scratch, so drift that builds up across patches is caught.
    await page.evaluate((d) => {
      const host = window.frame.contentDocument.createElement("div");
      window.frame.contentDocument.body.appendChild(host);
      window.reference = { host, renderer: window.ninerrRenderer.createRenderer(host) };
      window.r.render(d);
    }, doc);
    let applied = 0;
    let next = 0;
    let mismatches = 0;
    for (let step = 0; step < 300; step += 1) {
      const ids = Object.keys(doc.nodes);
      const nonRoot = ids.filter((id) => id !== "root");
      const kind = nonRoot.length === 0 ? "insert" : pick(["insert", "insert", "move", "remove", "props", "tag"]);
      let operation;
      if (kind === "insert") operation = { type: "insert-node", node: { id: `n${next++}`, type: "element", props: { tag: pick(TAGS), text: `t${step}` } }, parentId: pick(ids), index: 0 };
      else if (kind === "remove") operation = { type: "remove-node", nodeId: pick(nonRoot) };
      else if (kind === "props") operation = { type: "set-props", nodeId: pick(ids), set: { text: `s${step}`, style: { color: pick(["red", "blue"]) } } };
      else if (kind === "tag") operation = { type: "set-props", nodeId: pick(nonRoot), set: { tag: pick(TAGS) } };
      else {
        const nodeId = pick(nonRoot);
        const targets = ids.filter((id) => id !== nodeId && !isInside(doc, id, nodeId));
        operation = { type: "move-node", nodeId, parentId: pick(targets), index: 0 };
      }
      let result;
      try {
        result = applyTransaction(doc, { id: `f${step}`, actor: "u", operations: [operation] });
      } catch {
        continue; // an operation history refuses changes nothing
      }
      doc = result.document;
      applied += 1;
      const same = await page.evaluate(({ d, affected }) => {
        window.r.patch(d, affected);
        window.reference.renderer.render(d);
        const root = window.frame.contentDocument.querySelector("[data-ninerr-root]");
        return root.innerHTML === window.reference.host.innerHTML && window.r.size === window.reference.renderer.size && window.r.size === Object.keys(d.nodes).length;
      }, { d: doc, affected: result.affectedNodeIds });
      if (!same) mismatches += 1;
    }
    assert.ok(applied >= 200, `${applied} random steps applied`);
    assert.equal(mismatches, 0, "every accumulated patch matched a fresh render and the identity map size");
  } finally {
    await session.close();
  }
});

function isInside(document, candidate, ancestor) {
  for (let cursor = document.nodes[candidate]; cursor; cursor = cursor.parentId === null ? null : document.nodes[cursor.parentId]) {
    if (cursor.id === ancestor) return true;
  }
  return false;
}
