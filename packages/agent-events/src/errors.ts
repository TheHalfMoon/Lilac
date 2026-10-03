export class AgentEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentEventError";
  }
}

export class EventSequenceError extends AgentEventError {
  constructor(message: string) {
    super(message);
    this.name = "EventSequenceError";
  }
}

export class EventCorrelationError extends AgentEventError {
  constructor(message: string) {
    super(message);
    this.name = "EventCorrelationError";
  }
}

export class HandlerRegistrationError extends AgentEventError {
  constructor(message: string) {
    super(message);
    this.name = "HandlerRegistrationError";
  }
}
