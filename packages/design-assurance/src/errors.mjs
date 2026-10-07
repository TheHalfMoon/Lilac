export class DesignAssuranceError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "DesignAssuranceError";
  }
}
