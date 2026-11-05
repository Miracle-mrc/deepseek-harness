/** Review and download Creator source through the assembled Web profile without a model request. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit, type Browser } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import type { SourceExportResult } from '@deepseek-ai/dsh-plugin-manager'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/creator-source-export', import.meta.url))
const MODE = webSnapshotMode()
const ORIGINAL_SOURCE = 'export const greeting = "Created for my fork"\n'

it.each([
  { name: 'Chromium', engine: chromium },
  { name: 'WebKit', engine: webkit },
])('$name reviews Creator sources, downloads the captured files, and retains usable controls on mobile', async ({ engine }) => {
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-source-export-web-'))
  const evidence = await mkdtemp(join(tmpdir(), 'dsh-source-export-evidence-'))
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    await writeFile(join(fixture, 'package.json'), JSON.stringify({
      name: '@fixture/creator-source-export', version: '1.0.0', type: 'module',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }) + '\n')
    await writeFile(join(fixture, 'cordis.patch.yml'), '[]\n')
    await writeFile(join(fixture, 'index.ts'), ORIGINAL_SOURCE)
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      profile: { packages: [{ dir: fixture, enabled: true }] },
      agentPresets: { default: 'standard' },
    })
    browser = await engine.launch()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `web-e2e-creator-source-export-${engine.name()}`))
    const workspaceCwd = scaffold.workspaceCwd
    const compareAria = async (filename: string, selector: string): Promise<void> => {
      if (engine !== chromium) return
      await compareOrRefreshGolden(join(EXPECTED, filename), await captureStableAria(page, selector, workspaceCwd), MODE)
    }
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    expect(scaffold.ctx.agentPresets.defaultId).toBe('standard')
    await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
    const menuTrigger = page.getByRole('button', { name: 'Choose how to add a plugin', exact: true })
    // Plugin inventory and Creator roster readiness are independent of the workspace composer's readiness.
    await expect.poll(() => menuTrigger.isEnabled(), { timeout: 30_000 }).toBe(true)
    await menuTrigger.focus()
    await page.keyboard.press('ArrowDown')
    const entry = page.getByRole('menuitem', { name: /^Save to My Fork/ })
    await expect.poll(() => entry.isEnabled(), { timeout: 30_000 }).toBe(true)
    if (engine === chromium) await mkdir(EXPECTED, { recursive: true })
    await compareAria('menu.expected.md', '[role="menu"]')
    await entry.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Save to My Fork', exact: true })
    await dialog.waitFor()
    expect(await page.getByRole('menu').count()).toBe(0)
    expect(await dialog.textContent()).toContain('This action downloads a local source export.')
    const repository = dialog.getByRole('textbox', { name: 'Fork repository', exact: true })
    const branch = dialog.getByRole('textbox', { name: 'Branch', exact: true })
    await repository.fill('alice/harness')
    await branch.fill('master')
    await dialog.getByRole('button', { name: 'Inspect files', exact: true }).click()
    await dialog.getByText('Enter a valid branch name other than main or master.', { exact: true }).waitFor()
    expect(await branch.getAttribute('aria-invalid')).toBe('true')
    expect(await branch.inputValue()).toBe('master')
    expect(await dialog.getByRole('button', { name: 'Download source export', exact: true }).count()).toBe(0)
    await compareAria('validation.expected.md', '[role="dialog"]')

    await branch.fill('creator-saved')
    const responsePromise = page.waitForResponse('**/api/pluginManager/exportSource')
    await dialog.getByRole('button', { name: 'Inspect files', exact: true }).click()
    const response = await responsePromise
    const envelope = await response.json() as { result: { ok: boolean; value: SourceExportResult } }
    expect(envelope.result.ok).toBe(true)
    const captured = envelope.result.value
    if (captured.status !== 'ready') throw new Error(`Export was blocked: ${JSON.stringify(captured.issues)}`)
    expect(captured.repository).toBe('alice/harness')
    expect(captured.branch).toBe('creator-saved')
    expect(captured.files.find(file => file.path === 'bundles/0/index.ts')?.content).toBe(ORIGINAL_SOURCE)
    const sourceSummary = dialog.locator('summary').filter({ hasText: 'bundles/0/index.ts' })
    await sourceSummary.click()
    expect(await sourceSummary.locator('..').locator('pre').textContent()).toBe(ORIGINAL_SOURCE)
    const downloadButton = dialog.getByRole('button', { name: 'Download source export', exact: true })
    expect(await downloadButton.isEnabled()).toBe(false)
    await compareAria('preview.expected.md', '[role="dialog"]')
    await page.screenshot({ path: join(evidence, 'desktop.png') })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await page.screenshot({ path: join(evidence, 'desktop-dark.png') })
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(false)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => document.fonts.ready)
    const fits = await dialog.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const controls = [...element.querySelectorAll('button, input')].map(control => control.getBoundingClientRect())
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight
        && document.documentElement.scrollWidth <= innerWidth
        && controls.every(control => control.left >= bounds.left && control.right <= bounds.right)
    })
    expect(fits).toBe(true)
    await compareAria('mobile.expected.md', '[role="dialog"]')
    await page.screenshot({ path: join(evidence, 'mobile.png') })

    await dialog.getByRole('checkbox', { name: 'I reviewed every file for private information', exact: true }).check()
    expect(await downloadButton.isEnabled()).toBe(true)
    await writeFile(join(fixture, 'index.ts'), 'export const greeting = "Changed after inspection"\n')
    let exportReads = 0
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/pluginManager/exportSource') exportReads++ })
    const downloaded = page.waitForEvent('download')
    await downloadButton.click()
    const download = await downloaded
    expect(download.suggestedFilename()).toBe('dsh-source-export.json')
    const downloadPath = await download.path()
    if (downloadPath === null) throw new Error('The browser did not retain its source export download')
    expect(await readFile(downloadPath, 'utf8')).toBe(`${JSON.stringify(captured, null, 2)}\n`)
    expect(exportReads).toBe(0)
    await branch.fill('different-target')
    expect(await dialog.getByRole('button', { name: 'Download source export', exact: true }).count()).toBe(0)
    expect(await dialog.getByRole('checkbox').count()).toBe(0)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    expect(await menuTrigger.evaluate(element => element === document.activeElement)).toBe(true)
    expect(scaffold.ctx.agentPresets.defaultId).toBe('standard')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    await browser?.close()
    await scaffold?.close()
    await rm(fixture, { recursive: true, force: true })
  }
})
