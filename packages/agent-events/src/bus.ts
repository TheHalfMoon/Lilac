import { cloneJson } from "@ninerr/agent-runtime";
import { AgentEventError, HandlerRegistrationError } from "./errors.ts";
import {
  AGENT_EVENT_KINDS,
  type AgentEvent,
  type AgentEventKind,
  validateAgentEvent,
} from "./events.ts";

export interface AgentEventHandler {
  id: string;
  kinds?: AgentEventKind[];
  handle: (event: Readonly<AgentEvent>) => void | Promise<void>;
}

export interface HandlerDispatchResult {
  handlerId: string;
  status: "delivered" | "failed";
  error?: string;
}

export interface EventDispatchResult {
  eventId: string;
  deliveries: HandlerDispatchResult[];
}

const EVENT_KIND_SET = new Set<string>(AGENT_EVENT_KINDS);
const UNPRINTABLE_HANDLER_ERROR = "handler threw an unprintable value";

function deepFreeze<T>(value: T, seen = new Set<object>()): Readonly<T> {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function safeErrorMessage(value: unknown): string {
  try {
    if (value instanceof Error && typeof value.message === "string") return value.message;
    return String(value);
  } catch {
    return UNPRINTABLE_HANDLER_ERROR;
  }
}

function validateHandler(handler: AgentEventHandler): void {
  if (handler === null || typeof handler !== "object" || Array.isArray(handler)) {
    throw new HandlerRegistrationError("handler must be an object");
  }
  if (typeof handler.id !== "string" || handler.id.trim() === "") {
    throw new HandlerRegistrationError("handler.id must be a non-empty string");
  }
  if (handler.id.length > 256) throw new HandlerRegistrationError("handler.id is too long");
  if (typeof handler.handle !== "function") throw new HandlerRegistrationError("handler.handle must be a function");
  if (handler.kinds !== undefined) {
    if (!Array.isArray(handler.kinds) || handler.kinds.length === 0) {
      throw new HandlerRegistrationError("handler.kinds must be a non-empty array when provided");
    }
    if (new Set(handler.kinds).size !== handler.kinds.length) {
      throw new HandlerRegistrationError("handler.kinds must not contain duplicates");
    }
    for (const kind of handler.kinds) {
      if (typeof kind !== "string" || !EVENT_KIND_SET.has(kind)) {
        throw new HandlerRegistrationError(`handler ${handler.id} has unsupported event kind ${String(kind)}`);
      }
    }
  }
}

export class AgentEventBus {
  #handlers = new Map<string, AgentEventHandler>();

  register(handler: AgentEventHandler): void {
    validateHandler(handler);
    if (this.#handlers.has(handler.id)) {
      throw new HandlerRegistrationError(`handler ${handler.id} is already registered`);
    }
    this.#handlers.set(handler.id, {
      id: handler.id,
      kinds: handler.kinds === undefined ? undefined : [...handler.kinds],
      handle: handler.handle,
    });
  }

  unregister(handlerId: string): boolean {
    if (typeof handlerId !== "string" || handlerId.trim() === "") {
      throw new HandlerRegistrationError("handlerId must be a non-empty string");
    }
    return this.#handlers.delete(handlerId);
  }

  handlerIds(): string[] {
    return [...this.#handlers.keys()];
  }

  async dispatch(event: AgentEvent): Promise<EventDispatchResult> {
    validateAgentEvent(event);
    const snapshot = deepFreeze(cloneJson(event) as AgentEvent);
    const selected = [...this.#handlers.values()].filter(
      (handler) => handler.kinds === undefined || handler.kinds.includes(event.kind),
    );

    const deliveries = await Promise.all(
      selected.map(async (handler): Promise<HandlerDispatchResult> => {
        try {
          await handler.handle(snapshot);
          return { handlerId: handler.id, status: "delivered" };
        } catch (error) {
          return {
            handlerId: handler.id,
            status: "failed",
            error: safeErrorMessage(error),
          };
        }
      }),
    );

    return { eventId: event.id, deliveries };
  }
}

export function assertDispatchSucceeded(result: EventDispatchResult): void {
  const failures = result.deliveries.filter((delivery) => delivery.status === "failed");
  if (failures.length !== 0) {
    throw new AgentEventError(
      `event ${result.eventId} failed in handlers: ${failures.map((failure) => failure.handlerId).join(", ")}`,
    );
  }
}
