// The editor's connection to its studio host. The launch URL carries a single-use ticket,
// traded here for the per-launch token; the token is kept in sessionStorage, which is
// scoped to this host's origin (scheme, host and port) and this tab, and is sent only in
// the Authorization header (and, for EventSource, which cannot set headers, in the query of
// the event stream).

const TOKEN_KEY = "ninerr.token";

export class HostError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HostError";
    this.status = status;
    this.code = code;
  }
}

const storage = (win) => {
  try {
    return win.sessionStorage;
  } catch {
    return null;
  }
};

/** Connect from the page at `win.location`; null when there is no ticket and no stored token. */
export async function connect(win = globalThis) {
  const url = new URL(win.location.href);
  const ticket = url.searchParams.get("ticket");
  const store = storage(win);
  if (ticket !== null) {
    // Drop the ticket from the address bar and history before anything else.
    win.history.replaceState(null, "", "/");
    const response = await win.fetch("/api/launch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) });
    if (response.ok) {
      const { token } = await response.json();
      try {
        store?.setItem(TOKEN_KEY, token);
      } catch {
        // Without storage the token lives for this page only.
      }
      return createClient(token, win);
    }
  }
  let token = null;
  try {
    token = store?.getItem(TOKEN_KEY) ?? null;
  } catch {
    token = null;
  }
  return token === null ? null : createClient(token, win);
}

export function forgetToken(win = globalThis) {
  try {
    storage(win)?.removeItem(TOKEN_KEY);
  } catch {
    // nothing stored
  }
}

export function createClient(token, win = globalThis) {
  // The project this editor shows. Every request names it, so the host refuses a change made
  // here once another tab has opened a different project (#260).
  let project = () => null;
  const call = async (method, path, body, options = {}) => {
    // A dialog names the project it was opened for, so a click after a switch is refused too.
    const named = options.project === undefined ? project() : options.project;
    const response = await win.fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(named === null ? {} : { "x-ninerr-project": encodeURIComponent(named) }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) throw new HostError(response.status, data?.error?.code ?? "error", data?.error?.message ?? `the studio host answered ${response.status}`);
    return data;
  };
  return {
    /** Name, in every request, the project `current()` returns (null: none). */
    followProject: (current) => {
      project = current;
    },
    get: (path) => call("GET", path),
    /** `options.project`: the project this change is for, instead of the one followed. */
    post: (path, body = {}, options = {}) => call("POST", path, body, options),
    events: () => new win.EventSource(`/api/events?token=${encodeURIComponent(token)}`),
  };
}
