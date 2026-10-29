/** @vitest-environment jsdom */
/** The approval UI defaults every discovered tool on but never auto-confirms. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CloudConnectionCard, type CloudConnectionCardProps, type CloudConnectionActions } from '../src/client/CloudConnectionCard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

describe('Supabase tool approval screen', () => {
  it('preselects Database read/write tools and allows unchecking before a deliberate confirm', async () => {
    const confirm = vi.fn(async () => [])
    const actions: CloudConnectionActions = {
      list: async () => [{
        provider: 'supabase', status: 'choose-permissions', enabledTools: [],
        tools: [
          { name: 'list_tables', description: 'Inspect schema' },
          { name: 'execute_sql', description: 'Query database' },
          { name: 'apply_migration', description: 'Change schema' },
        ],
      }],
      start: async () => ({ url: 'https://example.test/login' }),
      confirm,
      disconnect: async () => [],
    }
    render(<CloudConnectionCard {...({
      view: 'page', provider: 'supabase', actions, t: (key: keyof typeof en) => en[key],
    } as CloudConnectionCardProps)} />)
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /execute_sql/ })).toHaveProperty('checked', true)
      expect(screen.getByRole('checkbox', { name: /apply_migration/ })).toHaveProperty('checked', true)
      expect(screen.getByRole('checkbox', { name: /list_tables/ })).toHaveProperty('checked', true)
    })
    expect(confirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: /apply_migration/ }))
    fireEvent.click(screen.getByRole('button', { name: en.enableSelected }))
    await waitFor(() => { expect(confirm).toHaveBeenCalledWith('supabase', ['list_tables', 'execute_sql']) })
  })
})
