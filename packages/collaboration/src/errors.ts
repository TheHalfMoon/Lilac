export class CollaborationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class CollaborationValidationError extends CollaborationError {}
export class CollaborationAuthorizationError extends CollaborationError {}
export class CollaborationNotFoundError extends CollaborationError {}
export class CollaborationProtocolError extends CollaborationError {}
export class CollaborationConflictError extends CollaborationError {}
export class CollaborationCommentError extends CollaborationError {}
export class CollaborationPersistenceError extends CollaborationError {}
