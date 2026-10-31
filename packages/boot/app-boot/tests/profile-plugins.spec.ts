/** Installed metadata and shared bundle activation across profile package operations. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readProfilePlugins, reconcileProfilePlugins, writeProfileBundles, type ProfilePluginLocation } from '../src/profile-plugins.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeManifest(dir: string, value: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(value))
}

function fixture(): ProfilePluginLocation {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-plugins-'))
  roots.push(root)
  const profileDir = join(root, 'profile')
  const installAnchor = join(root, 'runtime', 'package.json')
  writeManifest(dirname(installAnchor), { name: 'fixture-runtime' })
  writeManifest(profileDir, {})
  return { binName: 'test', profileDir, installAnchor }
}

function installed(location: ProfilePluginLocation, name: string, bundle = true): void {
  writeManifest(join(location.profileDir, 'node_modules', name), {
    name, version: '1.0.0', ...(bundle ? { dsh: { bundle: { patch: 'unbuilt.yml' } } } : {}),
  })
}

it('refuses automatic activation on an unsupported Host without changing the bundle selection', () => {
  const location = fixture()
  const before = readProfilePlugins(location)
  writeManifest(location.profileDir, { dependencies: { restricted: '1.0.0' }, dsh: { profile: { bundles: [] } } })
  writeManifest(join(location.profileDir, 'node_modules/restricted'), { name: 'restricted', dsh: { bundle: {
    patch: 'unused.yml', platforms: [process.platform === 'darwin' ? 'win32' : 'darwin'],
  } } })
  const saved = readFileSync(join(location.profileDir, 'package.json'), 'utf8')
  expect(() => reconcileProfilePlugins({ ...location, before, preserveDisabled: true })).toThrow('Host is running')
  expect(readFileSync(join(location.profileDir, 'package.json'), 'utf8')).toBe(saved)
})

describe('profile plugin inventory', () => {
  it('uses dependency alias keys, installed versions, and the loader installation precedence', () => {
    const location = fixture()
    writeManifest(location.profileDir, {
      dependencies: { alias: 'file:../local-package', shared: '^2', library: '^1', missing: 'git+example', unversioned: 'file:../unversioned' },
      dsh: { profile: { bundles: ['shared', 'alias'] } },
    })
    const source = join(location.profileDir, '..', 'local-package')
    writeManifest(source, { name: 'original-name', version: '3.0.0', dsh: { bundle: { patch: 'missing.yml' } } })
    mkdirSync(join(location.profileDir, 'node_modules'))
    symlinkSync(source, join(location.profileDir, 'node_modules', 'alias'), 'junction')
    installed(location, 'shared', false)
    installed(location, 'library', false)
    writeManifest(join(location.profileDir, 'node_modules', 'unversioned'), { name: 'unversioned' })
    writeManifest(join(dirname(location.installAnchor), 'node_modules', 'shared'), {
      name: 'shared', version: '9.0.0', dsh: { bundle: { patch: 'bundle.yml' } },
    })
    expect(readProfilePlugins(location).dependencies).toEqual([
      { name: 'alias', version: '3.0.0', bundle: true, enabled: true },
      { name: 'shared', version: '1.0.0', bundle: true, enabled: true },
      { name: 'library', version: '1.0.0', bundle: false, enabled: false },
      { name: 'missing', version: 'git+example', bundle: false, enabled: false },
      { name: 'unversioned', version: 'file:../unversioned', bundle: false, enabled: false },
    ])
  })

  it('keeps malformed installed metadata visible and accepts an empty profile', () => {
    const location = fixture()
    expect(readProfilePlugins(location)).toEqual({ manifest: {}, dependencies: [] })
    writeManifest(location.profileDir, { dependencies: { broken: '^1', invalid: '^2' } })
    installed(location, 'broken')
    writeFileSync(join(location.profileDir, 'node_modules', 'broken', 'package.json'), '{')
    writeManifest(join(location.profileDir, 'node_modules', 'invalid'), [])
    expect(readProfilePlugins(location).dependencies).toEqual([
      { name: 'broken', version: '^1', bundle: false, enabled: false },
      { name: 'invalid', version: '^2', bundle: false, enabled: false },
    ])
  })
})

describe('profile plugin reconciliation', () => {
  it.each([
    { selected: ['web'], dependencies: {}, added: ['complete'] },
    { selected: ['complete'], dependencies: { complete: '^1' }, added: ['layer'] },
    { selected: [], dependencies: {}, added: ['complete', 'layer'] },
    { selected: [], dependencies: {}, added: ['layer', 'complete'] },
  ])('refuses automatic standalone activation for $selected plus $added without changing profile files', ({ selected, dependencies, added }) => {
    const location = fixture()
    const manifest = { dependencies, dsh: { profile: { bundles: selected } }, custom: { keep: true } }
    writeManifest(location.profileDir, manifest)
    installed(location, 'web')
    installed(location, 'layer')
    writeManifest(join(location.profileDir, 'node_modules', 'complete'), {
      name: 'complete', version: '1.0.0', dsh: { bundle: { patch: 'unbuilt.yml', standalone: true } },
    })
    const before = readProfilePlugins(location)
    writeManifest(location.profileDir, {
      ...manifest, dependencies: { ...dependencies, ...Object.fromEntries(added.map(name => [name, '^1'])) },
    })
    const manifestBytes = readFileSync(join(location.profileDir, 'package.json'), 'utf8')
    const patchBytes = '# keep user overrides\n[]\n'
    writeFileSync(join(location.profileDir, 'cordis.patch.yml'), patchBytes)
    expect(() => reconcileProfilePlugins({ ...location, before, preserveDisabled: true }))
      .toThrow('complete: standalone bundles must be the only selected profile bundle')
    expect(readFileSync(join(location.profileDir, 'package.json'), 'utf8')).toBe(manifestBytes)
    expect(readFileSync(join(location.profileDir, 'cordis.patch.yml'), 'utf8')).toBe(patchBytes)
    expect(readProfilePlugins(location).dependencies.map(dependency => dependency.name))
      .toEqual([...Object.keys(dependencies), ...added])
  })

  it('automatically activates a lone complete application', () => {
    const location = fixture()
    const before = readProfilePlugins(location)
    writeManifest(location.profileDir, { dependencies: { complete: '^1' } })
    writeManifest(join(location.profileDir, 'node_modules', 'complete'), {
      name: 'complete', dsh: { bundle: { patch: 'unbuilt.yml', standalone: true } },
    })
    const result = reconcileProfilePlugins({ ...location, before, preserveDisabled: true })
    expect(result.plugins.manifest.dsh?.profile?.bundles).toEqual(['complete'])
    expect(result.plugins.dependencies).toEqual([{ name: 'complete', version: '^1', bundle: true, enabled: true }])
  })

  it.each([undefined, false])('preserves ordinary layer order when standalone metadata is %s', (standalone) => {
    const location = fixture()
    writeManifest(location.profileDir, { dsh: { profile: { bundles: ['web'] } } })
    const before = readProfilePlugins(location)
    writeManifest(location.profileDir, { dependencies: { second: '^1', first: '^1' }, dsh: { profile: { bundles: ['web'] } } })
    for (const name of ['web', 'second', 'first']) {
      writeManifest(join(location.profileDir, 'node_modules', name), {
        name, dsh: { bundle: { patch: 'unbuilt.yml', standalone } },
      })
    }
    expect(reconcileProfilePlugins({ ...location, before, preserveDisabled: true }).plugins.manifest.dsh?.profile?.bundles)
      .toEqual(['web', 'second', 'first'])
  })

  it.each([false, true])('refuses malformed standalone metadata on a bundle selected before reconciliation=%s', (selected) => {
    const location = fixture()
    writeManifest(location.profileDir, { dsh: { profile: { bundles: selected ? ['invalid'] : [] } } })
    writeManifest(join(location.profileDir, 'node_modules', 'invalid'), {
      name: 'invalid', dsh: { bundle: { patch: 'unbuilt.yml', standalone: 'true' } },
    })
    const before = readProfilePlugins(location)
    writeManifest(location.profileDir, {
      dependencies: { invalid: '^1' }, dsh: { profile: { bundles: selected ? ['invalid'] : [] } },
    })
    const bytes = readFileSync(join(location.profileDir, 'package.json'), 'utf8')
    expect(() => reconcileProfilePlugins({ ...location, before, preserveDisabled: true }))
      .toThrow('invalid: dsh.bundle.standalone must be a boolean')
    expect(readFileSync(join(location.profileDir, 'package.json'), 'utf8')).toBe(bytes)
  })

  it('retains unavailable template layers while keeping unreadable dependencies visible for repair', () => {
    const location = fixture()
    const manifest = {
      dependencies: { broken: '^1' }, dsh: { profile: { bundles: ['missing-template', 'broken-template', 'broken'] } },
    }
    writeManifest(location.profileDir, manifest)
    for (const name of ['broken-template', 'broken']) {
      installed(location, name)
      writeFileSync(join(location.profileDir, 'node_modules', name, 'package.json'), '{')
    }
    const before = readProfilePlugins(location)
    writeManifest(location.profileDir, { ...manifest, dependencies: { broken: '^1', added: '^1' } })
    installed(location, 'added')
    const result = reconcileProfilePlugins({ ...location, before, preserveDisabled: true })
    expect(result.plugins.manifest.dsh?.profile?.bundles).toEqual(['missing-template', 'broken-template', 'added'])
    expect(result.plugins.dependencies).toEqual([
      { name: 'broken', version: '^1', bundle: false, enabled: false },
      { name: 'added', version: '1.0.0', bundle: true, enabled: true },
    ])
  })

  it.each([false, true])('reconciles declarations and removal while preserveDisabled=%s', (preserveDisabled) => {
    const location = fixture()
    const beforeManifest = {
      name: 'custom-profile', private: false, custom: { keep: true },
      dependencies: { active: '^1', disabled: '^1', gaining: '^1', losing: '^1', removed: '^1' },
      dsh: { profile: { bundles: ['template', 'template', 'active', 'losing', 'removed'] } },
    }
    writeManifest(location.profileDir, beforeManifest)
    for (const name of Object.keys(beforeManifest.dependencies)) installed(location, name, name !== 'gaining')
    const before = readProfilePlugins(location)
    writeManifest(location.profileDir, {
      ...beforeManifest,
      dependencies: { active: '^2', disabled: '^2', gaining: '^2', losing: '^2', added: '^1', 'new-library': '^1' },
    })
    installed(location, 'gaining')
    installed(location, 'losing', false)
    installed(location, 'added')
    installed(location, 'new-library', false)
    const result = reconcileProfilePlugins({ ...location, before, preserveDisabled })
    const bundles = ['template', 'template', 'active', ...preserveDisabled ? [] : ['disabled'], 'gaining', 'added']
    expect(result.plugins.manifest.dsh?.profile?.bundles).toEqual(bundles)
    expect(result.plugins.dependencies.filter(dependency => dependency.enabled).map(dependency => dependency.name))
      .toEqual(['active', ...preserveDisabled ? [] : ['disabled'], 'gaining', 'added'])
    expect(result.addedPlainDependencies).toEqual(['new-library'])
    expect(JSON.parse(readFileSync(join(location.profileDir, 'package.json'), 'utf8'))).toMatchObject({
      custom: { keep: true }, private: false, dsh: { profile: { bundles } },
    })
    const bytes = readFileSync(join(location.profileDir, 'package.json'), 'utf8')
    expect(reconcileProfilePlugins({ ...location, before: result.plugins, preserveDisabled }).addedPlainDependencies).toEqual([])
    expect(readFileSync(join(location.profileDir, 'package.json'), 'utf8')).toBe(bytes)
  })

  it('writes newly activated bundles when profile metadata is absent', () => {
    const location = fixture()
    const before = readProfilePlugins(location)
    writeManifest(location.profileDir, { dependencies: { added: '^1' } })
    installed(location, 'added')
    expect(reconcileProfilePlugins({ ...location, before, preserveDisabled: false }).plugins.manifest.dsh?.profile?.bundles)
      .toEqual(['added'])
  })

  it('removes an unresolved dependency layer while preserving custom profile metadata', () => {
    const location = fixture()
    writeManifest(location.profileDir, { dependencies: { missing: '^1' }, dsh: { profile: { bundles: ['missing', 'template'] } } })
    const before = readProfilePlugins(location)
    const reconciled = reconcileProfilePlugins({ ...location, before, preserveDisabled: true })
    expect(reconciled.plugins.manifest.dsh?.profile?.bundles).toEqual(['template'])
    expect(writeProfileBundles(location.profileDir, reconciled.plugins.manifest, ['template', 'manual']).dsh?.profile?.bundles)
      .toEqual(['template', 'manual'])
  })
})
