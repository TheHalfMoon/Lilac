export class DecisionRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionRouterError";
  }
}

export class DecisionValidationError extends DecisionRouterError {
  constructor(message: string) {
    super(message);
    this.name = "DecisionValidationError";
  }
}

export class DecisionConflictError extends DecisionRouterError {
  constructor(message: string) {
    super(message);
    this.name = "DecisionConflictError";
  }
}

export class DecisionAdapterError extends DecisionRouterError {
  constructor(message: string) {
    super(message);
    this.name = "DecisionAdapterError";
  }
}

export class DecisionUnavailableError extends DecisionRouterError {
  constructor(message: string) {
    super(message);
    this.name = "DecisionUnavailableError";
  }
}
