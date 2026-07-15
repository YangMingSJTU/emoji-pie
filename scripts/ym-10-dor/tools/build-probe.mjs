/* global console, process */
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

async function sha256File(path) {
  const { createReadStream } = await import('node:fs')
  const hash = createHash('sha256')
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', rejectPromise)
    stream.once('end', resolvePromise)
  })
  return hash.digest('hex')
}

const explicitOutputRoot = argumentValue('--output-root')
const outputRoot = explicitOutputRoot
  ? resolve(explicitOutputRoot)
  : await mkdtemp(join(tmpdir(), 'ym10-dor-stage1-'))
if (explicitOutputRoot && !isAbsolute(explicitOutputRoot)) throw new Error('output_root_must_be_absolute')
if (explicitOutputRoot) await ensureEmptyDirectory(outputRoot)

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

const stagedPackage = {
  name: 'ym-10-dor-probe',
  version: '0.1.0',
  private: true,
  main: 'main.js',
  dependencies: { sharp: '0.35.3' }
}
await writeFile(
  join(applicationDirectory, 'package.json'),
  `${JSON.stringify(stagedPackage, null, 2)}\n`,
  'utf8'
)
for (const dependency of [
  'sharp',
  'detect-libc',
  'semver',
  '@img/colour',
  '@img/sharp-win32-x64'
]) {
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
const result = {
  schema_version: 1,
  output_root: outputRoot,
  application_directory: applicationDirectory,
  package_directory: packageDirectory,
  installer_path: installerPath,
  installer_size_bytes: (await stat(installerPath)).size,
  installer_sha256: await sha256File(installerPath),
  unpacked_executable: unpackedExecutable,
  toolchain: {
    node: process.version,
    electron: '43.1.0',
    sharp: '0.35.3'
  }
}
await writeFile(join(outputRoot, 'build-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(result))
