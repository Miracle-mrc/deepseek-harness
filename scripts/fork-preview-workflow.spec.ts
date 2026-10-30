import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const repository = 'Miracle-mrc/deepseek-harness'
const files = ['fork-preview.yml', 'fork-preview-build.yml', 'fork-release.yml']

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Expected workflow mapping')
  return Object.fromEntries(Object.entries(value))
}

function workflow(file: string): Record<string, unknown> {
  return record(load(readFileSync(resolve(root, '.github/workflows', file), 'utf8')))
}

function jobs(file: string): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(record(workflow(file).jobs)).map(([name, value]) => [name, record(value)]))
}

function job(file: string, name: string): Record<string, unknown> {
  const value = jobs(file)[name]
  if (!value) throw new TypeError(`Missing workflow job ${name}`)
  return value
}

function steps(job: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(job.steps)) throw new TypeError('Expected workflow steps')
  return job.steps.map(record)
}

function step(job: Record<string, unknown>, name: string): Record<string, unknown> {
  const found = steps(job).find(value => value.name === name)
  if (!found) throw new TypeError(`Missing workflow step ${name}`)
  return found
}

describe('fork preview workflows', () => {
  it('limits the expensive PR packaging matrix to packaging and release inputs', () => {
    const preview = workflow('fork-preview.yml')
    const on = record(preview.on)
    expect(Object.keys(on)).toEqual(['pull_request'])
    expect(record(on.pull_request).paths).toEqual([
      'apps/desktop/**', 'apps/cli/**', 'python/**', 'native/**', 'scripts/*python*',
      'scripts/fork-preview*', 'scripts/release/**', '.github/workflows/**', 'patches/**',
      'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    ])
    expect(job('fork-preview.yml', 'preview')).toMatchObject({
      if: `github.repository == '${repository}'`,
      uses: './.github/workflows/fork-preview-build.yml',
    })
    expect(preview.permissions).toEqual({ contents: 'read' })
  })

  it('builds each unsigned Desktop installer on its native public runner', () => {
    const desktop = job('fork-preview-build.yml', 'desktop')
    expect(desktop['runs-on']).toBe('${{ matrix.runner }}')
    expect(record(record(desktop.strategy).matrix).include).toEqual([
      { target: 'win-x64', command: 'package:desktop:win:x64:unsigned', runner: 'windows-2025', shell: 'pwsh' },
      { target: 'mac-arm64', command: 'package:desktop:mac:arm64:unsigned', runner: 'macos-latest', shell: 'bash' },
      { target: 'mac-x64', command: 'package:desktop:mac:x64:unsigned', runner: 'macos-15-intel', shell: 'bash' },
    ])
    expect(record(record(desktop.defaults).run).shell).toBe('${{ matrix.shell }}')
    expect(step(desktop, 'Build and verify unsigned preview installer').run)
      .toBe('pnpm run ${{ matrix.command }} --fork-preview')
    expect(step(desktop, 'Select the verified installer').run)
      .toBe('python scripts/fork-preview-release.py collect-desktop --target ${{ matrix.target }}')
  })

  it('passes the same resolved source to all six wheels and all Desktop build jobs', () => {
    const python = job('fork-preview-build.yml', 'python')
    expect(job('fork-preview-build.yml', 'metadata').if).toBe(`github.repository == '${repository}'`)
    expect(python.uses).toBe('./.github/workflows/build-exe-for-python-sdk.yml')
    expect(python.with).toEqual({
      source_ref: '${{ needs.metadata.outputs.commit }}',
      targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64,node24-win-x64',
      release: true,
      ci: false,
    })
    expect(python).not.toHaveProperty('secrets')
    for (const id of ['desktop', 'python-compat', 'bundle']) {
      const checkout = steps(job('fork-preview-build.yml', id)).find(value => value.uses === 'actions/checkout@v7.0.1')
      expect(checkout?.with).toMatchObject({
        ref: '${{ needs.metadata.outputs.commit }}',
        'persist-credentials': false,
      })
    }
    for (const id of ['plan', 'sdk-wheel', 'build']) {
      const checkout = steps(job('build-exe-for-python-sdk.yml', id)).find(value => value.uses === 'actions/checkout@v7.0.1')
      expect(checkout?.with).toMatchObject({ ref: '${{ inputs.source_ref || github.sha }}', 'persist-credentials': false })
    }
  })

  it('checks Python 3.10 and 3.14 using candidate SDK and runtime wheels without index fallback', () => {
    const compatibility = job('fork-preview-build.yml', 'python-compat')
    expect(record(record(compatibility.strategy).matrix).python).toEqual(['3.10', '3.14'])
    const command = step(compatibility, 'Install only candidate wheels and run the public SDK entry').run
    expect(command).toContain('pip install --no-index --find-links')
    expect(command).toContain('dist/deepseek_harness_sdk-$VERSION-py3-none-any.whl')
    expect(command).toContain('dist/deepseek_harness_runtime_bin-$VERSION-py3-none-manylinux_2_28_x86_64.whl')
    expect(command).toContain('--scenario sdk-default --installed-wheel')
    expect(command).toContain('--scenario sdk-mcp --installed-wheel')
    expect(job('fork-preview-build.yml', 'bundle').needs).toEqual(['metadata', 'desktop', 'python', 'python-compat'])
  })

  it('dispatches trusted master workflow code and binds publication to the checked source tag', () => {
    const release = workflow('fork-release.yml')
    expect(release.permissions).toEqual({ contents: 'read', actions: 'read', checks: 'read', 'pull-requests': 'read' })
    expect(release.on).toEqual({ workflow_dispatch: { inputs: {
      source_tag: { description: 'Existing immutable fork-v<productVersion>-miracle.<N> tag reachable from master.', type: 'string', required: true },
    } } })
    const publication = job('fork-release.yml', 'publish')
    for (const id of ['source', 'publish']) {
      expect(job('fork-release.yml', id).if).toBe(`github.repository == '${repository}' && github.ref == 'refs/heads/master'`)
      const checkout = steps(job('fork-release.yml', id)).find(value => value.uses === 'actions/checkout@v7.0.1')
      expect(checkout?.with).toEqual({ ref: '${{ github.sha }}', 'fetch-depth': 0, 'persist-credentials': false })
    }
    expect(job('fork-release.yml', 'build').with).toEqual({ source_ref: '${{ needs.source.outputs.commit }}', source_tag: '${{ inputs.source_tag }}' })
    expect(step(publication, 'Recheck source identity and successful checks').env).toMatchObject({
      FORK_PREVIEW_EXPECTED_COMMIT: '${{ needs.source.outputs.commit }}',
      FORK_PREVIEW_EXPECTED_TAG_OBJECT: '${{ needs.source.outputs.tag-object }}',
    })
    const publish = step(publication, 'Create draft prerelease in the fork').run
    expect(publish).toContain('--repo Miracle-mrc/deepseek-harness')
    expect(publish).toContain('--verify-tag --target "$SOURCE_COMMIT" --draft --prerelease')
    expect(step(publication, 'Recheck exact release assets and SHA256').run)
      .toBe('python scripts/fork-preview-release.py verify-bundle --input-dir dist-fork-preview')
    expect(record(publication.permissions)['pull-requests']).toBe('read')
    for (const id of ['source', 'publish']) {
      expect(step(job('fork-release.yml', id), 'Refresh current master').run)
        .toBe('git fetch --no-tags origin master:refs/remotes/origin/master')
    }
  })

  it('retains read permissions until the final draft job and passes no publishing secrets', () => {
    for (const file of files) {
      expect(record(workflow(file).permissions).contents).toBe('read')
      const source = readFileSync(resolve(root, '.github/workflows', file), 'utf8')
      expect(source).not.toMatch(/secrets[.:]|id-token:|npm publish|pypi-publish|COS_SECRET|APPLE_|CSC_LINK/)
      for (const [id, job] of Object.entries(jobs(file))) {
        expect(job['continue-on-error']).toBeUndefined()
        expect(job).not.toHaveProperty('secrets')
        if (job.permissions) {
          expect([file, id]).toEqual(['fork-release.yml', 'publish'])
          expect(record(job.permissions).contents).toBe('write')
        }
      }
    }
  })

  it('fails the shared verdict for missing, skipped, cancelled, or failed build evidence', () => {
    const verdict = job('fork-preview-build.yml', 'verdict')
    expect(verdict.if).toBe('${{ !cancelled() }}')
    expect(verdict.needs).toEqual(['metadata', 'desktop', 'python', 'python-compat', 'bundle'])
    expect(steps(verdict)).toEqual([{
      name: 'Fail if any preview build or validation did not succeed',
      if: "contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped')",
      run: 'exit 1',
    }])
    expect(job('fork-release.yml', 'publish').needs).toEqual(['source', 'build'])
  })
})
