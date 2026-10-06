export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceError";
  }
}

/** Input or project layout is invalid (bad root, symlink, oversized value, unsupported request). */
export class PersistenceValidationError extends PersistenceError {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceValidationError";
  }
}

/** Stored data failed verification; nothing is rewritten. */
export class PersistenceCorruptionError extends PersistenceError {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceCorruptionError";
  }
}

/** Another writer holds the project lock. */
export class PersistenceLockError extends PersistenceError {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceLockError";
  }
}

/** The project uses a schema version this build cannot read. */
export class PersistenceVersionError extends PersistenceError {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceVersionError";
  }
}
