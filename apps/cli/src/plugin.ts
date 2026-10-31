/** Profile package management and explicit, exact-version compatibility approvals. */
import { runPluginCommand, runProfilePnpm, setProfileVersionExemption, type PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import { INSTALL_ANCHOR } from './profile-boot.ts'
import {
  assertBundlePlatform, evaluatePluginCompatibility, initProfile, pluginCompatibilityWarning, readProfileCompatibility,
  readProfileManifest, resolveBundleDir, resolveProfileDir, writeProfileBundles, type ProfileContext,
} from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES, DEFAULT_PROFILE_BUNDLES, OPTIONAL_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { existsSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

function requireDesktopProfile(dir: string): void {
  if (!existsSync(join(dir, 'package.json'))) {
    throw new Error('Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.')
  }
}

/** Activate an installation-carried optional bundle without invoking a package manager. */
async function enableBundleCommand(profile: string, args: readonly string[]): Promise<number | undefined> {
  const [command, ...rest] = args
  if (command !== 'enable') return undefined
  try {
    let bundleName: string | undefined
    let empty = false
    for (const argument of rest) {
      if (argument === '--empty' && !empty) empty = true
      else if (!argument.startsWith('-') && bundleName === undefined) bundleName = argument
      else throw new Error('usage: dsh plugin --profile <name> enable [--empty] <carried-optional-bundle>')
    }
    if (bundleName === undefined) throw new Error('usage: dsh plugin --profile <name> enable [--empty] <carried-optional-bundle>')
    if (!OPTIONAL_BUNDLES.includes(bundleName)) throw new Error('enable requires an optional bundle carried by this dsh installation')
    const selectedBundle = bundleName
    // The second anchor deliberately repeats the installation, never a profile-local replacement.
    const bundleDir = resolveBundleDir('dsh', bundleName, INSTALL_ANCHOR, dirname(INSTALL_ANCHOR))
    const installed = readProfileManifest('dsh', bundleDir)
    const patch = installed.dsh?.bundle?.patch
    if (installed.name !== bundleName || typeof patch !== 'string' || patch.trim() === ''
      || !statSync(resolve(bundleDir, patch)).isFile()) {
      throw new Error('the installed optional package must declare an available bundle patch')
    }
    assertBundlePlatform(installed.dsh?.bundle?.platforms, process.platform)
    const dir = resolveProfileDir(profile)
    if (profile !== 'desktop') await mkdir(dir, { recursive: true })
    await withFileLock(join(dir, 'package.json'), () => {
      if (profile === 'desktop') requireDesktopProfile(dir)
      const compatibility = readProfileCompatibility(dir)
      for (const warning of compatibility.warnings) process.stderr.write(`dsh: warning: ${warning}\n`)
      const issue = evaluatePluginCompatibility(installed, compatibility.exemptions)
      if (issue !== undefined && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue))
      if (!existsSync(join(dir, 'package.json'))) {
        initProfile(dir, empty ? [] : PROFILE_TEMPLATES[profile]?.bundles ?? DEFAULT_PROFILE_BUNDLES)
      }
      const manifest = readProfileManifest('dsh', dir)
      const bundles = manifest.dsh?.profile?.bundles ?? []
      if (!Array.isArray(bundles) || bundles.some(value => typeof value !== 'string')) {
        throw new Error('the profile bundle list must contain only package names; repair its package.json before enabling a bundle')
      }
      if (!bundles.includes(selectedBundle)) writeProfileBundles(dir, manifest, [...bundles, selectedBundle])
      process.stdout.write(`dsh: enabled ${selectedBundle} in profile ${profile}\n`)
      return Promise.resolve()
    }, { waitMs: 120000 })
    return 0
  } catch (error) {
    process.stderr.write(`dsh: ${String(error)}\n`)
    return 1
  }
}

/** Parse only DSH-owned commands; all other arguments remain pnpm's responsibility. */
async function versionCommand(profile: string, args: readonly string[]): Promise<number | undefined> {
  const [command, ...rest] = args
  if (command !== 'allow-version' && command !== 'revoke-version' && command !== 'version-exemptions') return undefined
  try {
    let packageVersion: string | undefined
    let runtimeVersion: string | undefined
    let acceptRisk = false
    const argumentsIterator = rest.values()
    for (const argument of argumentsIterator) {
      if (argument === '--accept-risk' && command === 'allow-version' && !acceptRisk) acceptRisk = true
      else if (argument === '--dsh-version' && runtimeVersion === undefined) runtimeVersion = argumentsIterator.next().value
      else if (argument.startsWith('--dsh-version=') && runtimeVersion === undefined) runtimeVersion = argument.slice('--dsh-version='.length)
      else if (!argument.startsWith('-') && packageVersion === undefined) packageVersion = argument
      else throw new Error(`unexpected argument ${JSON.stringify(argument)}`)
    }
    if (command === 'version-exemptions' && rest.length > 0) throw new Error('usage: dsh plugin version-exemptions')
    let request: { packageVersion: string; runtimeVersion: string } | undefined
    if (command !== 'version-exemptions') {
      if (packageVersion === undefined || runtimeVersion === undefined) {
        throw new Error(`usage: dsh plugin ${command} <package@version> --dsh-version <exact>${command === 'allow-version' ? ' --accept-risk' : ''}`)
      }
      request = { packageVersion, runtimeVersion }
    }
    if (command === 'allow-version') {
      process.stderr.write('dsh: warning: allowing incompatible plugin versions can break the application or corrupt data. Approval applies only to the exact package and DSH versions.\n')
    }
    const dir = resolveProfileDir(profile)
    if (profile !== 'desktop') await mkdir(dir, { recursive: true })
    await withFileLock(join(dir, 'package.json'), async () => {
      if (profile === 'desktop') requireDesktopProfile(dir)
      else if (!existsSync(join(dir, 'package.json'))) initProfile(dir, PROFILE_TEMPLATES[profile]?.bundles ?? DEFAULT_PROFILE_BUNDLES)
      if (request === undefined) {
        const { exemptions, warnings } = readProfileCompatibility(dir)
        for (const warning of warnings) process.stderr.write(`dsh: warning: ${warning}\n`)
        process.stdout.write(JSON.stringify(exemptions, undefined, 2) + '\n')
      } else {
        await setProfileVersionExemption(dir, request.packageVersion, request.runtimeVersion, command === 'allow-version', acceptRisk)
        process.stdout.write(`dsh: ${command === 'allow-version' ? 'allowed' : 'revoked'} ${request.packageVersion} for DSH ${request.runtimeVersion}\n`)
      }
    }, { waitMs: 120000 })
    return 0
  } catch (error) {
    process.stderr.write(`dsh: ${String(error)}\n`)
    return 1
  }
}

/** Run package management for a profile.
 * @param profile Profile name; Desktop's reserved profile must already be initialized by the application.
 * @param args DSH bundle activation, exemption command, or pnpm arguments relative to the invoking directory.
 * @param packageManager Installation-owned executable and environment for pnpm operations.
 * @returns Zero on success; nonzero on invalid approval or package-manager failure.
 */
export async function runPlugin(profile: string, args: readonly string[], packageManager?: ProfileContext['packageManager']): Promise<number> {
  if (profile === 'desktop') {
    try { requireDesktopProfile(resolveProfileDir(profile)) } catch (error) {
      process.stderr.write(`dsh: ${String(error)}\n`)
      return 1
    }
  }
  const enabled = await enableBundleCommand(profile, args)
  if (enabled !== undefined) return enabled
  const versionResult = await versionCommand(profile, args)
  if (versionResult !== undefined) return versionResult
  const dir = resolveProfileDir(profile)
  if (existsSync(join(dir, 'package.json'))) {
    for (const warning of readProfileCompatibility(dir).warnings) process.stderr.write(`dsh: warning: ${warning}\n`)
  }
  const context = { profile, dir, installAnchor: INSTALL_ANCHOR, cwd: process.cwd() }
  const options: PackageOperationOptions = {
    ...packageManager,
    execution: 'cli',
    outputBytes: 16384,
    lockWaitMs: 120000,
    lookupTimeoutMs: 120000,
    onOutput: (text, stream) => { process[stream].write(text) },
  }
  const result = profile === 'desktop'
    ? await withFileLock(join(dir, 'package.json'), async () => {
      requireDesktopProfile(dir)
      return runProfilePnpm(context, args, options)
    }, { waitMs: 120000 })
    : await runPluginCommand(context, args, options)
  if (result.exitCode === 127) process.stderr.write('dsh: pnpm was not found; install pnpm and make it available on PATH.\n')
  for (const { name, version, runtimeVersion } of result.incompatible ?? []) {
    process.stderr.write(`dsh: to accept the risk, run: dsh plugin --profile ${profile} allow-version ${name}@${version} --dsh-version ${runtimeVersion} --accept-risk\n`)
  }
  if (result.exitCode !== 0) process.stderr.write(`dsh: plugin command failed; diagnostics: ${result.logPath}\n`)
  if (result.exitCode !== 0 && args.some(argument => /^git\+|^github:|\.git(?:#|$)/.test(argument))) {
    process.stderr.write(`dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above under allowBuilds in ${join(resolveProfileDir(profile), 'pnpm-workspace.yaml')}, then re-run\n`)
  }
  return result.exitCode
}
