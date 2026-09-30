# Paper Desktop 0.5.14 Recovery Evidence

Date: 2026-09-30

## Artifact

- File: `Paper Setup 0.5.14 - x64.exe`
- SHA-256: `44fbf4525608a3d95c8ccc55a4d7d6100dd4e749b50b897c7dcefa00844e42dd`
- Size: `125,534,680` bytes
- Container: NSIS / Nullsoft installer

The artifact was inspected statically without executing the installer.

## NSIS payload

The installer contains an Electron Builder payload named:

- `$PLUGINSDIR\\app-64.7z`
- Size: `124,845,572` bytes

The 7z payload expands to 82 archive entries with approximately 441 MB of uncompressed data. Important members include:

- `Paper.exe`
- `resources/app.asar`
- `resources/app.asar.unpacked/`
- Chromium/Electron runtime resources and locale files

## Electron application archive

`resources/app.asar`:

- Size: `49,716,902` bytes
- 4,986 archive entries
- Top-level application package contains source/configuration directories including `src`, `scripts`, `tests`, `dist`, `package.json`, and TypeScript configuration files.
- `src/` contains 84 source files in the recovered desktop package.

The recovered package metadata identifies the application as:

- package: `@paper/desktop`
- product: `Paper`
- version: `0.5.14`
- license field: `Proprietary`
- private: `true`
- main entry: `dist/main.cjs`

## Recovered source scope

The Electron archive contains real TypeScript source for the Paper Desktop shell, including areas such as:

- application startup and Electron lifecycle;
- window/tab management;
- MCP bridge/server and harness configuration;
- desktop authentication;
- PDF export;
- deep links;
- desktop menus;
- preload bridges;
- update handling;
- desktop CLI installation;
- tests for the recovered desktop package.

This is not only a minified production bundle; source `.ts` files and tests are shipped in the ASAR.

## Monorepo identity

The recovered `README.md` states that production desktop packaging is performed from the repository/workflow:

`paper-design/paper` -> `.github/workflows/desktop-upload-draft.yml`

The same README instructs developers to run `bun run devd` from the root of that repository, indicating that the recovered desktop package is a subtree/workspace of a larger Paper monorepo.

Direct access to `paper-design/paper` through the currently connected GitHub account returned `404 Not Found` on 2026-09-30. Treat the monorepo as unavailable to this connector until access is explicitly granted.

## Editor boundary

The recovered desktop source resolves the production client origin to:

`https://app.paper.design`

The desktop shell loads application routes from that origin. It also imports workspace packages such as `@paper/models`, `@paper/assets`, `@paper/cli`, and `@paper/client-desktop-types`, whose full source is not present as standalone workspace packages in this shipped ASAR.

Therefore the recovered installer provides substantial first-party source for the Desktop/MCP/native integration layer, but it is not evidence that the complete Paper web editor/canvas source has been recovered.

## Lilac intake decision

Do not represent this artifact as the complete Paper source tree.

Recommended sequence:

1. preserve this installer SHA and recovery evidence;
2. keep the extracted proprietary snapshot outside the public Lilac repository unless public redistribution rights are explicitly confirmed;
3. obtain access to the authorized `paper-design/paper` monorepo or an authorized full source archive;
4. bind the complete source intake to an exact commit/revision and manifest;
5. reproduce the upstream build before beginning Lilac transformations.

## Integrity status

- Paper Desktop source recovery: **PROVEN**
- Paper Desktop package/version identity: **PROVEN**
- Original private monorepo name: **PROVEN BY SHIPPED README**
- Complete Paper editor/canvas source recovery: **NOT PROVEN**
- Direct GitHub access to `paper-design/paper`: **BLOCKED / 404 WITH CURRENT CONNECTOR**
