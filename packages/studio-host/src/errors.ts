/** A studio request failed; `status` is the HTTP status the host answers with. */
export class StudioError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "StudioError";
    this.status = status;
    this.code = code;
  }
}
