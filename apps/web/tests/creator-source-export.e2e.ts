/** Review and download Creator source through the assembled Web profile without a model request. */
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit, type Browser } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import type { ForkPreviewResult, SourceExportResult } from '@deepseek-ai/dsh-plugin-manager'
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

it.each([
  { name: 'Chromium', engine: chromium },
  { name: 'WebKit', engine: webkit },
])('$name explicitly reviews and publishes Creator sources, then retries an incomplete PR on mobile', async ({ engine }) => {
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-source-publish-web-'))
  const source = join(fixture, 'bundle')
  const transport = join(fixture, 'github')
  const evidence = await mkdtemp(join(tmpdir(), 'dsh-source-publish-evidence-'))
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    await mkdir(source)
    await mkdir(transport)
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: '@fixture/creator-source-publish', version: '1.0.0', type: 'module', dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }) + '\n')
    await writeFile(join(source, 'cordis.patch.yml'), '[]\n')
    await writeFile(join(source, 'index.ts'), ORIGINAL_SOURCE)
    const gh = join(transport, 'gh.mjs')
    await copyFile(fileURLToPath(new URL('./fixtures/creator-fork-gh.mjs', import.meta.url)), gh)
    await chmod(gh, 0o700)
    await writeFile(join(transport, 'calls.jsonl'), '')
    await writeFile(join(transport, 'state.json'), JSON.stringify({
      head: 'a'.repeat(40), branch: 'creator/saved', before: ORIGINAL_SOURCE.slice(0, -1), files: [], failPr: true, pr: false,
    }))
    const overlay = join(fixture, 'fork.patch.yml')
    await writeFile(overlay, `- id: plugin-manager\n  config: ${JSON.stringify({ fork: { ghCommand: gh, timeoutMs: 60_000 } })}\n`)
    scaffold = await launchWebScaffold({
      extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
      profile: { packages: [{ dir: source, enabled: true }] }, agentPresets: { default: 'standard' },
    })
    browser = await engine.launch()
    const page = await newEnglishPage(browser)
    // The product opens the confirmed URL; browser traffic to that external page remains inside this fixture.
    await page.context().route('https://github.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Fixture pull request</title>' }))
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `web-e2e-creator-source-publish-${engine.name()}`))
    const workspaceCwd = scaffold.workspaceCwd
    const compareAria = async (filename: string): Promise<void> => {
      if (engine !== chromium) return
      await compareOrRefreshGolden(join(EXPECTED, filename), await captureStableAria(page, '[role="dialog"]', workspaceCwd), MODE)
    }
    type GithubCall = { method: string; path: string; body?: Record<string, unknown> }
    const calls = async (): Promise<GithubCall[]> => (await readFile(join(transport, 'calls.jsonl'), 'utf8')).split('\n')
      .filter(Boolean).map(line => JSON.parse(line) as GithubCall)
    const apiCalls: string[] = []
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/api/creatorFork/')) apiCalls.push(path)
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, workspaceCwd)
    await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
    const menuTrigger = page.getByRole('button', { name: 'Choose how to add a plugin', exact: true })
    await expect.poll(() => menuTrigger.isEnabled(), { timeout: 30_000 }).toBe(true)
    await menuTrigger.click()
    const entry = page.getByRole('menuitem', { name: /^Save to My Fork/ })
    await expect.poll(() => entry.isEnabled(), { timeout: 30_000 }).toBe(true)
    await entry.click()
    const local = page.getByRole('dialog', { name: 'Save to My Fork', exact: true })
    await local.getByRole('button', { name: 'Save directly to GitHub', exact: true }).click()
    await local.waitFor({ state: 'detached' })
    const dialog = page.getByRole('dialog', { name: 'Save to my GitHub fork', exact: true })
    await dialog.waitFor()
    expect(apiCalls).toEqual([])
    expect(await calls()).toEqual([])
    if (engine === chromium) await mkdir(EXPECTED, { recursive: true })
    await compareAria('publish-before-connect.expected.md')
    await dialog.getByRole('button', { name: 'Load my GitHub forks', exact: true }).click()
    const repository = dialog.getByRole('combobox', { name: 'Fork repository', exact: true })
    await repository.waitFor()
    expect(await repository.locator('option').evaluateAll(options => options.map(option => option.getAttribute('value'))))
      .toEqual(['', 'alice/harness'])
    await repository.selectOption('alice/harness')
    const branch = dialog.getByRole('textbox', { name: 'Branch', exact: true })
    await branch.fill('creator/saved')
    const responsePromise = page.waitForResponse('**/api/creatorFork/preview')
    await dialog.getByRole('button', { name: 'Preview changes', exact: true }).click()
    const envelope = await (await responsePromise).json() as { result: { ok: boolean; value: ForkPreviewResult } }
    expect(envelope.result.ok).toBe(true)
    const captured = envelope.result.value
    if (captured.status !== 'ready') throw new Error(`Publication preview was blocked: ${captured.code}`)
    expect(await dialog.getByText('alice/harness:master', { exact: true }).count()).toBe(1)
    const sourcePath = 'creator-exports/saved/bundles/0/index.ts'
    expect(captured.files.find(file => file.path === sourcePath)).toEqual({
      path: sourcePath, before: ORIGINAL_SOURCE.slice(0, -1), after: ORIGINAL_SOURCE,
    })
    const file = dialog.locator('details').filter({ has: page.locator('summary').filter({ hasText: sourcePath }) })
    const texts = await file.locator('pre').allTextContents()
    expect(texts).toContain(JSON.stringify(ORIGINAL_SOURCE.slice(0, -1)))
    expect(texts).toContain(JSON.stringify(ORIGINAL_SOURCE))
    expect(texts).toContain(ORIGINAL_SOURCE.slice(0, -1))
    expect(texts).toContain(ORIGINAL_SOURCE)
    const confirm = dialog.getByRole('button', { name: 'Confirm commit and open PR', exact: true })
    expect(await confirm.isEnabled()).toBe(false)
    expect(apiCalls.filter(path => path.endsWith('/publish'))).toEqual([])
    expect((await calls()).filter(call => call.method !== 'GET')).toEqual([])
    await compareAria('publish-preview.expected.md')
    await page.screenshot({ path: join(evidence, 'desktop.png') })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await page.screenshot({ path: join(evidence, 'desktop-dark.png') })
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(false)
    await page.setViewportSize({ width: 390, height: 844 })
    const fits = await dialog.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight
        && document.documentElement.scrollWidth <= innerWidth
        && [...element.querySelectorAll('button, input, select')].every((control) => {
          const rect = control.getBoundingClientRect()
          return rect.left >= bounds.left && rect.right <= bounds.right
        })
    })
    expect(fits).toBe(true)
    await compareAria('publish-mobile.expected.md')
    await page.screenshot({ path: join(evidence, 'mobile.png') })
    await writeFile(join(transport, 'hold-commit'), '')
    await dialog.getByRole('checkbox', { name: 'I checked every file for private information and authorize this commit and pull request', exact: true }).check()
    await confirm.click()
    await dialog.getByText('Saving the reviewed files', { exact: true }).waitFor()
    await expect.poll(async () => (await calls()).filter(call => call.path === 'graphql').length).toBe(1)
    expect(await repository.isEnabled()).toBe(false)
    expect(await branch.isEnabled()).toBe(false)
    await compareAria('publish-pending.expected.md')
    await rm(join(transport, 'hold-commit'))
    await dialog.getByText('The commit was saved, but the pull request could not be confirmed. Retry this same save to finish it.', { exact: true }).waitFor()
    await compareAria('publish-committed.expected.md')
    await dialog.getByRole('button', { name: 'Retry this save', exact: true }).click()
    const link = dialog.getByRole('link', { name: 'Open pull request', exact: true })
    await link.waitFor()
    expect(await link.getAttribute('href')).toBe('https://github.com/alice/harness/pull/17')
    expect(await link.getAttribute('target')).toBe('_blank')
    expect(await link.getAttribute('rel')).toBe('noopener noreferrer')
    const recorded = await calls()
    const writes = recorded.filter(call => call.method !== 'GET')
    expect(writes.map(call => call.path)).toEqual(['graphql', 'repos/alice/harness/pulls', 'repos/alice/harness/pulls'])
    expect(recorded.filter(call => call.path.startsWith('repos/deepseek-ai/deepseek-harness')))
      .toEqual(recorded.filter(call => call.method === 'GET' && call.path === 'repos/deepseek-ai/deepseek-harness'))
    const committed = writes[0]?.body as { variables: { input: {
      branch: { repositoryNameWithOwner: string; branchName: string }
      expectedHeadOid: string
      fileChanges: { additions: { path: string; contents: string }[] }
    } } }
    expect(committed.variables.input.branch).toEqual({ repositoryNameWithOwner: 'alice/harness', branchName: 'creator/saved' })
    expect(committed.variables.input.expectedHeadOid).toBe('a'.repeat(40))
    expect(committed.variables.input.fileChanges.additions).toEqual(captured.files.map(file => ({ path: file.path, contents: Buffer.from(file.after).toString('base64') })))
    await compareAria('publish-saved.expected.md')
    expect(scaffold.ctx.agentPresets.defaultId).toBe('standard')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    await browser?.close()
    await scaffold?.close()
    await rm(fixture, { recursive: true, force: true })
  }
})
