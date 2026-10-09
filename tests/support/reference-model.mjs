// A reference model of document edits for tests (P08). It is written here from the documented
// meaning of each operation and shares no code with @ninerr/history or the studio host, so a
// test that compares the host with it cannot pass on a defect they share. It tracks what the
// operations change: the tree (root order, parents, children) and each node's props.

/** The part of a document the model tracks. */
export function shape(document) {
  return {
    rootIds: [...document.rootIds],
    nodes: Object.fromEntries(Object.entries(document.nodes).map(([id, node]) => [id, { type: node.type, parentId: node.parentId, children: [...node.children], props: structuredClone(node.props) }])),
  };
}

/**
 * Apply `operations` to `model` as one transaction: all of them or none. Returns the next
 * model and the operations that undo them (in the order to apply them), or null when the
 * host must refuse the transaction.
 */
export function applyOperations(model, operations) {
  const next = structuredClone(model);
  const inverse = [];
  for (const operation of operations) {
    const undo = applyOne(next, operation);
    if (undo === null) return null;
    inverse.unshift(undo);
  }
  return { model: next, inverse };
}

const has = (model, id) => typeof id === "string" && Object.hasOwn(model.nodes, id);
const siblingsOf = (model, parentId) => (parentId === null ? model.rootIds : model.nodes[parentId].children);

/** Put `id` under `parentId` at `index` (the end when absent); false when the index is past the end. */
function place(model, id, parentId, index) {
  const siblings = siblingsOf(model, parentId);
  const at = index ?? siblings.length;
  if (!Number.isSafeInteger(at) || at < 0 || at > siblings.length) return false;
  siblings.splice(at, 0, id);
  model.nodes[id].parentId = parentId;
  return true;
}

/** Take `id` out of its parent's children; returns where it was. */
function unlink(model, id) {
  const parentId = model.nodes[id].parentId;
  const siblings = siblingsOf(model, parentId);
  const index = siblings.indexOf(id);
  siblings.splice(index, 1);
  return { parentId, index };
}

function subtree(model, id) {
  return [id, ...model.nodes[id].children.flatMap((child) => subtree(model, child))];
}

function applyOne(model, operation) {
  switch (operation.type) {
    case "insert-node": {
      const { id, type, props = {} } = operation.node;
      const parentId = operation.parentId ?? null;
      if (has(model, id) || (parentId !== null && !has(model, parentId))) return null;
      model.nodes[id] = { type, parentId: null, children: [], props: structuredClone(props) };
      if (!place(model, id, parentId, operation.index)) return null;
      return { type: "remove-node", nodeId: id };
    }
    case "remove-node": {
      if (!has(model, operation.nodeId)) return null;
      const { parentId, index } = unlink(model, operation.nodeId);
      const ids = subtree(model, operation.nodeId);
      const nodes = ids.map((id) => ({ id, ...structuredClone(model.nodes[id]) }));
      for (const id of ids) delete model.nodes[id];
      return { type: "restore-subtree", rootId: operation.nodeId, parentId, index, nodes };
    }
    case "restore-subtree": {
      const parentId = operation.parentId ?? null;
      if (operation.nodes.some((node) => has(model, node.id)) || (parentId !== null && !has(model, parentId))) return null;
      for (const { id, type, parentId: nodeParent, children, props } of operation.nodes) model.nodes[id] = { type, parentId: nodeParent, children: [...children], props: structuredClone(props) };
      if (!place(model, operation.rootId, parentId, operation.index)) return null;
      return { type: "remove-node", nodeId: operation.rootId };
    }
    case "set-props": {
      if (!has(model, operation.nodeId)) return null;
      const props = model.nodes[operation.nodeId].props;
      const set = operation.set ?? {};
      const unset = operation.unset ?? [];
      const undo = { type: "set-props", nodeId: operation.nodeId, set: {}, unset: [] };
      for (const key of new Set([...Object.keys(set), ...unset])) {
        if (Object.hasOwn(props, key)) undo.set[key] = structuredClone(props[key]);
        else undo.unset.push(key);
      }
      for (const key of unset) delete props[key];
      Object.assign(props, structuredClone(set));
      return undo;
    }
    case "move-node": {
      const target = operation.parentId ?? null;
      if (!has(model, operation.nodeId) || (target !== null && !has(model, target))) return null;
      for (let at = target; at !== null; at = model.nodes[at].parentId) if (at === operation.nodeId) return null;
      const from = unlink(model, operation.nodeId);
      if (!place(model, operation.nodeId, target, operation.index)) return null;
      return { type: "move-node", nodeId: operation.nodeId, parentId: from.parentId, index: from.index };
    }
    default:
      throw new Error(`the reference model has no ${operation.type}`);
  }
}

/** A generated edit against `document`: insert, rename, unname, retext, restyle, move or remove. */
export function generatedEdit(prng, document, counter) {
  const ids = Object.keys(document.nodes);
  const kind = ids.length < 3 ? "insert" : prng.pick(["insert", "insert", "rename", "unname", "text", "style", "move", "remove"]);
  const anyParent = () => (ids.length === 0 || prng.next() < 0.3 ? null : prng.pick(ids));
  if (kind === "insert") {
    const id = `${counter.prefix ?? "n"}${counter.next++}`;
    const node = prng.next() < 0.5
      ? { id, type: "frame", props: { name: `Frame ${id}`, tag: "div", style: { width: `${prng.int(10, 400)}px` } } }
      : { id, type: "text", props: { name: `Text ${id}`, tag: prng.pick(["p", "h1", "span"]), text: prng.pick(["Hello", "Prix: 12 €", "مرحبا", "שלום", "é", "😀 ok", ""]) } };
    return { intent: `Insert ${id}`, operations: [{ type: "insert-node", node, parentId: anyParent(), index: prng.pick([undefined, 0, 99]) }] };
  }
  const nodeId = prng.pick(ids);
  if (kind === "rename") return { intent: `Rename ${nodeId}`, operations: [{ type: "set-props", nodeId, set: { name: `Renamed ${prng.int(0, 999)}` } }] };
  if (kind === "unname") return { intent: `Unname ${nodeId}`, operations: [{ type: "set-props", nodeId, set: {}, unset: ["name"] }] };
  if (kind === "text") return { intent: `Text ${nodeId}`, operations: [{ type: "set-props", nodeId, set: { text: prng.pick(["One", "Two\nlines", "‮bidi", "  spaced  "]) } }] };
  if (kind === "style") return { intent: `Style ${nodeId}`, operations: [{ type: "set-props", nodeId, set: { style: { color: prng.pick(["#112233", "red", "rgb(1, 2, 3)"]), padding: `${prng.int(0, 32)}px` } } }] };
  if (kind === "move") return { intent: `Move ${nodeId}`, operations: [{ type: "move-node", nodeId, parentId: anyParent(), index: prng.pick([undefined, 0, 1]) }] };
  return { intent: `Remove ${nodeId}`, operations: [{ type: "remove-node", nodeId }] };
}
