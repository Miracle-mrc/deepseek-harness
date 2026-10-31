/** Complete application bundles require an exclusive selection through every public admission caller. */

import { describe, expect, it } from 'vitest'
import { assertBundleSelection, UnsupportedBundleSelectionError } from '../src/index.ts'

describe('standalone bundle selection', () => {
  const name = 'complete-application'

  it.each([undefined, false])('permits ordinary layers when standalone metadata is %s', (standalone) => {
    expect(() => { assertBundleSelection(name, standalone, [name]) }).not.toThrow()
    expect(() => { assertBundleSelection(name, standalone, ['base', name, 'web']) }).not.toThrow()
  })

  it('permits the complete application as the sole selected bundle', () => {
    expect(() => { assertBundleSelection(name, true, [name]) }).not.toThrow()
  })

  it.each([
    { selected: [] }, { selected: ['another'] }, { selected: [name, 'web'] },
    { selected: ['base', name] }, { selected: [name, name] },
  ])('rejects an invalid standalone selection with a typed error: $selected', ({ selected }) => {
    expect(() => { assertBundleSelection(name, true, selected) }).toThrow(UnsupportedBundleSelectionError)
    expect(() => { assertBundleSelection(name, true, selected) }).toThrow(`${name}: standalone bundles must be the only selected profile bundle`)
  })

  it.each([null, 0, 'true', [], {}].map(standalone => ({ standalone })))(
    'distinguishes malformed raw metadata from a valid standalone selection refusal: $standalone', ({ standalone }) => {
      let failure: unknown
      try { assertBundleSelection(name, standalone, [name]) } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBeInstanceOf(UnsupportedBundleSelectionError)
      expect(failure).toHaveProperty('message', `${name}: dsh.bundle.standalone must be a boolean`)
    },
  )
})
