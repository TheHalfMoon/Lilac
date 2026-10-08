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
  const call = async (method, path, body) => {
    const response = await win.fetch(path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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
    get: (path) => call("GET", path),
    post: (path, body = {}) => call("POST", path, body),
    events: () => new win.EventSource(`/api/events?token=${encodeURIComponent(token)}`),
  };
}
