# Working on TabFlow

TabFlow is a browser extension. Start with [README.md](README.md), then read the guide relevant to the change:

- [Architecture](docs/architecture.md) for state, identity, browser operations and inference boundaries.
- [Design system](docs/design-system.md) for layout, controls and interaction patterns.
- [Contributing](docs/contributing.md) for tooling, code conventions, validation and publication.
- [Workflows](docs/workflows.md) and [AI assistance](docs/assistant.md) for current product behavior.

## Working rules

- Trace the existing flow before changing it and reuse established components and state.
- Preserve user changes and keep the change scoped to the requested outcome.
- Keep private progress, machine details and session notes out of public documentation.
- Inspect rendered output for visual changes and report exactly what was verified.
