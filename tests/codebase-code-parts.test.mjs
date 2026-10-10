import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sameCode } from "../packages/studio-host/src/codebase.ts";
import { hostPool, ok } from "./support/host-api.mjs";

// P08-G11 (#282): a real component is mostly code. Bringing it in keeps the code (attributes
// such as className={cn(…)} and {...props}, {…} children, fragments, member tags) as
// read-only parts; the literal text and attributes around it become editable layers, and a
// write-back changes those literals only, leaving every byte of code as it was.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 11, 12, 0, 0) + clock++ * 1000).toISOString();
const PLAN = `import { cn } from "@/lib/utils";

export function PlanCard({ plan, className, ...props }: PlanCardProps) {
  const price = useMemo<number>(() => plan.price, [plan]);
  return (
    <section className={cn("card", className)} data-plan="pro" {...props}>
      <>
        <h2 title="Plan">Pro</h2>
        <p>Only {price} a month</p>
      </>
      {plan.features.map((feature) => <li key={feature}>{feature}</li>)}
      <Badge.Root tone="info">New</Badge.Root>
    </section>
  );
}
`;

async function connected(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ninerr-code-parts-")));
  const projects = join(root, "projects");
  const code = join(root, "app");
  mkdirSync(projects);
  mkdirSync(code);
  writeFileSync(join(code, "plan-card.tsx"), PLAN);
  const pool = hostPool(now);
  t.after(async () => {
    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  const { call } = await pool.open(projects);
  await ok(call("POST", "/api/projects/create", { name: "site" }), "create");
  const scan = await ok(call("POST", "/api/codebase/connect", { folder: code }), "connect");
  assert.deepEqual(scan.components, [{ file: "plan-card.tsx", component: "PlanCard" }]);
  const brought = await ok(call("POST", "/api/codebase/import", { file: "plan-card.tsx", component: "PlanCard" }), "bring in");
  const { document } = await ok(call("GET", "/api/document"), "document");
  return { call, document, brought, file: join(code, "plan-card.tsx") };
}

/** The layers in source order, as [type, tag or name, text, attributes]. */
function outline(document, id, out = []) {
  const node = document.nodes[id];
  out.push([node.type, node.props.name ?? node.props.tag ?? null, node.props.text ?? null, node.props.attributes ?? null]);
  for (const child of node.children) outline(document, child, out);
  return out;
}

test("a component made of code comes in with its literals editable and its code kept as read-only parts", async (t) => {
  const { document, brought } = await connected(t);
  const frame = document.nodes[brought.frameId];
  assert.deepEqual(outline(document, frame.children[0]), [
    ["element", "PlanCard", null, { "data-plan": "pro" }],
    ["element", "Fragment", null, {}],
    ["element", "h2", "Pro", { title: "Plan" }],
    ["element", "p", null, {}],
    ["text", null, "Only ", null],
    ["text", "Code", "{price}", null],
    ["text", null, " a month", null],
    ["text", "Code", "{plan.features.map((feature) => <li key={feature}>{feature}</li>)}", null],
    ["element", "Badge.Root", "New", { tone: "info" }],
  ]);
  const section = document.nodes[frame.children[0]];
  assert.deepEqual(section.props.codeSource.code, ["class", "..."], "className and the spread are code");
  const fragment = document.nodes[section.children[0]];
  assert.deepEqual(fragment.props.style, { display: "contents" });
});

test("a write-back changes the literals only, and every byte of code stays as it was", async (t) => {
  const { call, document, brought, file } = await connected(t);
  const ids = Object.values(document.nodes).filter((node) => node.props.codeSource);
  const find = (predicate) => ids.find(predicate).id;
  const section = document.nodes[brought.frameId].children[0];
  const heading = find((node) => node.props.tag === "h2");
  const run = find((node) => node.props.text === "Only ");
  const badge = find((node) => node.props.name === "Badge.Root");
  let { revision } = await ok(call("GET", "/api/document"), "document");
  const edit = async (operations) => {
    const event = await ok(call("POST", "/api/edit", { baseRevision: revision, intent: "Edit", operations }), "edit");
    revision = event.revision;
  };
  await edit([
    { type: "set-props", nodeId: heading, set: { text: "Team" } },
    { type: "set-props", nodeId: run, set: { text: "Just " } },
    { type: "set-props", nodeId: badge, set: { attributes: { tone: "warn" } } },
    { type: "set-props", nodeId: section, set: { attributes: { "data-plan": "team" } } },
  ]);
  const plan = await ok(call("POST", "/api/codebase/preview", { nodeId: section }), "preview");
  assert.deepEqual(plan.changes.map((change) => [change.field, change.from, change.to]).sort(), [["data-plan", "pro", "team"], ["text", "Only ", "Just "], ["text", "Pro", "Team"], ["tone", "info", "warn"]]);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.notWritten, []);
  await ok(call("POST", "/api/codebase/write", { nodeId: section, token: plan.token }), "write");
  assert.equal(readFileSync(file, "utf8"), PLAN.replace("data-plan=\"pro\"", "data-plan=\"team\"").replace(">Pro<", ">Team<").replace("Only {price}", "Just {price}").replace("tone=\"info\"", "tone=\"warn\""));
});

test("changes to code parts are listed as not written, and the file is not touched", async (t) => {
  const { call, document, brought, file } = await connected(t);
  const nodes = Object.values(document.nodes).filter((node) => node.props.codeSource);
  const section = document.nodes[brought.frameId].children[0];
  const expression = nodes.find((node) => node.props.text === "{price}").id;
  const fragment = document.nodes[section].children[0];
  let { revision } = await ok(call("GET", "/api/document"), "document");
  const event = await ok(call("POST", "/api/edit", { baseRevision: revision, intent: "Edit code parts", operations: [
    { type: "set-props", nodeId: expression, set: { text: "{cost}" } },
    { type: "set-props", nodeId: section, set: { attributes: { "data-plan": "pro", class: "card wide" } } },
    { type: "set-props", nodeId: fragment, set: { style: { display: "contents", color: "red" } } },
  ] }), "edit");
  revision = event.revision;
  const plan = await ok(call("POST", "/api/codebase/preview", { nodeId: section }), "preview");
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.diff, "");
  assert.deepEqual(plan.notWritten.map((entry) => entry.reason).sort(), [
    "a fragment (<>…</>) has no attributes or style; changes to it are not written back",
    "class is code in the source and is not written back",
    "{price} is code in the source; changes to it are not written back",
  ]);
  assert.equal(readFileSync(file, "utf8"), PLAN);
});

test("a patch that would change any code is refused whole", () => {
  // Literal edits keep the code parts byte for byte; anything else does not.
  const literal = PLAN.replace(">Pro<", ">Team<");
  assert.equal(sameCode(PLAN, literal, "plan-card.tsx", "PlanCard"), true);
  for (const altered of [
    PLAN.replace("cn(\"card\", className)", "cn(\"card\")"),
    PLAN.replace("{...props}", "{...rest}"),
    PLAN.replace("Only {price}", "Only {price * 2}"),
    PLAN.replace("{plan.features.map", "{plan.extras.map"),
  ]) assert.equal(sameCode(PLAN, altered, "plan-card.tsx", "PlanCard"), false, altered);
  // A file that no longer has the component is never the same code.
  assert.equal(sameCode(PLAN, PLAN.replace("PlanCard", "Other"), "plan-card.tsx", "PlanCard"), false);
});
