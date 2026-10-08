// @ninerr/studio-web: the editor the studio host serves. The application itself is
// `app.mjs`, loaded by `index.html`; this entry exposes the parts other packages may use.
export { HostError, connect, createClient, forgetToken } from "./client.mjs";
export { STUDIO_WEB_PROVENANCE } from "./provenance.mjs";
