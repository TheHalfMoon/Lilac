export class IntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeError";
  }
}

export class IntakeValidationError extends IntakeError {
  constructor(message: string) {
    super(message);
    this.name = "IntakeValidationError";
  }
}

/** The proposal is not ready to commit (it carries blocking diagnostics). */
export class IntakeNotReadyError extends IntakeError {
  constructor(message: string) {
    super(message);
    this.name = "IntakeNotReadyError";
  }
}
