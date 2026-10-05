import { CollaborationValidationError } from "./errors.ts";
import { assertBoundedString } from "./validation.ts";

export type ConnectionSignal =
  | { kind: "connected" }
  | { kind: "update-ready"; serverBuildId: string }
  | { kind: "auth-expired" }
  | { kind: "access-revoked" }
  | { kind: "not-found" };

export function connectionSignal(input: {
  documentExists: boolean;
  sessionValid: boolean;
  authorized: boolean;
  clientBuildId: string;
  serverBuildId: string;
}): ConnectionSignal {
  if (typeof input.documentExists !== "boolean" || typeof input.sessionValid !== "boolean" || typeof input.authorized !== "boolean") {
    throw new CollaborationValidationError("connection flags must be boolean");
  }
  assertBoundedString(input.clientBuildId, "connection.clientBuildId");
  assertBoundedString(input.serverBuildId, "connection.serverBuildId");
  if (!input.documentExists) return { kind: "not-found" };
  if (!input.sessionValid) return { kind: "auth-expired" };
  if (!input.authorized) return { kind: "access-revoked" };
  if (input.clientBuildId !== input.serverBuildId) return { kind: "update-ready", serverBuildId: input.serverBuildId };
  return { kind: "connected" };
}
