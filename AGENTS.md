# Repository Guidelines

## Project Structure & Module Organization

EmojiPie is an Electron desktop application. Keep root-level files limited to project metadata, documentation, and configuration.

- `src/main/` owns Electron windows, SQLite, local-model and agent CLI runtimes, clipboard, and file dialogs.
- `src/preload/` exposes the restricted IPC bridge.
- `src/renderer/` contains the React interface and Canvas emoji engine.
- `src/shared/` contains contracts shared across processes.
- `tests/` contains Vitest units and Playwright Electron flows.
- `assets/` contains the app icon source and generated distribution icon.
- `docs/` contains the PRD and architecture notes.
- `scripts/` contains reproducible asset-generation helpers.

Avoid placing generated build output in the repository unless it is explicitly required for distribution.

## Build, Test, and Development Commands

- `npm run dev`: start Electron with renderer hot reload.
- `npm test`: run deterministic analysis, runtime-adapter, repository, and generation tests.
- `npm run test:e2e`: build and test the real Electron window.
- `npm run lint`: run ESLint across source, tests, and scripts.
- `npm run build`: type-check and build all Electron processes.
- `npm run package:win`: create the Windows NSIS installer.
- `npm run assets:icon`: regenerate `assets/icon.png` from its SVG source.

## Coding Style & Naming Conventions

Use strict TypeScript, functional React components, and the checked-in ESLint configuration. Keep privileged operations in the main process and expose only typed, task-specific preload methods.

Use descriptive names. Prefer `emojiPieRenderer`, `EmojiPieChart`, or `emoji_pie_chart` over vague names such as `handler` or `utils` when the role is specific.

Keep modules focused. Shared helpers should live near their consumers until reuse is clear.

## Testing Guidelines

Add tests with new behavior. Favor small, deterministic Vitest cases for analysis, runtime adapters, and data transformations. User-facing workflows belong in `tests/e2e/`; use isolated Electron user data and capture screenshots for layout changes. Gate tests requiring a real local model or authenticated agent CLI behind explicit environment variables.

## Commit & Pull Request Guidelines

Use short, imperative commit subjects such as `Add reply-style captions` or `Refine emoji card actions`.

Pull requests should include a concise summary, testing performed, and screenshots or rendered examples for visual changes. For diagrams, keep visuals clean and simple, include a short explanation, and ensure the image proportions fit the surrounding document.

## Security & Configuration Tips

Do not commit secrets, local environment files, dependency caches, test output, or packaged builds. Renderer code must keep Node integration disabled and perform database, clipboard, filesystem, process, and runtime operations through the validated preload bridge. Agent CLIs must launch from canonical executable paths with argument arrays, `shell: false`, bounded output, explicit timeouts, and process-tree cleanup. Local-model HTTP endpoints must stay loopback-only, reject redirects, and bound response sizes. Document that enabled CLI runtimes may send prompts to their configured provider.
