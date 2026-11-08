# Development and contributing

TabFlow uses Bun, Node.js 22 or newer, WXT, Vue and TypeScript. Install with the checked-in Bun lockfile:

```sh
bun install --frozen-lockfile
bun run dev
```

Read [architecture](architecture.md) and [design system](design-system.md) before substantial changes. Repository workflow instructions are in [AGENTS.md](../AGENTS.md).

## Code conventions

Shared domain code uses strict TypeScript and runtime validation at import, model and RPC boundaries. Explicit `any`, broad suppression comments and casts that bypass validation are excluded. Existing Dexie, Zod, Pinia, VueUse and SDK integrations provide shared infrastructure.

The suspended entry point remains independent of Vue, database and inference bundles. Runtime assets are bundled locally. Private credentials are excluded from source and portable exports.

## Checks

| Command                          | Scope                                                        |
| -------------------------------- | ------------------------------------------------------------ |
| `bun run check`                  | Types, lint, offline tests, production build and formatting  |
| `bun run test:ui`                | Rendered UI and interaction fixtures                         |
| `bun run test:browser`           | Native extension integration in a temporary Chromium profile |
| `bun run test:browser:workspace` | Focused native workspace integration                         |
| `bun run audit:public`           | Publication candidates, staged content and Markdown links    |

Pre-commit hooks lint and format staged files automatically.

Browser tests use fictional data and temporary profiles. UI fixture results do not establish installed-extension behavior. Model evaluations are opt-in and use synthetic evidence. Meaningful regressions cover identity, recovery and permission races. Visual changes use rendered interaction checks with inspected output. Full browser acceptance and real-provider tests are reported separately from fixtures.

## Screenshots

Install Playwright's browser once, then build and capture:

```sh
bunx playwright install chromium
bun run build
bun run screenshots
```

The capture uses the production UI with a local fixture bridge, believable fictional projects and locally rendered site icons. External page and model requests are blocked. Screenshot framing assets live in `scripts/docs`. They are separate from the production extension. Public gallery images use dark mode with rounded transparent corners. Light mode remains part of interaction testing.

Playwright's installed Chromium is the default. `TABFLOW_CHROMIUM_PATH` optionally selects another executable. `TABFLOW_CHROMIUM_CHANNEL` selects a UI-test channel. Native extension tests require a full extension-capable Chromium build. Inspect the final images before publication.

## Packaging

`package.json` is the version source for the generated extension manifest and application state. Update its `version` for each release, then rebuild.

`bun run zip` builds the extension and creates `.output/tabflow-<version>-chrome.zip`, with `manifest.json` at the archive root. This is the extension-only release asset. Extract it before loading it unpacked.

`bun run package` creates `TabFlow-<version>.zip` containing public source and the ready-to-load extension. It rejects a build whose manifest version differs from the package version. The packager uses explicit publication roots, excluding temporary artifacts, profiles and private notes. The public manifest key keeps unpacked extension identity stable and is not a private signing credential.

The publication audit reads both working files and staged copies. Review the complete proposed publication, including images and archives. Test and package commands do not commit or publish.

## Reports

Include the browser version, affected workflow and a minimal reproducible example. Use fictional data and remove credentials or private browsing content from attachments.
