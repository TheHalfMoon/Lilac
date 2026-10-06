export class VisualGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisualGitError";
  }
}

export class VisualGitValidationError extends VisualGitError {
  constructor(message: string) {
    super(message);
    this.name = "VisualGitValidationError";
  }
}

export class VisualGitConflictError extends VisualGitError {
  constructor(message: string) {
    super(message);
    this.name = "VisualGitConflictError";
  }
}
