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
- `commit`: apply through history (validation, stale base-revision rejection) -> canonicalize the normalized transaction (values JSON cannot represent, such as `Date`, `Map`, `undefined`, or sparse arrays, are refused) -> re-apply the decoded form, so the in-memory document is exactly what replay produces -> append one journal line with a single write + fsync -> update memory. A crash before the append loses nothing committed; a crash after it is replayed on reopen.
- Before each append the store re-checks that it still holds the lock (owner, pid, time, and a random per-acquisition nonce), that `.lilac` is not a link, and, through the read/append descriptor it writes with, that the journal is a regular, singly linked file with the pinned 64-bit device and inode, exactly the size this writer last wrote, and a SHA-256 equal to that of the bytes this writer validated at open and appended since. (Repaired by #88: the original release pinned the status-change time instead of content. That missed same-size in-place rewrites landing in the same filesystem timestamp tick, which is milliseconds in practice, not the nanosecond granularity this file first stated; such rewrites were caught at reopen by the hash chain.) Verification costs one read of the journal per append, about 1.3 ms/MB measured, or 341 ms at the 256 MiB cap. The cost grows with the journal, so the total is quadratic in the number of commits until journal rotation exists. Residuals: (1) a change to bytes already hashed, made while the rest of the journal is still being verified or before the write lands, is not seen until reopen, which then fails closed. The window lasts as long as the verification read (up to about 341 ms at the cap), and the OS offers no mandatory lock to close it. (2) Metadata-only changes (touch/utimes, chmod, attributes) no longer refuse commits, but a journal made unreadable or unwritable still fails the append, which poisons the store until reopen; nothing is lost, because the refusal happens before writing. A stale or foreign writer, an in-place rewrite, a replaced file, a hard link out of the project, or a partial line from an earlier failure is detected before anything is written.
- Any journal write failure poisons the store: further writes are refused until the project is reopened, where a partial line is recovered as a torn tail.
- `checkpoint`: write the document object, then atomically replace the snapshot reference. The journal is never truncated by checkpoints, so the hash chain stays verifiable from genesis.
- Project creation is assembled in a staging directory and renamed into place, so a crash never leaves a half-initialized project. Anything already named `.lilac` (directory, file, or link) is refused before staging, because Windows `rename` would otherwise replace an existing regular file. A crash during creation can leave a `.lilac.tmp-*` staging directory, which is never read and can be deleted.

## Integrity

- Journal lines carry a SHA-256 chain digest seeded by the project id; any edit, reordering, or cross-project splice breaks the chain.
- Objects are verified against their id on every read.
- An unterminated final line is a torn write. Each append writes line and newline in one call and is acknowledged only after fsync covers both, so an unterminated tail can only be an unacknowledged write interrupted by a crash; it is reported in `recovery.tornTailBytes` and removed atomically, even when its bytes form a complete entry. (Cycle 1 briefly failed closed on that case; the correctness panel showed it would make a project unopenable after a legitimate crash, so it was reverted.) A complete, terminated line that fails to parse is corruption, which is stricter than the spec wording ("no newline terminator or unparsable") and fails closed.
- Journal lines are length-checked before parsing; re-encoding failures (for example pathological nesting) are reported as corruption, not raw runtime errors.
- Any other defect (chain break, bad entry, non-applying transaction, missing or mismatched object, malformed manifest or snapshot, snapshot past the journal end, invalid UTF-8) raises `PersistenceCorruptionError`, nothing is rewritten, and the lock is released.

## Confinement and platform notes

- Root must be absolute and existing; it is resolved with `realpath`. `.lilac` and every project file must not be symbolic links (directory junctions on Windows are detected as links).
- Reads open with `O_NOFOLLOW` and check size and type on the opened descriptor (POSIX). Windows has no `O_NOFOLLOW`, so there an `lstat` check precedes open, leaving a narrow residual check-then-open window that only a local actor with write access to `.lilac` could exploit.
- Object reads also refuse links at `objects/` and the fan-out directory.
- Directory fsync is attempted after creating directories and after renames, and ignored where unsupported (Windows); file fsync plus rename still give atomic replacement.
- Residual risk (Windows): without `O_NOFOLLOW`, a local actor with write access to `.lilac` could race an `lstat` check against a swap to a link. `.lilac` is re-checked before every write, which narrows but does not eliminate this window. This is outside the threat model of a single-user local store, and is recorded rather than hidden.
- The journal is never rotated in this release; at its 256 MiB limit commits are refused with an explicit message. Peak memory while opening a maximal journal is roughly 1 GB.
- All internal paths come from fixed names and hex digests.

## Locking

`openProject` takes an exclusive lock before reading. A second writer, in the same or another process, gets `PersistenceLockError`. After a crash the lock remains; reopening requires `breakStaleLock: { reason }`. The stale lock is first renamed to a unique name (only one contender can win), then a new lock is created that persists the override (previous holder and reason); the override is also reported in `recovery.lockOverride`. A writer whose lock was overridden is refused on its next write. `close` releases the lock only if it is still the caller's. The store is only obtainable through `openProject`.

## Public surface

Only the store API (`createProject`, `openProject`, the `ProjectStore` type), errors, types, constants, the migration registry, and the pure journal encoders are exported. Raw filesystem and journal writers are internal, so callers cannot bypass the lock, the hash chain, or history.

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
