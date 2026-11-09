# Architecture

TabFlow is a Chromium Manifest V3 extension built with WXT, Vue and TypeScript. The dashboard and side panel are views over one persistent workspace. A background service worker coordinates browser state and writes to IndexedDB through Dexie. The suspended-page entry point is a small standalone page.

## System boundaries

| Layer             | Responsibility                                                              |
| ----------------- | --------------------------------------------------------------------------- |
| `src/entrypoints` | Background worker, dashboard, side panel, reader and suspended page         |
| `src/core`        | Browser coordination, persistence, sessions, snapshots and journals         |
| `src/shared`      | Domain types, runtime schemas, identity, filtering and pure transformations |
| `src/stores`      | Reactive workspace and conversation state                                   |
| `src/features`    | Product views and feature-specific interaction logic                        |
| `src/ui`          | Shared controls, themes and interaction primitives                          |
| `src/ai`          | Model adapters, tools, evidence, inference workflows and checkpoints        |
| `src/providers`   | External integration adapters                                               |

Shared modules are grouped by domain, with pure cross-domain helpers in `src/shared/utils`. AI modules separate `runtime`, `providers`, `tools`, `workflows`, `context` and `inference` responsibilities.

Views send typed RPC requests to the background coordinator. Browser mutations are serialized there, where current identities, permissions and target protections are checked. Metadata operations use database transactions. Zod validates messages, model output and imported data at the boundary.

## Workspace model

Each tab occurrence has a persistent UUID. Browser tab, window and group IDs are session handles. Duplicate addresses remain distinct occurrences. Browser events reconcile live handles with saved records. Original addresses are persisted before navigation to suspended placeholders.

Project/category membership is independent of native window/group placement. Tags connect records across projects. A UUID parent reference and optional branch name form a hierarchy independent of both. Graph edits validate cycles and a maximum depth of five. Copied records remap their references.

The UI receives serialized workspace snapshots. Unchanged subtrees retain reactive identity, allowing background synchronization without replacing active editors or search results. Large searches and lists use bounded work and pagination. Shared display preferences retain ordering and collapsed state.

## Operation invariants

Default workflows keep tabs available in native browser windows and never automatically close, deduplicate, delete or archive a collection. Protected tabs and active inspection targets are excluded from conflicting operations. Waking large collections is bounded rather than simultaneous.

Browser mutations persist recovery points before changes and journal partial outcomes. Interrupted operations are never replayed automatically. Inference limits constrain generation, not the data already saved in proposals, metadata or history.

## Persistence and recovery

IndexedDB stores occurrences, memberships, projects, categories, settings, sessions, snapshots and assistant history. Snapshots record recovery points. Operation journals record actual browser-change outcomes, including partial failures. An interrupted operation remains interrupted until explicitly resumed.

Restore compares saved and current identities rather than replacing the entire browser session. Unrelated tabs and independently navigated pages are retained. Undo/Redo uses before/after values and current-state checks to avoid overwriting later edits. Browser operations and inference checkpoints have separate lifecycles.

Portable backups validate the complete import before committing. Bounded message chunks avoid transporting a large archive in one extension message. Credentials, executable approvals and transient browser handles are not portable authority. Cached page text and preview images are excluded from manual backup exports.

## Optional inference

OpenAI-compatible chat endpoints provide conversation and generative organization. A separately configured compatible decision endpoint can perform constrained decisions. Evidence comes from known metadata and authorized page inspection. Page content remains untrusted input.

Bulk organization runs as a resumable pipeline: discovery, taxonomy reconciliation, assignment, optional tagging and planning. Checkpoints bind progress to scope, source fingerprints and model configuration. Generation budgets limit requests, not the tags or records already saved in a draft.

Saved proposals are versioned data. Sparse edits and merges validate revisions before saving. Draft preparation is separate from application. Applying a proposal updates semantic memberships. Creating native project windows is a separate copy operation.

## Assistant actions

The conversation UI calls the `AgentRuntime` contract through a composition entry point. AI SDK Core runs the conversation against the configured OpenAI-compatible endpoint, with streaming, bounded tool steps and cancellation. Conversation tool factories own request scope and prepared artifacts independently of the model runner. A provider-neutral catalog supplies validated tools and discovery. Bulk generation workflows use the same provider layer with explicit output schemas and checkpoints. Constrained System One decisions use their separate protocol. A future service adapter can implement the runtime contract while retaining extension-owned tool validation and approval. No companion service or MCP server is required or exposed by the extension.

Conversation tools expose reads, draft operations and prepared workspace/browser changes. Attachments capture a fixed scope at send time. Tools enforce that scope and validate current targets when executing.

Approval policy belongs to the chat: manual approval, delegated exact-action review, or explicit automatic approval. All policies retain browser permissions and target validation. Review receipts bind proposed effects and revisions. Stale or interrupted approvals do not replay. Change history links assistant actions to metadata journals or browser operations.

## Presentation and build

Nuxt UI and Reka provide interaction primitives, with product adapters in `src/ui`. Feature views share semantic theme tokens. Browser APIs remain in the coordinator and platform adapters rather than presentation primitives.

Build configuration composes extension metadata and UI assets. An optional public manifest key from `TABFLOW_EXTENSION_KEY` keeps unpacked extension identity stable in development and production builds. Documentation and test fixtures run outside extension entry points, with temporary storage and fictional data. They are not bundled into production output.
