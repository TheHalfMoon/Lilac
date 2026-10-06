export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkPolicyError";
  }
}

export class NetworkPolicyValidationError extends NetworkPolicyError {
  constructor(message: string) {
    super(message);
    this.name = "NetworkPolicyValidationError";
  }
}
