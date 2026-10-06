export class DecisionAssuranceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionAssuranceError";
  }
}

export class DecisionAssuranceValidationError extends DecisionAssuranceError {
  constructor(message: string) {
    super(message);
    this.name = "DecisionAssuranceValidationError";
  }
}
