import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentRuntimeError,
  canonicalStringify,
  normalizeJson,
} from "../packages/agent-runtime/src/index.ts";

test("canonical JSON treats __proto__ as data without prototype mutation", () => {
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"z":1}');
  assert.equal(
    canonicalStringify(hostile),
    '{"__proto__":{"polluted":true},"z":1}',
  );
  assert.equal({}.polluted, undefined);
});

test("canonical JSON rejects accessors, class instances, sparse arrays, and excessive depth", () => {
  const accessor = {};
  Object.defineProperty(accessor, "secret", { enumerable: true, get() { return "executed"; } });
  assert.throws(() => normalizeJson(accessor), /own data value/);

  assert.throws(() => normalizeJson(new Date()), /must not be a class instance/);
  assert.throws(() => normalizeJson(new Array(1)), /own data value/);

  let deep = {};
  for (let index = 0; index < 130; index += 1) deep = { child: deep };
  assert.throws(() => normalizeJson(deep), AgentRuntimeError);
});
