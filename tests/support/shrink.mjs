// Greedy shrinker for design documents: repeatedly applies the first smaller variant that
// still fails, until none does. Used to report the minimal input of a differential
// divergence. Variants: drop a child, hoist a child over its parent, drop a prop, drop the
// text, and remove one character of a text or string prop.

function nodeVariants(node) {
  const out = [];
  const children = node.children ?? [];
  for (let index = 0; index < children.length; index += 1) {
    const rest = children.filter((_child, other) => other !== index);
    out.push({ ...node, children: rest.length === 0 ? undefined : rest });
    out.push(children[index]);
  }
  for (const key of Object.keys(node.props)) {
    const props = { ...node.props };
    delete props[key];
    out.push({ ...node, props });
    const value = node.props[key];
    if (typeof value === "string") {
      for (let index = 0; index < value.length; index += 1) out.push({ ...node, props: { ...node.props, [key]: value.slice(0, index) + value.slice(index + 1) } });
    }
  }
  if (node.text !== undefined) {
    out.push({ ...node, text: undefined });
    for (let index = 0; index < node.text.length; index += 1) out.push({ ...node, text: node.text.slice(0, index) + node.text.slice(index + 1) });
  }
  children.forEach((child, index) => {
    for (const variant of nodeVariants(child)) {
      const replaced = [...children];
      replaced[index] = variant;
      out.push({ ...node, children: replaced });
    }
  });
  return out;
}

const clean = (node) => {
  const out = { tag: node.tag, props: node.props };
  if (node.text !== undefined) out.text = node.text;
  if (node.children !== undefined && node.children.length > 0) out.children = node.children.map(clean);
  return out;
};

export function shrinkDesign(doc, fails, maxSteps = 2_000) {
  let current = doc;
  for (let step = 0; step < maxSteps; step += 1) {
    const smaller = nodeVariants(current.root).map((root) => ({ ...current, root: clean(root) })).find((candidate) => fails(candidate));
    if (smaller === undefined) return current;
    current = smaller;
  }
  return current;
}
