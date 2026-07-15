/* global Buffer, console, process */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { arch, cpus, freemem, hostname, platform, release, totalmem, type as osType } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ISSUE_ID = 'e7466c78-898a-424f-aa4a-66de720bae77'
const BASELINE_COMMIT = '148de86f1273353e6edcb79567598c2389e3a818'
const BASELINE_LOCK_BLOB_SHA256 = '304825ae1935e24aa479b4a64b35e8107d8964dd5fc1d7a52441a3b4b7e1ba01'
const EXPECTED_WINDOWS_WORKTREE_LOCK_SHA256 = 'de61717ae5b1fb87dffdd3e985e6cfa3e6a15f171da674ee976ef14f5552d35c'
const PART_SIZE_BYTES = 40 * 1024 * 1024

const toolsDirectory = dirname(fileURLToPath(import.meta.url))
const probeDirectory = resolve(toolsDirectory, '..')
const repositoryRoot = resolve(probeDirectory, '..', '..')
const nodeBin = process.execPath
const npmCli = resolve(dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js')

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256File(path) {
  return sha256(await readFile(path))
}

function gitText(args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true
  }).trim()
}

function gitBytes(args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  })
}

function assertCleanCheckout() {
  const status = gitText(['status', '--porcelain=v1', '--untracked-files=all'])
  if (status) throw new Error(`source_checkout_not_clean:${status.split(/\r?\n/u)[0]}`)
}

async function ensureEmptyExternalDirectory(outputRoot) {
  if (!isAbsolute(outputRoot)) throw new Error('output_root_must_be_absolute')
  const relativeOutput = relative(repositoryRoot, outputRoot)
  const outputIsInsideRepository = !isAbsolute(relativeOutput) && relativeOutput !== '..' &&
    !relativeOutput.startsWith(`..${sep}`)
  if (outputIsInsideRepository) throw new Error('output_root_must_be_outside_repository')
  await mkdir(outputRoot, { recursive: true })
  if ((await readdir(outputRoot)).length > 0) throw new Error('output_root_must_be_empty')
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function commandText(command, args) {
  return [command, ...args.map((entry) => /\s/u.test(entry) ? JSON.stringify(entry) : entry)].join(' ')
}

const outputArgument = argumentValue('--output-root')
if (!outputArgument) throw new Error('output_root_required')
const outputRoot = resolve(outputArgument)
await ensureEmptyExternalDirectory(outputRoot)
const evidenceRoot = join(outputRoot, 'evidence')
const resultsRoot = join(evidenceRoot, 'results')
const logsRoot = join(resultsRoot, 'logs')
const sourceRoot = join(evidenceRoot, 'source', 'ym-10-dor')
const buildRoot = join(outputRoot, 'build')
const deliveryRoot = join(outputRoot, 'delivery-parts')
await Promise.all([
  mkdir(logsRoot, { recursive: true }),
  mkdir(sourceRoot, { recursive: true }),
  mkdir(buildRoot, { recursive: true }),
  mkdir(deliveryRoot, { recursive: true })
])

const commands = []
async function runCommand(name, command, args, cwd = repositoryRoot) {
  const startedAt = new Date().toISOString()
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  })
  const endedAt = new Date().toISOString()
  const logPath = join(logsRoot, `${name}.log`)
  await writeFile(
    logPath,
    `command: ${commandText(command, args)}\nstarted_at: ${startedAt}\nended_at: ${endedAt}\nexit_code: ${result.status ?? 'signal'}\n\nstdout:\n${result.stdout ?? ''}\n\nstderr:\n${result.stderr ?? ''}\n`,
    'utf8'
  )
  commands.push({
    name,
    command: commandText(command, args),
    cwd,
    started_at: startedAt,
    ended_at: endedAt,
    exit_code: result.status,
    log: `results/logs/${name}.log`
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`command_failed:${name}:${result.status ?? 'signal'}`)
  return result
}

assertCleanCheckout()
const sourceCommit = gitText(['rev-parse', 'HEAD'])
const sourceParent = gitText(['rev-parse', 'HEAD^'])
const baselineLockBlobSha256 = sha256(gitBytes(['show', `${BASELINE_COMMIT}:package-lock.json`]))
const sourceLockBlobSha256 = sha256(gitBytes(['show', `${sourceCommit}:package-lock.json`]))
const worktreeLockSha256 = await sha256File(join(repositoryRoot, 'package-lock.json'))
if (process.platform === 'win32' && worktreeLockSha256 !== EXPECTED_WINDOWS_WORKTREE_LOCK_SHA256) {
  throw new Error('windows_worktree_lock_hash_mismatch')
}
if (baselineLockBlobSha256 !== BASELINE_LOCK_BLOB_SHA256 ||
  sourceLockBlobSha256 !== BASELINE_LOCK_BLOB_SHA256) throw new Error('package_lock_blob_hash_mismatch')
const ancestorCheck = spawnSync('git', ['merge-base', '--is-ancestor', BASELINE_COMMIT, sourceCommit], {
  cwd: repositoryRoot,
  windowsHide: true
})
if (ancestorCheck.status !== 0) throw new Error('source_commit_not_based_on_frozen_baseline')

await runCommand('npm-ci', nodeBin, [npmCli, 'ci'])
assertCleanCheckout()
const probeTestsPath = join(resultsRoot, 'probe-tests.json')
const repositoryTestsPath = join(resultsRoot, 'repository-tests.json')
await runCommand('probe-typecheck', nodeBin, [
  join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
  '-p', join(probeDirectory, 'tsconfig.json'),
  '--noEmit'
])
await runCommand('probe-lint', nodeBin, [
  join(repositoryRoot, 'node_modules', 'eslint', 'bin', 'eslint.js'),
  probeDirectory,
  '--max-warnings=0'
])
await runCommand('probe-tests', nodeBin, [
  join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs'),
  'run',
  '--config', join(probeDirectory, 'vitest.config.ts'),
  '--reporter=json',
  '--outputFile', probeTestsPath
])
await runCommand('repository-tests', nodeBin, [
  join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs'),
  'run',
  '--reporter=json',
  '--outputFile', repositoryTestsPath
])
await runCommand('repository-lint', nodeBin, [npmCli, 'run', 'lint'])
await runCommand('repository-build', nodeBin, [npmCli, 'run', 'build'])
await runCommand('probe-build', nodeBin, [
  join(probeDirectory, 'tools', 'build-probe.mjs'),
  '--output-root', buildRoot
])

const buildResult = JSON.parse(await readFile(join(buildRoot, 'build-result.json'), 'utf8'))
if (buildResult.provenance?.source_commit !== sourceCommit ||
  buildResult.provenance?.package_lock_git_blob_sha256 !== BASELINE_LOCK_BLOB_SHA256 ||
  buildResult.provenance?.package_lock_worktree_sha256 !== worktreeLockSha256) {
  throw new Error('build_provenance_mismatch')
}
const smokeRoot = join(resultsRoot, 'smoke')
await mkdir(smokeRoot, { recursive: true })
const smokeReportPath = join(smokeRoot, 'smoke-report.json')
const smokeMetricsPath = join(smokeRoot, 'smoke-metrics.ndjson')
await runCommand('packaged-smoke', buildResult.unpacked_executable, [
  '--smoke',
  '--smoke-report', smokeReportPath,
  '--metrics', smokeMetricsPath
])
const smokeReport = JSON.parse(await readFile(smokeReportPath, 'utf8'))
if (smokeReport.status !== 'pass' ||
  Object.values(smokeReport.checks ?? {}).some((value) => value !== true)) {
  throw new Error('packaged_smoke_not_fully_passed')
}

const asarPath = join(buildResult.package_directory, 'win-unpacked', 'resources', 'app.asar')
const asarResult = await runCommand('package-contents', nodeBin, [
  join(repositoryRoot, 'node_modules', '@electron', 'asar', 'bin', 'asar.js'),
  'list',
  asarPath
])
const asarEntries = String(asarResult.stdout).split(/\r?\n/u).filter(Boolean)
await writeFile(join(resultsRoot, 'package-contents.txt'), `${asarEntries.join('\n')}\n`, 'utf8')

const trackedProbePaths = gitText([
  'ls-tree', '-r', '--name-only', sourceCommit, 'scripts/ym-10-dor'
]).split(/\r?\n/u).filter(Boolean)
const sourceFiles = []
for (const repositoryPath of trackedProbePaths) {
  const relativePath = repositoryPath.slice('scripts/ym-10-dor/'.length)
  const bytes = gitBytes(['show', `${sourceCommit}:${repositoryPath}`])
  const destination = join(sourceRoot, ...relativePath.split('/'))
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
  sourceFiles.push({ path: relativePath, size_bytes: bytes.byteLength, sha256: sha256(bytes) })
}
sourceFiles.sort((left, right) => left.path.localeCompare(right.path))
const treeText = `${sourceFiles.map(({ path, sha256: hash }) => `${hash}  ${path}`).join('\n')}\n`
const sourceManifest = {
  schema_version: 2,
  source_commit: sourceCommit,
  source_root: 'source/ym-10-dor',
  source_method: 'git show <exact-commit>:<path> (exact Git blob bytes)',
  file_count: sourceFiles.length,
  tree_hash_algorithm: 'SHA256 of UTF-8 lines: <file_sha256><two spaces><relative_posix_path><LF>, sorted by path',
  tree_sha256: sha256(Buffer.from(treeText, 'utf8')),
  files: sourceFiles
}
await writeJson(join(evidenceRoot, 'source-manifest.json'), sourceManifest)

const fixtureManifest = JSON.parse(await readFile(join(sourceRoot, 'fixtures', 'fixture-manifest.json'), 'utf8'))
for (const fixture of fixtureManifest.fixtures ?? []) {
  const fixturePath = join(sourceRoot, 'fixtures', ...fixture.path.split('/'))
  const fixtureBytes = await readFile(fixturePath)
  if (fixtureBytes.byteLength !== fixture.size_bytes || sha256(fixtureBytes) !== fixture.sha256) {
    throw new Error(`fixture_manifest_mismatch:${fixture.path}`)
  }
}

const probeTestResult = JSON.parse(await readFile(probeTestsPath, 'utf8'))
const repositoryTestResult = JSON.parse(await readFile(repositoryTestsPath, 'utf8'))
function testSummary(result) {
  return {
    suites_total: result.numTotalTestSuites,
    suites_passed: result.numPassedTestSuites,
    tests_total: result.numTotalTests,
    tests_passed: result.numPassedTests,
    tests_failed: result.numFailedTests,
    success: result.success
  }
}
const probeTestSummary = testSummary(probeTestResult)
const repositoryTestSummary = testSummary(repositoryTestResult)
if (!probeTestSummary.success || !repositoryTestSummary.success) throw new Error('test_summary_not_passed')

const dependencyLock = JSON.parse(await readFile(join(repositoryRoot, 'node_modules', '.package-lock.json'), 'utf8'))
const npmVersion = String((await runCommand('npm-version', nodeBin, [npmCli, '--version'])).stdout).trim()
const environment = {
  schema_version: 1,
  captured_at_utc: new Date().toISOString(),
  source_commit: sourceCommit,
  source_parent: sourceParent,
  hostname: hostname(),
  os: { type: osType(), platform: platform(), release: release(), arch: arch() },
  cpu: { model: cpus()[0]?.model ?? 'unknown', logical_cores: cpus().length },
  memory_bytes: { total: totalmem(), free_at_capture: freemem() },
  toolchain: {
    node: process.version,
    npm: npmVersion,
    electron: buildResult.toolchain.electron,
    sharp: buildResult.toolchain.sharp,
    typescript: buildResult.toolchain.typescript,
    electron_builder: buildResult.toolchain.electron_builder
  },
  dependency_lock: {
    method: 'npm ci',
    node_modules_lockfile_version: dependencyLock.lockfileVersion,
    package_lock_git_blob_sha256: BASELINE_LOCK_BLOB_SHA256,
    package_lock_windows_worktree_sha256: worktreeLockSha256
  }
}
await writeJson(join(evidenceRoot, 'environment.json'), environment)

await cp(join(buildRoot, 'build-result.json'), join(resultsRoot, 'build-result.json'))
await writeFile(
  join(resultsRoot, 'installer.sha256'),
  `${buildResult.installer_sha256}  ${basename(buildResult.installer_path)}\n`,
  'utf8'
)

async function splitInstaller(installerPath) {
  const input = await open(installerPath, 'r')
  const installerSize = (await input.stat()).size
  const partCount = Math.ceil(installerSize / PART_SIZE_BYTES)
  const parts = []
  const buffer = Buffer.alloc(1024 * 1024)
  let sourceOffset = 0
  try {
    for (let index = 0; index < partCount; index += 1) {
      const filename = `${basename(installerPath)}.part${String(index + 1).padStart(2, '0')}.bin`
      const path = join(deliveryRoot, filename)
      const output = await open(path, 'wx')
      const partHash = createHash('sha256')
      const partOffset = sourceOffset
      let remaining = Math.min(PART_SIZE_BYTES, installerSize - sourceOffset)
      try {
        while (remaining > 0) {
          const readLength = Math.min(buffer.byteLength, remaining)
          const { bytesRead } = await input.read(buffer, 0, readLength, sourceOffset)
          if (bytesRead <= 0) throw new Error('unexpected_installer_eof')
          await output.write(buffer, 0, bytesRead)
          partHash.update(buffer.subarray(0, bytesRead))
          sourceOffset += bytesRead
          remaining -= bytesRead
        }
      } finally {
        await output.close()
      }
      parts.push({
        order: index + 1,
        filename,
        offset_bytes: partOffset,
        size_bytes: sourceOffset - partOffset,
        sha256: partHash.digest('hex')
      })
    }
  } finally {
    await input.close()
  }
  if (sourceOffset !== installerSize) throw new Error('installer_split_size_mismatch')
  const reassembledHash = createHash('sha256')
  let reassembledSize = 0
  for (const part of parts) {
    const bytes = await readFile(join(deliveryRoot, part.filename))
    reassembledHash.update(bytes)
    reassembledSize += bytes.byteLength
  }
  const reassembledSha256 = reassembledHash.digest('hex')
  if (reassembledSize !== installerSize || reassembledSha256 !== buildResult.installer_sha256) {
    throw new Error('installer_reassembly_verification_failed')
  }
  return { installerSize, parts, reassembledSha256 }
}

const split = await splitInstaller(buildResult.installer_path)
const partsManifest = {
  schema_version: 2,
  format: 'ordered raw binary parts',
  original: {
    filename: basename(buildResult.installer_path),
    size_bytes: split.installerSize,
    sha256: buildResult.installer_sha256
  },
  parts: split.parts,
  reassembly_verification: {
    concatenated_size_bytes: split.installerSize,
    concatenated_sha256: split.reassembledSha256,
    passed: true
  }
}
await writeJson(join(resultsRoot, 'installer-parts.json'), partsManifest)
const reconstructScript = `param(\n  [string]$PartsDirectory = (Get-Location).Path,\n  [string]$OutputPath = (Join-Path (Get-Location).Path '${basename(buildResult.installer_path)}')\n)\n$ErrorActionPreference = 'Stop'\n$partNames = @(\n${split.parts.map(({ filename }) => `  '${filename}'`).join(',\n')}\n)\n$expected = '${buildResult.installer_sha256}'\n$output = [IO.File]::Create([IO.Path]::GetFullPath($OutputPath))\ntry {\n  foreach ($name in $partNames) {\n    $input = [IO.File]::OpenRead((Join-Path $PartsDirectory $name))\n    try { $input.CopyTo($output) } finally { $input.Dispose() }\n  }\n} finally { $output.Dispose() }\n$actual = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()\nif ($actual -ne $expected) { throw "Reconstructed installer SHA256 mismatch: $actual" }\nWrite-Output "Verified $OutputPath ($actual)"\n`
await writeFile(join(resultsRoot, 'reconstruct-installer.ps1'), reconstructScript, 'utf8')

const rootBusinessSourceEntries = asarEntries.filter((entry) => /^\\src(?:\\|$)/u.test(entry)).length
const requiredPackageEntries = ['\\main.js', '\\schemas\\metrics.schema.json', '\\build-provenance.json']
const requiredNativeEntries = [
  'libvips-42.dll',
  'libvips-cpp-8.18.3.dll',
  'sharp-win32-x64-0.35.3.node'
]
const packageChecks = {
  business_src_entries_zero: rootBusinessSourceEntries === 0,
  required_probe_entries_present: requiredPackageEntries.every((required) => asarEntries.includes(required)),
  sharp_native_runtime_present: requiredNativeEntries.every(
    (required) => asarEntries.some((entry) => entry.endsWith(required))
  )
}
const verification = {
  schema_version: 2,
  conclusion: 'stage1_minor_closed_ready_for_technical_rereview',
  source: {
    clean_exact_commit_before_npm_ci: true,
    clean_exact_commit_after_all_commands: false,
    commit: sourceCommit,
    parent: sourceParent,
    baseline_ancestor: BASELINE_COMMIT
  },
  package_lock: {
    git_blob_normalized_lf_sha256: BASELINE_LOCK_BLOB_SHA256,
    windows_worktree_bytes_sha256: worktreeLockSha256,
    scopes_explicit_and_verified: true
  },
  tests: {
    probe: probeTestSummary,
    repository: repositoryTestSummary
  },
  packaged_smoke: {
    status: smokeReport.status,
    check_count: Object.keys(smokeReport.checks ?? {}).length,
    all_checks_passed: Object.values(smokeReport.checks ?? {}).every(Boolean),
    metrics_record_count: smokeReport.evidence?.metrics_record_count,
    metrics_sha256: smokeReport.evidence?.metrics_sha256
  },
  package: packageChecks,
  installer: {
    sha256: buildResult.installer_sha256,
    parts_reassembled_and_verified: true
  },
  gate: {
    stage2_started: false,
    business_source_modified: false,
    formal_build_integration: false,
    reviewed_commit_qa: 'passed',
    replacement_commit_qa: 'not_started',
    technical_rereview: 'pending'
  }
}
assertCleanCheckout()
verification.source.clean_exact_commit_after_all_commands = true
if (Object.values(packageChecks).some((value) => !value)) throw new Error('package_contents_check_failed')
await writeJson(join(evidenceRoot, 'verification.json'), verification)

const blockerClosure = {
  schema_version: 2,
  reviewed_commit: '082f7a35f7d402a090d34519916f1c19e170a7ce',
  replacement_commit: sourceCommit,
  items: [
    {
      severity: 'minor',
      id: 'MINOR-canonical-uuid-deduplication',
      status: 'closed_by_rework_pending_review',
      implementation: [
        'valid asset UUID is canonicalized to lowercase before thumbnail comparison',
        'the lowercase UUID is used for seen-set deduplication and emitted asset ID',
        'the case-variant duplicate fixture preserves the first canonical asset exactly once'
      ],
      evidence: [
        'source/ym-10-dor/fixtures/openverse-license-matrix.json',
        'results/probe-tests.json'
      ]
    }
  ]
}
await writeJson(join(evidenceRoot, 'blocker-closure.json'), blockerClosure)
await writeJson(join(evidenceRoot, 'commands.json'), { schema_version: 1, commands })

const artifactPaths = []
for (const name of ['environment.json', 'commands.json', 'verification.json', 'blocker-closure.json', 'source-manifest.json']) {
  artifactPaths.push(name)
}
async function collectFiles(directory, prefix) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const relativePath = `${prefix}/${entry.name}`
    if (entry.isDirectory()) await collectFiles(path, relativePath)
    else artifactPaths.push(relativePath)
  }
}
await collectFiles(resultsRoot, 'results')
artifactPaths.sort()
const artifacts = []
for (const artifactPath of artifactPaths) {
  const path = join(evidenceRoot, ...artifactPath.split('/'))
  artifacts.push({
    path: artifactPath,
    size_bytes: (await stat(path)).size,
    sha256: await sha256File(path)
  })
}
const manifest = {
  schema_version: 2,
  issue_id: ISSUE_ID,
  stage: 1,
  generated_at_utc: new Date().toISOString(),
  conclusion: 'minor_closed_ready_for_technical_rereview',
  source: {
    commit: sourceCommit,
    parent: sourceParent,
    baseline_commit: BASELINE_COMMIT,
    clean_checkout: true,
    source_manifest: 'source-manifest.json',
    file_count: sourceManifest.file_count,
    tree_sha256: sourceManifest.tree_sha256
  },
  package_lock: {
    git_blob_normalized_lf: { sha256: BASELINE_LOCK_BLOB_SHA256, verified_at_baseline_and_source_commit: true },
    windows_worktree_bytes: { sha256: worktreeLockSha256 },
    explanation: 'Distinct byte scopes are intentional and never compared as the same artifact.'
  },
  toolchain: environment.toolchain,
  fixture_manifest: {
    path: 'source/ym-10-dor/fixtures/fixture-manifest.json',
    sha256: await sha256File(join(sourceRoot, 'fixtures', 'fixture-manifest.json')),
    entries: fixtureManifest.fixtures.length
  },
  metrics_schema: {
    path: 'source/ym-10-dor/schemas/metrics.schema.json',
    sha256: await sha256File(join(sourceRoot, 'schemas', 'metrics.schema.json'))
  },
  installer: {
    filename: basename(buildResult.installer_path),
    size_bytes: split.installerSize,
    sha256: buildResult.installer_sha256,
    delivery: {
      mode: 'ordered binary part attachments',
      part_manifest: 'results/installer-parts.json',
      reconstruction_script: 'results/reconstruct-installer.ps1',
      parts: split.parts,
      reassembled_sha256_verified: true
    }
  },
  tests: verification.tests,
  smoke: verification.packaged_smoke,
  blocker_closure: 'blocker-closure.json',
  gate: verification.gate,
  artifacts
}
await writeJson(join(evidenceRoot, 'manifest.json'), manifest)

const evidenceZip = join(outputRoot, `YM-10-Stage1-rework-${sourceCommit.slice(0, 8)}-evidence.zip`)
const archiveResult = spawnSync('tar', ['-a', '-c', '-f', evidenceZip, '-C', evidenceRoot, '.'], {
  cwd: outputRoot,
  encoding: 'utf8',
  windowsHide: true
})
if (archiveResult.error) throw archiveResult.error
if (archiveResult.status !== 0) throw new Error(`evidence_archive_failed:${archiveResult.stderr}`)
const zipSha256 = await sha256File(evidenceZip)
await writeFile(`${evidenceZip}.sha256`, `${zipSha256}  ${basename(evidenceZip)}\n`, 'utf8')
const archiveList = spawnSync('tar', ['-t', '-f', evidenceZip], {
  cwd: outputRoot,
  encoding: 'utf8',
  windowsHide: true
})
if (archiveList.status !== 0 || !String(archiveList.stdout).includes('manifest.json')) {
  throw new Error('evidence_archive_verification_failed')
}

console.log(JSON.stringify({
  schema_version: 1,
  source_commit: sourceCommit,
  evidence_zip: evidenceZip,
  evidence_zip_size_bytes: (await stat(evidenceZip)).size,
  evidence_zip_sha256: zipSha256,
  installer: partsManifest.original,
  installer_parts: split.parts,
  smoke_status: smokeReport.status,
  probe_tests: probeTestSummary,
  repository_tests: repositoryTestSummary
}, null, 2))
