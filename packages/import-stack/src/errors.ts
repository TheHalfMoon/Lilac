export class ImportStackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportStackError";
  }
}

export class ImportValidationError extends ImportStackError {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

export class ImportSecurityError extends ImportStackError {
  constructor(message: string) {
    super(message);
    this.name = "ImportSecurityError";
  }
}

export class ImportConflictError extends ImportStackError {
  constructor(message: string) {
    super(message);
    this.name = "ImportConflictError";
  }
}

export class ImportAdapterError extends ImportStackError {
  constructor(message: string) {
    super(message);
    this.name = "ImportAdapterError";
  }
}
