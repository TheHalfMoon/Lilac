export class AgentSupervisorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class SupervisorRecordError extends AgentSupervisorError {}
export class SupervisorOwnershipError extends AgentSupervisorError {}
export class SupervisorLeaseError extends AgentSupervisorError {}
export class SupervisorQueueError extends AgentSupervisorError {}
export class SupervisorRecoveryError extends AgentSupervisorError {}
export class SupervisorWorktreeError extends AgentSupervisorError {}
export class SupervisorRuntimeError extends AgentSupervisorError {}