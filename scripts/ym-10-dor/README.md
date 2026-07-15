# YM-10 Stage 1 DOR probe

This directory contains an independent, non-release Electron validation probe. It is deliberately outside `src/**`, is not referenced by the root `package.json`, `electron.vite.config.ts`, or the production electron-builder configuration, and is never included by `npm run build` or `npm run package:win`.

## Frozen scope

The probe contains only:

- a deterministic local keyword-planning prototype;
- a fixed anonymous Openverse search and Openverse thumbnail transport;
- CC0/PDM, source-field, `mature=false`, and redirect gates;
- a two-process Electron `utilityProcess` Sharp pool for bounded decode, normalization, and nine deterministic compositions;
- Electron clipboard and PNG export verification;
- privacy-safe metrics validated against `schemas/metrics.schema.json`;
- an injectable localhost-only HTTPS fixture transport used for protocol tests and smoke evidence.

It does not contain the EmojiPie creation UI, history, favorites, database migrations, production API integration, or production packaging. Fixture execution is not valid Openverse performance evidence.

## Fixed safety contract

- Openverse origin: `https://api.openverse.org`; search path: `/v1/images/`; thumbnail path: `/v1/images/<stable-id>/thumb/`.
- Redirects are rejected. Search JSON is bounded to 2 MiB and thumbnail bodies to 10 MiB.
- Search concurrency is 1, download concurrency is 3, and Sharp decode/compose concurrency is 2.
- Real online execution is limited to 10 batches per installation per UTC day.
- Metrics contain only corpus ID, timings, status code, counts, license distribution, byte counts, and SHA256 values. Input, keyword text, image content, and raw local paths are absent.
- Corpus 43/44/48 may return `needs_user_input` without any request. Corpus 50 is scanned for the frozen forbidden values before metrics are written.

## Reproducible checks

Use the Stage 0 Node pin (`24.14.0`) and the repository `package-lock.json`.

```powershell
npm exec tsc -- -p scripts/ym-10-dor/tsconfig.json --noEmit
npm exec vitest -- run --config scripts/ym-10-dor/vitest.config.ts
```

Build only the non-release probe into a new controlled temporary directory:

```powershell
$probeRoot = Join-Path $env:TEMP ("ym10-stage1-" + [guid]::NewGuid().ToString("N"))
node scripts/ym-10-dor/tools/build-probe.mjs --output-root $probeRoot
```

`build-result.json` records the installer path and SHA256. The builder stages only the probe and its Windows Sharp runtime into the temporary directory, then uses the separate `electron-builder.json`. No generated files are written under the repository.

Run the packaged, unpacked probe twice against the deterministic local HTTPS fixture and create the smoke evidence:

```powershell
$build = Get-Content -Raw (Join-Path $probeRoot "build-result.json") | ConvertFrom-Json
$evidence = Join-Path $probeRoot "smoke-evidence"
New-Item -ItemType Directory -Path $evidence | Out-Null
& $build.unpacked_executable --smoke `
  --smoke-report (Join-Path $evidence "smoke-report.json") `
  --metrics (Join-Path $evidence "smoke-metrics.ndjson")
if ($LASTEXITCODE -ne 0) { throw "YM-10 smoke failed" }
```

The smoke passes only when two cold runs have the same deterministic run/candidate fingerprints and timing-point keys, four metric records validate against the schema, corpus 50 has zero forbidden-value hits, corpus 43 sends no request, and clipboard/export checks succeed.

## Gate

Stage 1 evidence must be reviewed by the technical lead for implementation-equivalence boundaries and reproduced by QA. Do not start Stage 2 until both approvals are explicit.
