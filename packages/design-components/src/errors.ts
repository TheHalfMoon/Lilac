export class DesignComponentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignComponentsError";
  }
}

export class DesignComponentsValidationError extends DesignComponentsError {
  constructor(message: string) {
    super(message);
    this.name = "DesignComponentsValidationError";
  }
}

export class DesignComponentsDriftError extends DesignComponentsError {
  constructor(message: string) {
    super(message);
    this.name = "DesignComponentsDriftError";
  }
}
