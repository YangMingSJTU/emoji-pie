# Repository Guidelines

## Project Structure & Module Organization

This repository is currently minimal: `README.md` contains the project title and `LICENSE` contains the Apache 2.0 license. Keep root-level files limited to project metadata, documentation, and configuration.

When implementation begins, use a predictable layout:

- `src/` for application or library source code.
- `tests/` for automated tests that mirror `src/` modules.
- `assets/` for images, icons, emoji data, or other static resources.
- `docs/` for design notes, diagrams, and contributor-facing documentation.

Avoid placing generated build output in the repository unless it is explicitly required for distribution.

## Build, Test, and Development Commands

No build, test, or development commands are configured yet. When adding a toolchain, document the exact commands in `README.md` and keep this guide aligned.

Recommended command naming:

- `npm run dev` or equivalent: start the local development environment.
- `npm test`: run the full automated test suite.
- `npm run build`: produce production-ready output.
- `npm run lint`: run formatting and static checks.

## Coding Style & Naming Conventions

Follow the conventions of the language or framework introduced. Prefer consistent formatting through checked-in tooling such as Prettier, ESLint, Ruff, or equivalent project-local config.

Use descriptive names. Prefer `emojiPieRenderer`, `EmojiPieChart`, or `emoji_pie_chart` over vague names such as `handler` or `utils` when the role is specific.

Keep modules focused. Shared helpers should live near their consumers until reuse is clear.

## Testing Guidelines

Add tests with new behavior. Test files should mirror source names where practical, such as `src/parser.ts` and `tests/parser.test.ts`.

Favor small, deterministic tests for parsing, rendering decisions, and data transformations. If visual output is added, include snapshot, screenshot, or fixture-based checks where the chosen framework supports them.

## Commit & Pull Request Guidelines

The current history only contains `Initial commit`, so no detailed convention is established. Use short, imperative commit subjects such as `Add emoji data parser` or `Document repository layout`.

Pull requests should include a concise summary, testing performed, and screenshots or rendered examples for visual changes. For diagrams, keep visuals clean and simple, include a short explanation, and ensure the image proportions fit the surrounding document.

## Security & Configuration Tips

Do not commit secrets, local environment files, dependency caches, or generated artifacts. Add ignore rules before introducing tools that create local output.
