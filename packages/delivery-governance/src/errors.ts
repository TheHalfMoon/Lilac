export class DeliveryGovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryGovernanceError";
  }
}

export class DeliveryValidationError extends DeliveryGovernanceError {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryValidationError";
  }
}

export class DeliveryConflictError extends DeliveryGovernanceError {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryConflictError";
  }
}

export class DeliveryGateError extends DeliveryGovernanceError {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryGateError";
  }
}
