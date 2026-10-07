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
  window.lilacRenderer = renderer;
  window.ready = true;
</script></body></html>`;

async function harness() {
  const session = await launchPage({ extraRoutes: { "/harness.html": { status: 200, contentType: "text/html", body: HARNESS } } });
  await session.page.goto(`${TEST_ORIGIN}/harness.html`);
  await session.page.waitForFunction(() => window.ready === true);
  await session.page.evaluate(async () => {
    const mounted = await window.lilacRenderer.mountSandboxedRenderer(document.getElementById("canvas"));
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
      const root = frameDoc.querySelector("[data-lilac-root]");
      return {
        sandbox: window.frame.getAttribute("sandbox"),
        html: root.innerHTML,
        size: window.r.size,
        heading: frameDoc.querySelector("h1").textContent,
        link: frameDoc.querySelector("a").getAttribute("href"),
        onclick: frameDoc.querySelector("a").getAttribute("onclick"),
        idsMatch: [...root.querySelectorAll("[data-lilac-id]")].every((el) => window.r.elementFor(el.getAttribute("data-lilac-id")) === el),
        hitTest: window.r.nodeIdFor(frameDoc.querySelector("h1").firstChild.parentElement),
        csp: frameDoc.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute("content"),
        heroStyle: frameDoc.querySelector("section").style.padding,
      };
    }, baseDocument());
    assert.equal(result.sandbox, "allow-same-origin");
    assert.equal(result.size, 7);
    assert.equal(result.heading, "Pricing");
    assert.equal(result.link, "https://example.com/buy");
    assert.equal(result.onclick, null, "event handlers are never rendered");
    assert.equal(result.idsMatch, true);
    assert.equal(result.hitTest, "title");
    assert.match(result.csp, /^default-src 'none'/u);
    assert.equal(result.heroStyle, "16px");
    assert.match(result.html, /^<main data-lilac-id="page" data-lilac-type="frame" style="[^"]*">/u);

    // Clicking a rendered link inside the sandbox neither runs script nor navigates anything.
    await page.frameLocator("iframe").locator("a").click({ timeout: 2000 });
    assert.equal(await page.evaluate(() => window.hacked === true), false);
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
        const root = window.frame.contentDocument.querySelector("[data-lilac-root]");
        return {
          created: window.r.stats.created - before.created,
          removed: window.r.stats.removed - before.removed,
          sameTitle: window.r.elementFor("title") === keep,
          order: [...root.querySelectorAll("li")].map((li) => li.textContent),
          ids: [...root.querySelectorAll("[data-lilac-id]")].map((el) => el.getAttribute("data-lilac-id")),
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
      const root = window.frame.contentDocument.querySelector("[data-lilac-root]");
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
    const result = await page.evaluate((d) => {
      window.r.render(d);
      const frameDoc = window.frame.contentDocument;
      // Even an image inserted behind the renderer's back is blocked by the frame's CSP.
      const rogue = frameDoc.createElement("img");
      rogue.src = "http://lilac.test/rogue.png";
      frameDoc.body.appendChild(rogue);
      return new Promise((resolve) => setTimeout(() => resolve({
        src: frameDoc.querySelector('[data-lilac-id="img"]').getAttribute("src"),
        alt: frameDoc.querySelector('[data-lilac-id="img"]').getAttribute("alt"),
        bg: frameDoc.querySelector('[data-lilac-id="bg"]').style.background,
        okSrc: frameDoc.querySelector('[data-lilac-id="ok"]').getAttribute("src"),
      }), 300));
    }, doc);
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
