import { findBrowser } from "./browser.mjs";

// Open the Ninerr editor of a running studio host in Chromium, as a person would from its
// launch link. Every request outside the host's origin is aborted and recorded, and page
// errors are collected, so a test can assert the editor stayed local and clean.
export async function openEditor(host) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const foreign = [];
  const errors = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(`${host.url}/`)) return route.continue();
    foreign.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(host.launchUrl());
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
  return { browser, page, foreign, errors, close: () => browser.close() };
}

export const waitRevision = (page, revision) => page.waitForFunction((r) => document.getElementById("revision").textContent === `Revision ${r}`, revision);
export const layerCount = (page) => page.locator("#layers [role=treeitem]").count();
export const rendered = (page, id, read) => page.evaluate(({ nodeId, property }) => {
  const element = document.querySelector("iframe").contentDocument.querySelector(`[data-ninerr-id="${nodeId}"]`);
  if (element === null) return null;
  return property === "text" ? element.textContent : property === "tag" ? element.localName : element.style.getPropertyValue(property);
}, { nodeId: id, property: read });
