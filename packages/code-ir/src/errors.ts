export class CodeIrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeIrError";
  }
}

export class CodeIrValidationError extends CodeIrError {
  constructor(message: string) {
    super(message);
    this.name = "CodeIrValidationError";
  }
}

export class CodeIrConflictError extends CodeIrError {
  constructor(message: string) {
    super(message);
    this.name = "CodeIrConflictError";
  }
}

export class CodeIrUnsupportedError extends CodeIrError {
  constructor(message: string) {
    super(message);
    this.name = "CodeIrUnsupportedError";
  }
}
