export class AgentWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentWorkspaceError";
  }
}

export class AgentWorkspaceValidationError extends AgentWorkspaceError {
  constructor(message: string) {
    super(message);
    this.name = "AgentWorkspaceValidationError";
  }
}

export class AgentWorkspaceConflictError extends AgentWorkspaceError {
  constructor(message: string) {
    super(message);
    this.name = "AgentWorkspaceConflictError";
  }
}
