export class AgentRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

export class IdempotencyConflictError extends AgentRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class OperationTransitionError extends AgentRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "OperationTransitionError";
  }
}
