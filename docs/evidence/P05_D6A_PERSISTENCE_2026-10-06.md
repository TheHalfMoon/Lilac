# P05 D6a - Local project persistence implementation evidence

Date: 2026-10-06

Issue: #74

## Scope

First slice of Master Plan D6 (local/private mode): Lilac documents survive save, close, reopen, and crashes on the local filesystem with no hosted service. D6b (network capability policy, provider registry, offline guarantees) follows separately.

Target package: `packages/persistence` (workspace dependencies `@lilac/document-model`, `@lilac/history`; Node built-ins only)

## Layout

```
<root>/.lilac/
  project.json    manifest (format, schemaVersion, projectId, documentId, createdAt)
  snapshot.json   { revision, documentObject, journalSeq, chainDigest }
  journal.log     append-only, one canonical JSON line per committed transaction
  objects/aa/...  content-addressed objects (SHA-256 of bytes)
  lock            single-writer lock { owner, pid, at }
```

## Authority and ordering

- Document state is only ever produced by `@lilac/history.applyTransaction` over a hash-verified snapshot; persistence never edits documents itself.
- `commit`: apply through history (validation, stale base-revision rejection) -> append one journal line with a single write + fsync -> update memory. A crash before the append loses nothing committed; a crash after it is replayed on reopen.
- `checkpoint`: write the document object, then atomically replace the snapshot reference. The journal is never truncated by checkpoints, so the hash chain stays verifiable from genesis.
- Project creation is assembled in a staging directory and renamed into place, so a crash never leaves a half-initialized project.

## Integrity

- Journal lines carry a SHA-256 chain digest seeded by the project id; any edit, reordering, or cross-project splice breaks the chain.
- Objects are verified against their id on every read.
- Only an unterminated final line counts as a torn write (each append writes line and newline in one call). It is reported in `recovery.tornTailBytes` and removed atomically. A complete line that fails to parse is corruption. This is stricter than the spec wording ("no newline terminator or unparsable") and fails closed.
- Any other defect (chain break, bad entry, non-applying transaction, missing or mismatched object, malformed manifest or snapshot, snapshot past the journal end, invalid UTF-8) raises `PersistenceCorruptionError`, nothing is rewritten, and the lock is released.

## Confinement and platform notes

- Root must be absolute and existing; it is resolved with `realpath`. `.lilac` and every project file must not be symbolic links (directory junctions on Windows are detected as links).
- Reads open with `O_NOFOLLOW` and check size and type on the opened descriptor (POSIX). Windows has no `O_NOFOLLOW`, so there an `lstat` check precedes open, leaving a narrow residual check-then-open window that only a local actor with write access to `.lilac` could exploit.
- Directory fsync is attempted and ignored where unsupported (Windows); file fsync plus rename still give atomic replacement.
- All internal paths come from fixed names and hex digests.

## Locking

`openProject` takes an exclusive lock before reading. A second writer gets `PersistenceLockError`. After a crash the lock remains; reopening requires `breakStaleLock: { reason }`, and the override (previous holder and reason) is reported in `recovery.lockOverride`. `close` releases the lock only if it is still the caller's.

## Bounds

Objects 64 MiB, journal 256 MiB, journal entry 4 MiB, manifest 64 KiB, replay 1,000,000 entries.

## Migration

Manifest schema version 1 is the first released schema, so the built-in registry is empty. Older versions migrate through registered steps with an atomic manifest rewrite (proven with a test migration); newer versions raise `PersistenceVersionError`.

## Test coverage note

The file-symlink refusal test skips on Windows without elevated privileges (file symlinks cannot be created); it runs on Linux CI. Directory-link refusal runs on both.

## Non-goals (per spec)

Network policy, provider adapters, offline guarantees (D6b); multi-writer merge (Grain 5 collaboration); asset registry and garbage collection; encryption at rest.

## Qualification

Qualification evidence is recorded on Issue #74 after exact-head GitHub CI, Alibaba Open Code Review delegation with host-agent rule application, pstack review panel, and Jev complete on the final candidate. Cubic, CodeRabbit, and Qodo are not qualification evidence.
