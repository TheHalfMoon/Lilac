# P06 G8: MCP tool-call authorization (#128)

P06 gate 8 (#100): a tool-call authorization function maps each MCP tool class to the required capabilities through the collaboration access oracle.

## Disposition

Lilac has no MCP server or dispatcher yet; it is planned in #82. This grain delivers the enforcement point that server must call before it dispatches anything. The architecture catalog now records that requirement for `mcp-surface`, which gains a `collaboration` dependency.

## Changes (`packages/mcp-protocol`)

### `authorizeMCPToolCall(policy, { actor, toolName, arguments, at, linkGrantId?, confirmation? })`

The function returns `{ outcome, toolClass, capability, reason, policyRevision }`. `outcome` is one of `allowed`, `denied`, `not-found` or `confirmation-required`.

How each tool class is decided:
- **unknown:** denied before any policy is read. A malformed policy is never touched.
- **read:** needs `read`.
- **write:** needs `document-write`. `set_comment_thread_status` needs `comments`.
- **consequential** (`delete_nodes`): needs `document-write` and a confirmation bound to this exact call. The confirmation is `{ toolName, argumentsSha256, actorId, confirmedAt }`, and all of these must hold:
  - `toolName` matches the tool being called.
  - `argumentsSha256` matches the canonical sha256 of the arguments. Key order does not matter, but content does.
  - `actorId` is the responsible person: the calling user, or an agent's owning user. An agent never confirms its own call.
  - `documentId` is the authorizing policy's document (added in review delta 1).
  - `confirmedAt` is at most 5 minutes before the call, and never after it.

  If any check fails, the outcome is `confirmation-required`, never `allowed`. Without the capability, the outcome is `denied`, confirmation or not.

The access oracle runs with transport `mcp`. A deleted document gives `not-found`, and a malformed call fails with `MCPContractError`.

### Other additions

- `requireMCPToolCall` throws `MCPAuthorizationError`, carrying the decision, for every outcome except `allowed`.
- `mcpArgumentsSha256` computes the digest a confirmation must carry.
- The tool tables, `MCPContractError` and `classifyPaperTool` moved to `paper-tools.mjs`, so the new module can use them without an import cycle. The package's existing exports are unchanged.

## Tests

`tests/mcp-authorization.test.mjs` has 6 tests:

1. **Exhaustive check.** Every one of the 36 Paper tools is tried against all 64 capability sets. A call is allowed exactly when the tool's capability is granted, and each decision reports the tool's class and capability.
2. **Read grants cannot write.** No read-only grant combination reaches a write or consequential tool, and `requireMCPToolCall` throws.
3. **Confirmation binding.** A consequential call is refused with no confirmation, or with one for another tool, other arguments, another person, an expired time or a future time. The window's edge is accepted. Argument key order is irrelevant but argument content counts. A confirmation without the capability still gives `denied`, and malformed confirmations throw.
4. **Unknown tools.** Look-alike, case-variant, whitespace, NUL and prototype names are denied without consulting the policy, even a malformed one. Malformed calls throw.
5. **Revocation fails closed.** This covers a removed grant, a grant narrowed to read, an expired grant, a deleted document (`not-found`), a revoked link grant and a different link id.
6. **Agents** are judged by their own grant, not their owner's. A consequential agent call is confirmed only by its owning person.

`tests/mcp-protocol.test.mjs` and `tests/architecture.test.mjs` pass unchanged.

## Review delta 1

The combined and security judge returned one must-fix.

**Must-fix: confirmations could be replayed across documents.** A confirmation carried no document, so a `delete_nodes` confirmation for `{nodeIds:["n1"]}` was accepted on any document whose node ids collide. Confirmations now carry `documentId`, and it must equal the authorizing policy's document. Decisions also report `documentId`, so the dispatcher can check which policy authorized the call.

**Worth-considering, also fixed:**
- **Trust boundary.** A confirmation is only as trustworthy as whoever builds it. The code now states the obligation on #82: `actor` must be the server-authenticated session identity, and `confirmation` must come from the server's own confirmation flow, never from the MCP client's payload. An agent that names itself as its own owner is refused.
- **The confirming person** must hold `document-write` on the same document.
- **Workspace-scoped tools** (`open_file`, `create_file`, `list_resources`, `rename_resource`) act on files or the workspace, not the open document. They would have been judged against whichever document policy was passed in. No workspace policy exists, so they are denied until #82 provides one.
- **Arguments** must be JSON data for every known tool, not only consequential ones; a violation is an `MCPContractError`. `null` no longer hashes like `{}`.
- **Timestamps** must be real UTC instants: `2026-02-30`, `T24:00` and second 60 are refused.

**Tests.** Test 3 gains the cross-document cases, test 4 is new (arguments and timestamps), and test 7 gains owner-permission and self-owned-agent cases. Test 1 now expects the workspace-scoped denials. Each of these fails on `0c3f8f8`. `tests/mcp-authorization.test.mjs` now has 7 tests.
