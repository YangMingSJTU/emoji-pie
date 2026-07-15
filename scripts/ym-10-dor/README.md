# YM-10 Stage 1 DOR probe

This directory contains an independent, non-release Electron validation probe. It is deliberately outside `src/**`, is not referenced by the root `package.json`, `electron.vite.config.ts`, or the production electron-builder configuration, and is never included by `npm run build` or `npm run package:win`.

## Frozen scope

The probe contains only:

- a deterministic local keyword-planning prototype and an explicit plan/edit/confirm/cancel boundary;
- a fixed anonymous Openverse search and Openverse thumbnail transport;
- fail-closed CC0/PDM, source, `mature === false`, UUID/path, and canonical-license-link gates;
- bounded PNG/JPEG/WebP media-type and magic checks before decode;
- a two-process Electron `utilityProcess` Sharp pool with per-job watchdog, kill/recreate, and queued-job recovery;
- Electron clipboard and PNG export verification;
- privacy-safe metrics validated against `schemas/metrics.schema.json`;
- injectable localhost-only HTTPS fixtures used for protocol, malformed-image, worker-failure, and smoke evidence.

It does not contain the EmojiPie creation UI, history, favorites, database migrations, production API integration, or production packaging. Fixture execution is not valid Openverse performance evidence.

## Fixed safety contract

- Planning is local. Planning never copies unknown input tokens into fallback keywords. The renderer must show editable 1–3 keywords, and only a separate confirmation action may invoke transport.
- Missing confirmation returns `keywords_confirmation_required` before any request or real-online quota mutation. Corpus 43/44/48, corpus 50, and arbitrary PII/project text are regression cases.
- Openverse origin is `https://api.openverse.org`; search path is `/v1/images/`; thumbnail path is `/v1/images/<matching-uuid>/thumb/`. Redirects, credentials, query-bearing thumbnails, and ID/path mismatches are rejected.
- Only `mature === false` records with complete source fields and matching canonical CC0/PDM Creative Commons URLs are eligible.
- Search JSON is bounded to 2 MiB. Remote images are bounded to 10 MiB, must declare PNG/JPEG/WebP, and must have matching magic bytes before entering Sharp.
- Search concurrency is 1, download concurrency is 3, Sharp concurrency is 2, and each Sharp job has a fixed 3-second watchdog. Timeout/crash terminates and replaces only that worker; queued work continues through a replacement.
- Real online execution is limited to 10 confirmed batches per installation per UTC day.
- Metrics contain only corpus ID, timings, status code, counts, license distribution, byte counts, and SHA256 values. Input, keyword text, image content, and raw local paths are absent.

## Hash scope

`package-lock.json` has two intentionally distinct byte scopes on Windows:

- Git blob / normalized LF SHA256: `de61717ae5b1fb87dffdd3e985e6cfa3e6a15f171da674ee976ef14f5552d35c`;
- Windows worktree-byte SHA256: calculated and recorded for the exact checkout.

The evidence manifest names both scopes. They are never presented as the same artifact. `scripts/ym-10-dor/.gitattributes` fixes every probe source and fixture blob to LF, and fixture hashes are exact Git-blob bytes.

## Complete clean-checkout verification

Use the Stage 0 Node pin (`24.14.0`). Start from a new detached checkout of the immutable source commit; do not copy a dirty worktree or existing `node_modules`.

```powershell
git worktree add --detach C:\controlled\ym10-stage1-clean <exact-source-commit>
Set-Location C:\controlled\ym10-stage1-clean
node scripts\ym-10-dor\tools\verify-stage1.mjs --output-root C:\controlled\ym10-stage1-evidence
```

`verify-stage1.mjs` requires a clean exact commit, runs `npm ci`, verifies the Git-blob and worktree lock hashes plus `node_modules/.package-lock.json` and installed package versions, then runs:

- probe TypeScript and ESLint;
- probe contract tests with machine-readable results;
- repository tests, lint, and build with machine-readable counts where applicable;
- the isolated builder and packaged Electron smoke;
- package-content, source-blob, fixture, installer split/reassembly, and evidence-manifest checks.

The output root must be absolute, empty, and outside the repository. It contains:

- `evidence/manifest.json`, `verification.json`, `blocker-closure.json`, `commands.json`, and `environment.json`;
- exact source bytes extracted with `git show <commit>:<path>` plus `source-manifest.json`;
- raw test JSON/logs, build provenance, package contents, smoke report/metrics/exports, and installer hashes;
- three ordered installer part files and a verified reconstruction script;
- a final evidence ZIP and SHA256 sidecar.

`tools/build-probe.mjs` is also fail-closed: it accepts only a clean checkout descended from the frozen baseline, requires an external empty output root, validates lock/install provenance, writes the exact source commit into the package, and never writes generated output into the repository.

## Gate

This probe and its evidence require technical-lead implementation-equivalence review before QA. Do not start QA or Stage 2 until the technical review explicitly passes. The probe never substitutes for formal application DoD evidence.
