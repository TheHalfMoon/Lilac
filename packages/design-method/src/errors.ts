export class DesignMethodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignMethodError";
  }
}

export class DesignMethodValidationError extends DesignMethodError {
  constructor(message: string) {
    super(message);
    this.name = "DesignMethodValidationError";
  }
}
