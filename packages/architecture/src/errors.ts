export class ArchitectureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchitectureError";
  }
}

export class ArchitectureValidationError extends ArchitectureError {
  constructor(message: string) {
    super(message);
    this.name = "ArchitectureValidationError";
  }
}
