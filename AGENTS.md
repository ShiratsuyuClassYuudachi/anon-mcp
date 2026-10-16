# Repository Guidelines

## Project Structure & Module Organization

This workspace currently contains no application source, tests, assets, or package manifests. The existing `.agents/`, `.codex/`, `.aws/`, and `.git/` directories are empty environment placeholders; do not use them for application code.

When adding the initial implementation, group source code under `src/`, tests under `tests/`, and contributor documentation under `docs/` where appropriate. Keep related modules together and document the actual layout in a root `README.md`.

## Build, Test, and Development Commands

No build, test, lint, or local development commands are configured yet. Do not assume that `npm test`, `make build`, or another ecosystem-specific command works.

When introducing a toolchain, provide reproducible setup instructions, declare dependencies in its standard manifest, and document exact commands for local development, building, linting, and testing in `README.md`. Commit a dependency lockfile when supported.

## Coding Style & Naming Conventions

No language, formatter, or linter has been established. Follow the chosen language's standard conventions and configure formatting before adding substantial code. Prefer descriptive names, small modules, and consistent indentation. Match surrounding code once conventions exist; avoid unrelated formatting changes.

## Testing Guidelines

No testing framework or coverage threshold is configured. Add automated tests alongside new behavior using the selected stack's standard framework. Use descriptive test names that state the behavior and expected outcome. Cover failure paths and regressions, and document how to run individual tests and the complete suite.

## Commit & Pull Request Guidelines

Git history is unavailable in this workspace, so existing commit conventions cannot be verified. Until conventions are established, use concise, imperative subjects such as `Add configuration validation`.

Pull requests should explain the change, its purpose, and validation performed. Link relevant issues, note configuration changes, and include screenshots for user-visible interface changes.

## Security & Configuration

Never commit credentials, tokens, or local secrets. Provide placeholder values in an example configuration file and document required environment variables when configuration is introduced.
