/* global console, process */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASELINE_COMMIT = '148de86f1273353e6edcb79567598c2389e3a818'
const BASELINE_LOCK_BLOB_SHA256 = '304825ae1935e24aa479b4a64b35e8107d8964dd5fc1d7a52441a3b4b7e1ba01'
const EXPECTED_WINDOWS_WORKTREE_LOCK_SHA256 = 'de61717ae5b1fb87dffdd3e985e6cfa3e6a15f171da674ee976ef14f5552d35c'
const EXPECTED_TOOLCHAIN = {
  node: 'v24.14.0',
  electron: '43.1.0',
  sharp: '0.35.3'
}
const RUNTIME_DEPENDENCIES = [
  'sharp',
  'detect-libc',
  'semver',
  '@img/colour',
  '@img/sharp-win32-x64'
]
const VERIFIED_PACKAGES = ['electron', 'sharp', 'typescript', 'electron-builder']

const toolsDirectory = dirname(fileURLToPath(import.meta.url))
const probeDirectory = resolve(toolsDirectory, '..')
const repositoryRoot = resolve(probeDirectory, '..', '..')

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function runNode(script, args, cwd = repositoryRoot) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env },
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.status !== 0) throw new Error(`${basename(script)}_failed_${result.status ?? 'signal'}`)
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
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  })
}

async function ensureEmptyDirectory(path) {
  await mkdir(path, { recursive: true })
  if ((await readdir(path)).length > 0) throw new Error(`output_root_not_empty:${path}`)
}

async function copyRuntimeDependency(specifier, applicationDirectory) {
  const source = join(repositoryRoot, 'node_modules', ...specifier.split('/'))
  const destination = join(applicationDirectory, 'node_modules', ...specifier.split('/'))
  if (!(await stat(source)).isDirectory()) throw new Error(`runtime_dependency_missing:${specifier}`)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, dereference: true, force: false })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256File(path) {
  return sha256(await readFile(path))
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function verifyDependencyProvenance() {
  const rootLock = await readJson(join(repositoryRoot, 'package-lock.json'))
  const installedLock = await readJson(join(repositoryRoot, 'node_modules', '.package-lock.json'))
  if (rootLock.lockfileVersion !== 3 || installedLock.lockfileVersion !== 3) {
    throw new Error('lockfile_version_mismatch')
  }
  const versions = {}
  for (const packageName of VERIFIED_PACKAGES) {
    const key = `node_modules/${packageName}`
    const rootEntry = rootLock.packages?.[key]
    const installedEntry = installedLock.packages?.[key]
    const installedManifest = await readJson(join(repositoryRoot, 'node_modules', packageName, 'package.json'))
    if (!rootEntry?.version || rootEntry.version !== installedEntry?.version ||
      rootEntry.integrity !== installedEntry.integrity || rootEntry.version !== installedManifest.version) {
      throw new Error(`installed_dependency_lock_mismatch:${packageName}`)
    }
    versions[packageName] = rootEntry.version
  }
  if (versions.electron !== EXPECTED_TOOLCHAIN.electron || versions.sharp !== EXPECTED_TOOLCHAIN.sharp) {
    throw new Error('frozen_runtime_version_mismatch')
  }
  return versions
}

function assertCleanCheckout() {
  const status = gitText(['status', '--porcelain=v1', '--untracked-files=all'])
  if (status) throw new Error(`source_checkout_not_clean:${status.split(/\r?\n/u)[0]}`)
}

const explicitOutputRoot = argumentValue('--output-root')
const outputRoot = explicitOutputRoot
  ? resolve(explicitOutputRoot)
  : await mkdtemp(join(tmpdir(), 'ym10-dor-stage1-'))
if (explicitOutputRoot && !isAbsolute(explicitOutputRoot)) throw new Error('output_root_must_be_absolute')
const relativeOutput = relative(repositoryRoot, outputRoot)
const outputIsInsideRepository = !isAbsolute(relativeOutput) && relativeOutput !== '..' &&
  !relativeOutput.startsWith(`..${sep}`)
if (outputIsInsideRepository) throw new Error('output_root_must_be_outside_repository')
if (explicitOutputRoot) await ensureEmptyDirectory(outputRoot)

assertCleanCheckout()
const sourceCommit = gitText(['rev-parse', 'HEAD'])
if (resolve(gitText(['rev-parse', '--show-toplevel'])).toLowerCase() !== repositoryRoot.toLowerCase()) {
  throw new Error('repository_root_mismatch')
}
const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', BASELINE_COMMIT, sourceCommit], {
  cwd: repositoryRoot,
  windowsHide: true
})
if (ancestor.status !== 0) throw new Error('source_commit_not_based_on_frozen_baseline')
const lockBlobSha256 = sha256(gitBytes(['show', `${BASELINE_COMMIT}:package-lock.json`]))
if (lockBlobSha256 !== BASELINE_LOCK_BLOB_SHA256) throw new Error('baseline_lock_blob_hash_mismatch')
const sourceLockBlobSha256 = sha256(gitBytes(['show', `${sourceCommit}:package-lock.json`]))
if (sourceLockBlobSha256 !== BASELINE_LOCK_BLOB_SHA256) throw new Error('source_lock_blob_hash_mismatch')
const worktreeLockSha256 = await sha256File(join(repositoryRoot, 'package-lock.json'))
if (process.platform === 'win32' && worktreeLockSha256 !== EXPECTED_WINDOWS_WORKTREE_LOCK_SHA256) {
  throw new Error('windows_worktree_lock_hash_mismatch')
}
const dependencyVersions = await verifyDependencyProvenance()
if (process.version !== EXPECTED_TOOLCHAIN.node) throw new Error(`node_version_mismatch:${process.version}`)

const applicationDirectory = join(outputRoot, 'app')
const packageDirectory = join(outputRoot, 'package')
await mkdir(applicationDirectory, { recursive: true })

runNode(
  join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
  ['-p', join(probeDirectory, 'tsconfig.json'), '--outDir', applicationDirectory]
)
await Promise.all([
  cp(join(probeDirectory, 'src', 'renderer'), join(applicationDirectory, 'renderer'), {
    recursive: true,
    force: false
  }),
  cp(join(probeDirectory, 'fixtures'), join(applicationDirectory, 'fixtures'), {
    recursive: true,
    force: false
  }),
  cp(join(probeDirectory, 'schemas'), join(applicationDirectory, 'schemas'), {
    recursive: true,
    force: false
  })
])

const buildProvenance = {
  schema_version: 1,
  source_commit: sourceCommit,
  base_commit: BASELINE_COMMIT,
  package_lock_hash_scope: {
    git_blob_normalized_lf: lockBlobSha256,
    windows_worktree_bytes: worktreeLockSha256
  },
  package_lock_git_blob_sha256: lockBlobSha256,
  package_lock_worktree_sha256: worktreeLockSha256,
  dependency_provenance: {
    method: 'root package-lock.json + npm-ci node_modules/.package-lock.json + installed package manifests',
    versions: dependencyVersions
  }
}
await writeFile(
  join(applicationDirectory, 'build-provenance.json'),
  `${JSON.stringify(buildProvenance, null, 2)}\n`,
  'utf8'
)

const stagedPackage = {
  name: 'ym-10-dor-probe',
  version: '0.2.0',
  private: true,
  main: 'main.js',
  dependencies: { sharp: EXPECTED_TOOLCHAIN.sharp }
}
await writeFile(
  join(applicationDirectory, 'package.json'),
  `${JSON.stringify(stagedPackage, null, 2)}\n`,
  'utf8'
)
for (const dependency of RUNTIME_DEPENDENCIES) {
  await copyRuntimeDependency(dependency, applicationDirectory)
}

runNode(
  join(repositoryRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
  [
    '--projectDir', applicationDirectory,
    '--config', join(probeDirectory, 'electron-builder.json'),
    `--config.directories.output=${packageDirectory}`,
    '--win', 'nsis',
    '--x64',
    '--publish', 'never'
  ]
)

const installers = (await readdir(packageDirectory))
  .filter((name) => name.endsWith('-setup.exe'))
  .map((name) => join(packageDirectory, name))
if (installers.length !== 1) throw new Error(`expected_one_probe_installer_found_${installers.length}`)
const installerPath = installers[0]
const unpackedExecutable = join(packageDirectory, 'win-unpacked', 'YM-10 DOR Probe - NON RELEASE.exe')
assertCleanCheckout()
const result = {
  schema_version: 2,
  output_root: outputRoot,
  application_directory: applicationDirectory,
  package_directory: packageDirectory,
  installer_path: installerPath,
  installer_size_bytes: (await stat(installerPath)).size,
  installer_sha256: await sha256File(installerPath),
  unpacked_executable: unpackedExecutable,
  provenance: buildProvenance,
  toolchain: {
    node: process.version,
    electron: dependencyVersions.electron,
    sharp: dependencyVersions.sharp,
    typescript: dependencyVersions.typescript,
    electron_builder: dependencyVersions['electron-builder']
  }
}
await writeFile(join(outputRoot, 'build-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(result))
