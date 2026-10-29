/** Shipped profile templates, and the offline catalog that does not depend on installed provider packages or registry requests. */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { EXPERIMENTAL_BUNDLES, HIDDEN_BUNDLES, OFFICIAL_ON_DEMAND_CATALOG, ON_DEMAND_BUNDLES, OPTIONAL_BUNDLES, PROFILE_TEMPLATES } from '../src/index.ts'

describe('Official on-demand catalog', () => {
  it('offers exactly the two native subagent integrations with offline localized metadata', () => {
    expect(ON_DEMAND_BUNDLES).toEqual(['@deepseek-ai/dsh-subagent-claude-code', '@deepseek-ai/dsh-subagent-codex'])
    expect(OFFICIAL_ON_DEMAND_CATALOG.map(entry => entry.packageName)).toEqual(ON_DEMAND_BUNDLES)
    for (const entry of OFFICIAL_ON_DEMAND_CATALOG) {
      expect(entry.meta.icon).toMatch(/^data:image\/svg\+xml;base64,/)
      for (const text of [entry.meta.title, entry.meta.description]) {
        if (typeof text === 'string') throw new Error('Official metadata requires both shipped languages')
        expect(text.en).toMatch(/\S/)
        expect(text.zh).toMatch(/\S/)
      }
      expect(entry).not.toHaveProperty('version')
    }
  })
})

describe('Shipped profile templates', () => {
  it('stack each mode bundle on base except the standalone minimal SDK', () => {
    expect(PROFILE_TEMPLATES).toEqual({
      acp: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] },
      web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },
      headless: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] },
      sdk: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] },
      'sdk-minimal': { bundles: ['@deepseek-ai/dsh-sdk-minimal'] },
    })
  })
})

describe('Bundled cloud connections', () => {
  const name = '@deepseek-ai/dsh-experimental-cloud-connectors-bundle'
  const manifestUrl = new URL('../../../experimental/cloud-connectors-bundle/package.json', import.meta.url)

  it('classifies cloud connections as an available experimental bundle without enabling ordinary CLI profiles', () => {
    expect(OPTIONAL_BUNDLES).toContain(name)
    expect(EXPERIMENTAL_BUNDLES.has(name)).toBe(true)
    expect(HIDDEN_BUNDLES.has(name)).toBe(false)
    expect(ON_DEMAND_BUNDLES).not.toContain(name)
    for (const profile of Object.values(PROFILE_TEMPLATES)) expect(profile.bundles).not.toContain(name)
  })

  it('publishes its self-contained icon and localized metadata beside the bundle patch', () => {
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as {
      icon: string
      files: string[]
      exports: { './locale/*.json': string }
      dsh: { bundle: { patch: string; platforms?: string[] } }
    }
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.files).toContain('icon.svg')
    expect(manifest.files).toContain('locale/*.json')
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.exports['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.dsh.bundle).toEqual({ patch: './cordis.patch.yml' })

    const artwork = readFileSync(new URL(manifest.icon, manifestUrl), 'utf8')
    expect(artwork).toContain('width="36" height="36" viewBox="0 0 36 36"')
    expect(artwork).toContain('<path ')
    expect(artwork).not.toMatch(/<(?:script|style|image|foreignObject|text|animate)\b|\bon\w+=|(?:href|xlink:href)=/i)
    for (const language of ['en', 'zh']) {
      const { meta } = JSON.parse(readFileSync(new URL(`./locale/${language}.json`, manifestUrl), 'utf8')) as {
        meta: { title: string; description: string }
      }
      expect(meta.title).toMatch(/\S/)
      expect(meta.description).toMatch(/\S/)
    }
  })
})
