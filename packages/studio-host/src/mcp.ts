import { randomUUID } from "node:crypto";
import { MCPAuthorizationError, MCPContractError, PAPER_MCP_TOOL_NAMES, classifyPaperTool, mcpArgumentsSha256, requireMCPToolCall, validateMCPServerConfig } from "@lilac/mcp-protocol";
import { StudioError } from "./errors.ts";
import type { StudioActor, StudioSession } from "./session.ts";

// Lilac's MCP server. It runs inside the studio host, so agent edits go through the same
// single writer as the editor's, and every one is a history transaction attributed to the
// agent. The transport is MCP's Streamable HTTP in its plain request/response form
// (POST /mcp, one JSON-RPC message, one JSON answer) on the host's loopback listener; the
// stdio relay (relay.ts) forwards a stdio MCP client to it.
//
// Every tools/call is authorized by requireMCPToolCall before anything is dispatched. The
// actor is the agent the request's credential belongs to, never anything in the payload,
// and a confirmation for a consequential tool comes only from the person approving it in
// the editor (the host's own confirmation flow), never from the client (#82, P06 G8).

export const MCP_PROTOCOL_VERSIONS = Object.freeze(["2025-06-18", "2025-03-26", "2024-11-05"]);
const SERVER_INFO = Object.freeze({ name: "lilac", title: "Lilac", version: "0.0.0" });
const MAX_RESULT_NODES = 500;
const MAX_TREE_DEPTH = 12;
const MAX_DUPLICATED_NODES = 5_000;
// How long a consequential call waits for the person before answering "still pending".
export const CONFIRMATION_WAIT_MS = 50_000;
// How long a request, or an approval not yet used by a retry, stays valid.
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (context: ToolContext, args: Record<string, any>) => Json | Promise<Json>;
}
interface ToolContext {
  session: StudioSession;
  actor: StudioActor;
  toolName: string;
  selection: () => string[];
  edit: (operations: unknown[], intent: string) => Json;
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const idList = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 500 };

function nodeOf(session: StudioSession, id: unknown) {
  const document = session.document as any;
  if (typeof id !== "string" || !Object.hasOwn(document.nodes, id)) throw new ToolError(`no node ${JSON.stringify(String(id)).slice(0, 80)}`);
  return document.nodes[id];
}

function summary(node: any) {
  const props = node.props ?? {};
  return {
    id: node.id,
    type: node.type,
    ...(typeof props.tag === "string" ? { tag: props.tag } : {}),
    ...(typeof props.name === "string" ? { name: props.name } : {}),
    ...(typeof props.text === "string" ? { text: props.text.slice(0, 200) } : {}),
    childCount: node.children.length,
  };
}

class ToolError extends Error {}

const strings = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500 || value.some((item) => typeof item !== "string")) throw new ToolError(`${label} must be a list of 1-500 node ids`);
  return value as string[];
};

const TOOLS: Tool[] = [
  {
    name: "get_basic_info",
    title: "Project information",
    description: "The open project: its name, document id and name, revision, node count and root layers.",
    inputSchema: object({}),
    run: ({ session }) => {
      const document = session.document as any;
      return { project: session.name, documentId: document.id, documentName: document.name, revision: session.revision, nodeCount: Object.keys(document.nodes).length, roots: document.rootIds.map((id: string) => summary(document.nodes[id])) };
    },
  },
  {
    name: "get_tree_summary",
    title: "Layer tree",
    description: "The layer tree under a node (or the whole document), to a depth (default 3, at most 12), at most 500 nodes.",
    inputSchema: object({ nodeId: { type: "string" }, depth: { type: "integer", minimum: 1, maximum: MAX_TREE_DEPTH } }),
    run: ({ session }, args) => {
      const document = session.document as any;
      const depth = Math.min(MAX_TREE_DEPTH, Math.max(1, Number.isInteger(args.depth) ? args.depth : 3));
      let budget = MAX_RESULT_NODES;
      let truncated = false;
      // Depth-first, taking one node of the budget per node shown and stopping when it runs out.
      const walk = (id: string, level: number): Json => {
        budget -= 1;
        const node = document.nodes[id];
        const out: Record<string, Json> = summary(node);
        if (level < depth && node.children.length > 0) {
          const children: Json[] = [];
          for (const child of node.children) {
            if (budget <= 0) {
              truncated = true;
              break;
            }
            children.push(walk(child, level + 1));
          }
          out.children = children;
        }
        return out;
      };
      const roots = args.nodeId === undefined ? document.rootIds : [nodeOf(session, args.nodeId).id];
      const tree: Json[] = [];
      for (const id of roots) {
        if (budget <= 0) {
          truncated = true;
          break;
        }
        tree.push(walk(id, 1));
      }
      return { revision: session.revision, tree, truncated };
    },
  },
  {
    name: "get_node_info",
    title: "Layer details",
    description: "One layer: its type, parent, children and properties (tag, text, name, attributes, style).",
    inputSchema: object({ nodeId: { type: "string" } }, ["nodeId"]),
    run: ({ session }, args) => {
      const node = nodeOf(session, args.nodeId);
      return { id: node.id, type: node.type, parentId: node.parentId, children: node.children, props: node.props };
    },
  },
  {
    name: "get_children",
    title: "Child layers",
    description: "The direct children of a layer, or the root layers.",
    inputSchema: object({ nodeId: { type: "string" } }),
    run: ({ session }, args) => {
      const document = session.document as any;
      const ids = args.nodeId === undefined ? document.rootIds : nodeOf(session, args.nodeId).children;
      return { children: ids.slice(0, MAX_RESULT_NODES).map((id: string) => summary(document.nodes[id])) };
    },
  },
  {
    name: "find_nodes",
    title: "Find layers",
    description: "Layers whose name or text contains `query` (case-insensitive), optionally of a type or tag; at most `limit` (default 50, at most 500).",
    inputSchema: object({ query: { type: "string" }, type: { type: "string" }, tag: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_NODES } }),
    run: ({ session }, args) => {
      const document = session.document as any;
      const query = typeof args.query === "string" ? args.query.toLowerCase() : null;
      const limit = Number.isInteger(args.limit) ? Math.min(MAX_RESULT_NODES, Math.max(1, args.limit)) : 50;
      const found = [];
      for (const node of Object.values(document.nodes) as any[]) {
        if (found.length >= limit) break;
        if (args.type !== undefined && node.type !== args.type) continue;
        if (args.tag !== undefined && node.props?.tag !== args.tag) continue;
        if (query !== null && ![node.props?.name, node.props?.text].some((value) => typeof value === "string" && value.toLowerCase().includes(query))) continue;
        found.push(summary(node));
      }
      return { nodes: found };
    },
  },
  {
    name: "get_selection",
    title: "Selection",
    description: "The layers selected in the Lilac editor right now.",
    inputSchema: object({}),
    run: ({ session, selection }) => {
      const document = session.document as any;
      return { nodes: selection().filter((id) => Object.hasOwn(document.nodes, id)).map((id) => summary(document.nodes[id])) };
    },
  },
  {
    name: "get_guide",
    title: "How to work with Lilac",
    description: "How Lilac documents, layers and edits work for an agent.",
    inputSchema: object({}),
    run: () => ({
      guide: [
        "A Lilac document is a tree of layers. Each layer has an id, a type (frame, element, text, ...) and props: tag (an HTML element), text, name (the layer name), attributes and style (CSS properties).",
        "Every edit you make is one history transaction attributed to you; the person sees it live on the canvas and can undo it.",
        "Read with get_basic_info, get_tree_summary, get_children, get_node_info, find_nodes and get_selection.",
        "Edit with create_artboard, set_text_content, rename_nodes, update_styles, move_nodes and duplicate_nodes. delete_nodes needs the person to approve it in Lilac.",
        "Style values are CSS strings (\"24px\", \"#336699\"); null removes a property.",
      ].join("\n"),
    }),
  },
  {
    name: "finish_working_on_nodes",
    title: "Finish working",
    description: "Tell Lilac you have finished with these layers. Changes nothing.",
    inputSchema: object({ nodeIds: idList }),
    run: () => ({ ok: true }),
  },
  {
    name: "create_artboard",
    title: "Create artboard",
    description: "Add a new top-level frame (artboard) of a size, optionally named.",
    inputSchema: object({ name: { type: "string", maxLength: 200 }, width: { type: "number", minimum: 1, maximum: 100000 }, height: { type: "number", minimum: 1, maximum: 100000 } }, ["width", "height"]),
    run: ({ session, edit }, args) => {
      const size = (value: unknown, label: string) => {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 100_000) throw new ToolError(`${label} must be a number from 1 to 100000`);
        return `${Math.round(value * 100) / 100}px`;
      };
      const id = `frame-${randomUUID().slice(0, 12)}`;
      const document = session.document as any;
      const props: Record<string, unknown> = { tag: "main", style: { position: "relative", width: size(args.width, "width"), height: size(args.height, "height"), background: "#ffffff" } };
      if (typeof args.name === "string" && args.name.trim() !== "") props.name = args.name.trim().slice(0, 200);
      return { nodeId: id, ...(edit([{ type: "insert-node", node: { id, type: "frame", props }, parentId: null, index: document.rootIds.length }], "Create artboard") as object) };
    },
  },
  {
    name: "set_text_content",
    title: "Set text",
    description: "Replace a layer's text.",
    inputSchema: object({ nodeId: { type: "string" }, text: { type: "string", maxLength: 100000 } }, ["nodeId", "text"]),
    run: ({ session, edit }, args) => {
      const node = nodeOf(session, args.nodeId);
      if (typeof args.text !== "string") throw new ToolError("text must be a string");
      return edit([{ type: "set-props", nodeId: node.id, set: { text: args.text } }], "Set text");
    },
  },
  {
    name: "rename_nodes",
    title: "Rename layers",
    description: "Set layer names; an empty name removes it.",
    inputSchema: object({ renames: { type: "array", minItems: 1, maxItems: 500, items: object({ nodeId: { type: "string" }, name: { type: "string", maxLength: 200 } }, ["nodeId", "name"]) } }, ["renames"]),
    run: ({ session, edit }, args) => {
      if (!Array.isArray(args.renames) || args.renames.length === 0 || args.renames.length > 500) throw new ToolError("renames must be a list of 1-500 renames");
      const operations = args.renames.map((rename: any) => {
        const node = nodeOf(session, rename?.nodeId);
        if (typeof rename.name !== "string") throw new ToolError("each rename needs a name");
        const name = rename.name.trim().slice(0, 200);
        return name === "" ? { type: "set-props", nodeId: node.id, set: {}, unset: ["name"] } : { type: "set-props", nodeId: node.id, set: { name } };
      });
      return edit(operations, args.renames.length === 1 ? "Rename layer" : "Rename layers");
    },
  },
  {
    name: "update_styles",
    title: "Update styles",
    description: "Change CSS properties of layers. Values are CSS strings; null removes the property.",
    inputSchema: object({ updates: { type: "array", minItems: 1, maxItems: 500, items: object({ nodeId: { type: "string" }, styles: { type: "object", additionalProperties: { type: ["string", "null"] } } }, ["nodeId", "styles"]) } }, ["updates"]),
    run: ({ session, edit }, args) => {
      if (!Array.isArray(args.updates) || args.updates.length === 0 || args.updates.length > 500) throw new ToolError("updates must be a list of 1-500 updates");
      const operations = args.updates.map((update: any) => {
        const node = nodeOf(session, update?.nodeId);
        if (update.styles === null || typeof update.styles !== "object" || Array.isArray(update.styles)) throw new ToolError("each update needs a styles object");
        const current = node.props?.style && typeof node.props.style === "object" ? node.props.style : {};
        const style: Record<string, string> = { ...current };
        for (const [property, value] of Object.entries(update.styles)) {
          if (!/^-?[a-z][a-z0-9-]{0,63}$/u.test(property)) throw new ToolError(`${JSON.stringify(property).slice(0, 80)} is not a CSS property name`);
          if (value === null) delete style[property];
          else if (typeof value === "string" && value.length <= 2000) style[property] = value;
          else throw new ToolError(`the value for ${property} must be a CSS string of at most 2000 characters, or null`);
        }
        return { type: "set-props", nodeId: node.id, set: { style } };
      });
      return edit(operations, "Update styles");
    },
  },
  {
    name: "move_nodes",
    title: "Move layers",
    description: "Move layers to a new parent (null for top level) at an index.",
    inputSchema: object({ moves: { type: "array", minItems: 1, maxItems: 500, items: object({ nodeId: { type: "string" }, parentId: { type: ["string", "null"] }, index: { type: "integer", minimum: 0 } }, ["nodeId", "parentId"]) } }, ["moves"]),
    run: ({ session, edit }, args) => {
      if (!Array.isArray(args.moves) || args.moves.length === 0 || args.moves.length > 500) throw new ToolError("moves must be a list of 1-500 moves");
      const operations = args.moves.map((move: any) => {
        const node = nodeOf(session, move?.nodeId);
        const parentId = move.parentId === null ? null : nodeOf(session, move.parentId).id;
        return { type: "move-node", nodeId: node.id, parentId, ...(Number.isInteger(move.index) && move.index >= 0 ? { index: move.index } : {}) };
      });
      return edit(operations, args.moves.length === 1 ? "Move layer" : "Move layers");
    },
  },
  {
    name: "duplicate_nodes",
    title: "Duplicate layers",
    description: "Copy layers (with everything inside them) next to the originals; returns the copies' ids.",
    inputSchema: object({ nodeIds: idList }, ["nodeIds"]),
    run: ({ session, edit }, args) => {
      const document = session.document as any;
      const operations: unknown[] = [];
      const copies: Record<string, string> = {};
      const ids = [...new Set(strings(args.nodeIds, "nodeIds"))].map((id) => nodeOf(session, id).id);
      const siblingsOf = (node: any) => (node.parentId === null ? document.rootIds : document.nodes[node.parentId].children);
      // Later siblings first, so each copy's index (just after its original) is not shifted
      // by the copies inserted before it.
      ids.sort((a, b) => siblingsOf(document.nodes[b]).indexOf(b) - siblingsOf(document.nodes[a]).indexOf(a));
      let copied = 0;
      for (const id of ids) {
        const root = document.nodes[id];
        const fresh = new Map<string, string>();
        const order: string[] = [];
        const collect = (nodeId: string) => {
          fresh.set(nodeId, `${nodeId.slice(0, 40)}-copy-${randomUUID().slice(0, 8)}`);
          order.push(nodeId);
          for (const child of document.nodes[nodeId].children) collect(child);
        };
        collect(root.id);
        copied += order.length;
        if (copied > MAX_DUPLICATED_NODES) throw new ToolError(`at most ${MAX_DUPLICATED_NODES} layers may be copied in one call`);
        const siblings = root.parentId === null ? document.rootIds : document.nodes[root.parentId].children;
        operations.push({
          type: "restore-subtree",
          rootId: fresh.get(root.id),
          parentId: root.parentId,
          index: siblings.indexOf(root.id) + 1,
          nodes: order.map((nodeId) => {
            const node = document.nodes[nodeId];
            return { id: fresh.get(nodeId), type: node.type, parentId: nodeId === root.id ? root.parentId : fresh.get(node.parentId), children: node.children.map((child: string) => fresh.get(child)), props: structuredClone(node.props), metadata: {} };
          }),
        });
        copies[id] = fresh.get(root.id)!;
      }
      return { copies, ...(edit(operations, "Duplicate layers") as object) };
    },
  },
  {
    name: "delete_nodes",
    title: "Delete layers",
    description: "Delete layers and everything inside them. The person must approve this in Lilac; the call waits for their answer.",
    inputSchema: object({ nodeIds: idList }, ["nodeIds"]),
    run: ({ session, edit }, args) => {
      const ids = strings(args.nodeIds, "nodeIds").map((id) => nodeOf(session, id).id);
      // Deleting a layer deletes what is inside it: only the outermost selected ones are removed.
      const document = session.document as any;
      const chosen = new Set(ids);
      const outermost = [...chosen].filter((id) => {
        for (let parent = document.nodes[id].parentId; parent !== null; parent = document.nodes[parent]?.parentId ?? null) if (chosen.has(parent)) return false;
        return true;
      });
      return edit(outermost.map((nodeId) => ({ type: "remove-node", nodeId })), outermost.length === 1 ? "Delete layer" : "Delete layers");
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
// The definitions the server announces must satisfy Lilac's own MCP contract validators and
// be Paper-compatible names with the classification the tools behave by.
validateMCPServerConfig({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
for (const tool of TOOLS) {
  if (!PAPER_MCP_TOOL_NAMES.includes(tool.name)) throw new Error(`${tool.name} is not a Paper-compatible MCP tool name`);
}

export function mcpToolDefinitions() {
  return TOOLS.map(({ name, title, description, inputSchema }) => {
    const toolClass = classifyPaperTool(name);
    return { name, title, description, inputSchema, annotations: { readOnlyHint: toolClass === "read", destructiveHint: toolClass === "consequential", idempotentHint: toolClass === "read", openWorldHint: false } };
  });
}

export interface PendingConfirmation {
  id: string;
  agentId: string;
  agentName: string;
  toolName: string;
  summary: string;
  documentId: string;
  argumentsSha256: string;
  requestedAt: string;
}

type Decision = { outcome: "approved"; confirmedAt: string } | { outcome: "denied" | "timeout" | "busy" };

interface ConfirmationState extends PendingConfirmation {
  expires: number;
  decision: "pending" | "approved" | "denied";
  confirmedAt?: string;
  waiters: Array<(decision: Decision) => void>;
}

/**
 * The person's side of consequential calls: requests waiting for them, the decision they
 * make in the editor, and single-use approvals bound to the exact call (document, tool,
 * argument hash and agent).
 */
export class ConfirmationBroker {
  #items = new Map<string, ConfirmationState>();
  readonly #notify: (pending: PendingConfirmation[]) => void;

  constructor(notify: (pending: PendingConfirmation[]) => void) {
    this.#notify = notify;
  }

  pending(): PendingConfirmation[] {
    this.#prune();
    return [...this.#items.values()].filter((item) => item.decision === "pending").map(({ expires: _e, decision: _d, confirmedAt: _c, waiters: _w, ...rest }) => rest);
  }

  /** An approval for exactly this call, consumed; or null. */
  takeApproval(key: { agentId: string; toolName: string; documentId: string; argumentsSha256: string }): string | null {
    this.#prune();
    for (const [id, item] of this.#items) {
      if (item.decision === "approved" && item.agentId === key.agentId && item.toolName === key.toolName && item.documentId === key.documentId && item.argumentsSha256 === key.argumentsSha256) {
        this.#items.delete(id);
        return item.confirmedAt!;
      }
    }
    return null;
  }

  /**
   * Ask the person, reusing an identical open request. Resolves with their decision (an
   * approval carries its time), "timeout", or "busy" when too many requests are waiting:
   * at most 20 in all, 5 per agent, and 4 calls waiting on one request.
   */
  request(input: Omit<PendingConfirmation, "id" | "requestedAt">, at: string, waitMs: number): Promise<Decision> {
    this.#prune();
    let item = [...this.#items.values()].find((candidate) => candidate.decision === "pending" && candidate.agentId === input.agentId && candidate.toolName === input.toolName && candidate.documentId === input.documentId && candidate.argumentsSha256 === input.argumentsSha256);
    if (item === undefined) {
      const pending = this.pending();
      if (pending.length >= 20 || pending.filter((other) => other.agentId === input.agentId).length >= 5) return Promise.resolve({ outcome: "busy" });
      item = { ...input, id: `confirm-${randomUUID()}`, requestedAt: at, expires: Date.now() + CONFIRMATION_TTL_MS, decision: "pending", waiters: [] };
      this.#items.set(item.id, item);
      this.#notify(this.pending());
    } else if (item.waiters.length >= 4) {
      return Promise.resolve({ outcome: "busy" });
    }
    const target = item;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        target.waiters = target.waiters.filter((waiter) => waiter !== done);
        resolve({ outcome: "timeout" });
      }, waitMs);
      timer.unref?.();
      const done = (decision: Decision) => {
        clearTimeout(timer);
        resolve(decision);
      };
      target.waiters.push(done);
    });
  }

  /**
   * The person's decision, made in the editor. An approval serves the calls waiting on the
   * request; if none is waiting (they timed out), it is kept for one identical retry.
   * Identical waiting calls (at most 4) each run once: the only consequential tool,
   * delete_nodes, is idempotent, so the repeats find nothing left to delete. A consequential
   * tool that is not idempotent must run once and share its result instead.
   */
  decide(id: unknown, approve: boolean, at: string): void {
    this.#prune();
    const item = typeof id === "string" ? this.#items.get(id) : undefined;
    if (item === undefined || item.decision !== "pending") throw new StudioError(404, "confirmation-not-found", "that request is no longer waiting for a decision");
    const waiters = item.waiters.splice(0);
    if (approve && waiters.length === 0) {
      item.decision = "approved";
      item.confirmedAt = at;
      item.expires = Date.now() + CONFIRMATION_TTL_MS;
    } else {
      this.#items.delete(item.id);
    }
    for (const waiter of waiters) waiter(approve ? { outcome: "approved", confirmedAt: at } : { outcome: "denied" });
    this.#notify(this.pending());
  }

  /** Forget everything for an agent (revoked) or a document (closed). */
  drop(match: (item: PendingConfirmation) => boolean): void {
    let changed = false;
    for (const [id, item] of this.#items) {
      if (match(item)) {
        this.#items.delete(id);
        for (const waiter of item.waiters.splice(0)) waiter({ outcome: "denied" });
        changed = true;
      }
    }
    if (changed) this.#notify(this.pending());
  }

  #prune(): void {
    for (const [id, item] of this.#items) {
      if (item.expires < Date.now()) {
        this.#items.delete(id);
        for (const waiter of item.waiters.splice(0)) waiter({ outcome: "denied" });
      }
    }
  }
}

export interface McpContext {
  session: () => StudioSession | null;
  selection: () => string[];
  confirmations: ConfirmationBroker;
  now: () => string;
  confirmationWaitMs?: number;
}

const rpcError = (id: Json, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const toolResult = (value: Json, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : { structuredContent: typeof value === "object" && value !== null && !Array.isArray(value) ? value : { value } }),
});

/** Answer one JSON-RPC message from `actor`; null for a notification (no answer). */
export async function handleMcpMessage(context: McpContext, actor: StudioActor, message: unknown): Promise<unknown> {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return rpcError(null, -32600, "a JSON-RPC message object is required");
  const { jsonrpc, id, method, params } = message as Record<string, any>;
  const isNotification = id === undefined;
  if (jsonrpc !== "2.0" || typeof method !== "string") return isNotification ? null : rpcError(id ?? null, -32600, "invalid JSON-RPC request");
  if (!isNotification && !(typeof id === "string" || (typeof id === "number" && Number.isFinite(id)))) return rpcError(null, -32600, "id must be a string or number");
  if (isNotification) return null; // notifications/initialized, cancellations: nothing to answer
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
      return { jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: "Lilac design documents. Call get_guide first." } };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: mcpToolDefinitions() } };
    case "tools/call":
      return { jsonrpc: "2.0", id, result: await callTool(context, actor, params) };
    default:
      return rpcError(id, -32601, `method ${JSON.stringify(method).slice(0, 80)} is not supported`);
  }
}

async function callTool(context: McpContext, actor: StudioActor, params: any) {
  const toolName = params?.name;
  const args = params?.arguments === undefined ? {} : params.arguments;
  if (typeof toolName !== "string" || toolName === "") return toolResult("tools/call needs a tool name", true);
  const session = context.session();
  if (session === null) return toolResult("No project is open in Lilac. Ask the person to open one.", true);
  if (session.failure !== null) return toolResult("The project must be reopened in Lilac before it can be used.", true);
  const at = context.now();
  const call = { actor, toolName, arguments: args, at };
  // Authorize before anything else, including before a consequential call asks the person.
  try {
    requireMCPToolCall(session.accessPolicy(), call);
  } catch (error) {
    if (!(error instanceof MCPAuthorizationError) || error.decision.outcome !== "confirmation-required") return refusal(error);
    const confirmation = await confirm(context, session, actor, toolName, args, at);
    if (typeof confirmation === "string") return toolResult(confirmation, true);
    try {
      requireMCPToolCall(session.accessPolicy(), { ...call, at: context.now(), confirmation });
    } catch (again) {
      return refusal(again);
    }
  }
  const tool = TOOL_BY_NAME.get(toolName);
  if (tool === undefined) return toolResult(`Lilac does not implement ${toolName} yet.`, true);
  if (context.session() !== session) return toolResult("The open project changed while the call was waiting.", true);
  try {
    const value = await tool.run({
      session,
      actor,
      toolName,
      selection: context.selection,
      edit: (operations, intent) => {
        if (operations.length === 0) throw new ToolError("nothing to change");
        const event = session.edit(actor, { baseRevision: session.revision, operations, intent, tool: toolName }, "mcp");
        return { revision: event.revision, transactionId: event.transactionId, affectedNodeIds: event.affectedNodeIds };
      },
    }, args);
    return toolResult(value);
  } catch (error) {
    if (error instanceof ToolError) return toolResult(error.message, true);
    if (error instanceof StudioError) return toolResult(error.message, true);
    return toolResult("Lilac could not complete the call.", true);
  }
}

function refusal(error: unknown) {
  if (error instanceof MCPAuthorizationError) return toolResult(`Not allowed: ${error.decision.reason}.`, true);
  if (error instanceof MCPContractError) return toolResult(`Invalid call: ${error.message}`, true);
  return toolResult("Lilac could not authorize the call.", true);
}

/** The person's confirmation for this exact call, or the message to return instead. */
async function confirm(context: McpContext, session: StudioSession, actor: StudioActor, toolName: string, args: unknown, at: string) {
  const argumentsSha256 = mcpArgumentsSha256(args);
  const key = { agentId: actor.actorId, toolName, documentId: session.documentId, argumentsSha256 };
  const approvedAt = context.confirmations.takeApproval(key);
  if (approvedAt !== null) return { documentId: session.documentId, toolName, argumentsSha256, actorId: actor.ownerActorId!, confirmedAt: approvedAt };
  const ids = Array.isArray((args as any)?.nodeIds) ? [...new Set((args as any).nodeIds.filter((id: unknown) => typeof id === "string"))] as string[] : [];
  const document = session.document as any;
  // What the person is shown: each layer's name or text and its kind, and how many layers
  // inside it go with it, from the document (an agent controls names, not structure).
  const describeNode = (id: string) => {
    const node = Object.hasOwn(document.nodes, id) ? document.nodes[id] : null;
    if (node === null) return "(missing layer)";
    const label = typeof node.props?.name === "string" ? node.props.name : typeof node.props?.text === "string" ? `“${node.props.text.slice(0, 30)}”` : null;
    const kind = typeof node.props?.tag === "string" ? node.props.tag : node.type;
    let inside = -1;
    const stack = [id];
    while (stack.length > 0) {
      inside += 1;
      stack.push(...document.nodes[stack.pop()!].children);
    }
    return `${label === null ? kind : `${label} (${kind})`}${inside > 0 ? ` with ${inside} layer${inside === 1 ? "" : "s"} inside` : ""}`;
  };
  const summary = `${toolName === "delete_nodes" ? "Delete" : toolName} ${ids.length} layer${ids.length === 1 ? "" : "s"}: ${ids.slice(0, 5).map(describeNode).join(", ")}${ids.length > 5 ? ", …" : ""}`;
  const decision = await context.confirmations.request({ ...key, agentName: actor.displayName, summary }, at, context.confirmationWaitMs ?? CONFIRMATION_WAIT_MS);
  if (decision.outcome === "denied") return "The person declined this change.";
  if (decision.outcome === "busy") return "Too many changes are already waiting for the person's approval. Wait for them to decide, then call again.";
  if (decision.outcome === "timeout") return "Waiting for the person to approve this in Lilac. Call again with the same arguments once they have.";
  return { documentId: session.documentId, toolName, argumentsSha256, actorId: actor.ownerActorId!, confirmedAt: decision.confirmedAt };
}
