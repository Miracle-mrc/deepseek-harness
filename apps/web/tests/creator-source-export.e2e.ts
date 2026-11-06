/** Review and download Creator source through the assembled Web profile without a model request. */
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit, type Browser, type Locator } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import type { ForkPreviewResult, SourceExportResult } from '@deepseek-ai/dsh-plugin-manager'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/creator-source-export', import.meta.url))
const MODE = webSnapshotMode()
const ORIGINAL_SOURCE = 'export const greeting = "Created for my fork"\n'
const PUBLISH_SOURCE_PATH = 'creator-exports/saved/bundles/0/index.ts'
type PublicationFile = Extract<ForkPreviewResult, { status: 'ready' }>['files'][number]
type GithubCall = { method: string; path: string; body?: Record<string, unknown> }

async function preparePublicationGithub(transport: string, before: string, failPr: boolean): Promise<string> {
  const gh = join(transport, 'gh.mjs')
  await copyFile(fileURLToPath(new URL('./fixtures/creator-fork-gh.mjs', import.meta.url)), gh)
  await chmod(gh, 0o700)
  await writeFile(join(transport, 'calls.jsonl'), '')
  await writeFile(join(transport, 'state.json'), JSON.stringify({
    head: 'a'.repeat(40), branch: 'creator/saved', before, files: [], failPr, pr: false,
  }))
  return gh
}

async function readGithubCalls(transport: string): Promise<GithubCall[]> {
  return (await readFile(join(transport, 'calls.jsonl'), 'utf8')).split('\n')
    .filter(Boolean).map(line => JSON.parse(line) as GithubCall)
}

async function expectSelectedPublicationText(dialog: Locator, file: PublicationFile): Promise<void> {
  await dialog.getByRole('heading', { name: file.path, exact: true }).waitFor()
  await expect.poll(() => dialog.locator('pre').allTextContents()).toEqual(file.before === null ? [file.after] : [file.before, file.after])
}

async function showPublicationEscapedText(dialog: Locator, side: 'Before' | 'After', content: string): Promise<string> {
  const button = dialog.getByRole('button', { name: `${side}: exact text with escaped line endings`, exact: true })
  expect(await button.getAttribute('aria-expanded')).toBe('false')
  const controlledId = await button.getAttribute('aria-controls')
  if (controlledId === null) throw new Error('The escaped source control has no controlled element')
  expect(await dialog.evaluate((element, id) => element.ownerDocument.getElementById(id)?.textContent, controlledId)).toBe('')
  await button.click()
  expect(await button.getAttribute('aria-expanded')).toBe('true')
  const escaped = await dialog.evaluate((element, id) => element.ownerDocument.getElementById(id)?.textContent, controlledId)
  expect(escaped).toBe(JSON.stringify(content))
  return controlledId
}

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
    const gh = await preparePublicationGithub(transport, ORIGINAL_SOURCE.slice(0, -1), true)
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
    const calls = (): Promise<GithubCall[]> => readGithubCalls(transport)
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
    expect(captured.base).toBe('main')
    expect(await dialog.getByText('alice/harness:main', { exact: true }).count()).toBe(1)
    const sourcePath = PUBLISH_SOURCE_PATH
    expect(captured.files.find(file => file.path === sourcePath)).toEqual({
      path: sourcePath, before: ORIGINAL_SOURCE.slice(0, -1), after: ORIGINAL_SOURCE,
    })
    const files = dialog.getByRole('listbox', { name: 'Files', exact: true })
    await files.waitFor()
    expect(await files.inputValue()).toBe('')
    expect(await dialog.locator('pre').count()).toBe(0)
    expect(await dialog.textContent()).not.toContain(ORIGINAL_SOURCE)
    expect(await dialog.textContent()).not.toContain(JSON.stringify(ORIGINAL_SOURCE))
    for (const path of [sourcePath, 'creator-exports/saved/profiles/saved/cordis.patch.yml', 'creator-exports/saved/.gitignore']) {
      const selected = captured.files.find(file => file.path === path)
      if (selected === undefined) throw new Error('The publication fixture is missing a reviewed file')
      await files.selectOption(path)
      await expectSelectedPublicationText(dialog, selected)
      if (selected.before !== null) await showPublicationEscapedText(dialog, 'Before', selected.before)
      await showPublicationEscapedText(dialog, 'After', selected.after)
      expect(await dialog.locator('pre').allTextContents()).toEqual(selected.before === null
        ? [selected.after, JSON.stringify(selected.after)]
        : [selected.before, JSON.stringify(selected.before), selected.after, JSON.stringify(selected.after)])
    }
    const selectedSource = captured.files.find(file => file.path === sourcePath)
    if (selectedSource === undefined || selectedSource.before === null) throw new Error('The source fixture is missing its Before text')
    await files.selectOption(sourcePath)
    await expectSelectedPublicationText(dialog, selectedSource)
    await showPublicationEscapedText(dialog, 'Before', selectedSource.before)
    await showPublicationEscapedText(dialog, 'After', selectedSource.after)
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
    await dialog.getByText('The commit was saved, but the pull request could not be confirmed. Resolve the reported problem before retrying this same save.', { exact: true }).waitFor()
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

it.each([
  { name: 'Chromium', engine: chromium },
  { name: 'WebKit', engine: webkit },
])('$name reviews a real 2000-file Creator preview with bounded file choices and explicit text disclosure', async ({ engine }) => {
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-source-publish-large-web-'))
  const source = join(fixture, 'bundle')
  const transport = join(fixture, 'github')
  const evidence = await mkdtemp(join(tmpdir(), 'dsh-source-publish-large-evidence-'))
  const before = '\uFEFF// 初始😀\r\n\t// cafe\u0301'
  const after = '\uFEFF// 新的😀\r\n\t// cafe\u0301\nexport const greeting = "尾部";\r\n'
  const longRelativePath = 'extensions/review-panel/custom-configuration/long-source-destination/仕様-😀-cafe\u0301.txt'
  const longPath = `creator-exports/saved/bundles/0/${longRelativePath}`
  const longContent = '\uFEFFLong-path fixture 🧭\r\n\t日本語 and cafe\u0301\n'
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    await mkdir(source)
    await mkdir(transport)
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: '@fixture/creator-source-publish-large', version: '1.0.0', type: 'module', dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }) + '\n')
    await writeFile(join(source, 'cordis.patch.yml'), '[]\n')
    await writeFile(join(source, 'index.ts'), after)
    await mkdir(dirname(join(source, longRelativePath)), { recursive: true })
    await writeFile(join(source, longRelativePath), longContent)
    const samples = join(source, 'samples')
    await mkdir(samples)
    // The scaffold's defaults bundle contributes three of the eleven baseline capture files.
    const sampleFiles = Array.from({ length: 1988 }, (_, index) => ({
      name: `file-${String(index).padStart(4, '0')}.txt`, content: `Public source fixture ${String(index).padStart(4, '0')}\n`,
    }))
    for (let start = 0; start < sampleFiles.length; start += 32) {
      await Promise.all(sampleFiles.slice(start, start + 32).map(file => writeFile(join(samples, file.name), file.content)))
    }
    const gh = await preparePublicationGithub(transport, before, false)
    const overlay = join(fixture, 'fork.patch.yml')
    await writeFile(overlay, `- id: plugin-manager\n  config: ${JSON.stringify({ fork: { ghCommand: gh, timeoutMs: 60_000 } })}\n`)
    scaffold = await launchWebScaffold({
      extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
      profile: { packages: [{ dir: source, enabled: true }] }, agentPresets: { default: 'standard' },
    })
    browser = await engine.launch()
    const page = await newEnglishPage(browser)
    await page.context().route('https://github.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Fixture pull request</title>' }))
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, `web-e2e-creator-source-publish-large-${engine.name()}`))
    const apiCalls: string[] = []
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/api/creatorFork/')) apiCalls.push(path)
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
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
    expect(await readGithubCalls(transport)).toEqual([])
    await dialog.getByRole('button', { name: 'Load my GitHub forks', exact: true }).click()
    const repository = dialog.getByRole('combobox', { name: 'Fork repository', exact: true })
    await repository.selectOption('alice/harness')
    const branch = dialog.getByRole('textbox', { name: 'Branch', exact: true })
    await branch.fill('creator/saved')
    const responsePromise = page.waitForResponse('**/api/creatorFork/preview')
    await dialog.getByRole('button', { name: 'Preview changes', exact: true }).click()
    const envelope = await (await responsePromise).json() as { result: { ok: boolean; value: ForkPreviewResult } }
    expect(envelope.result.ok).toBe(true)
    const captured = envelope.result.value
    if (captured.status !== 'ready') throw new Error(`Large publication preview was blocked: ${captured.code}`)
    expect(captured.files).toHaveLength(2000)
    expect(Buffer.byteLength(JSON.stringify(captured))).toBeLessThan(10 * 1024 * 1024)
    expect(captured.files.every(file => Buffer.byteLength(file.after) <= 1024 * 1024)).toBe(true)
    const unicodeFile = captured.files.find(file => file.path === PUBLISH_SOURCE_PATH)
    if (unicodeFile === undefined) throw new Error('The Unicode source is absent from the real publication preview')
    expect(unicodeFile).toEqual({ path: PUBLISH_SOURCE_PATH, before, after })
    const longFile = captured.files.find(file => file.path === longPath)
    if (longFile === undefined) throw new Error('The long-path source is absent from the real publication preview')
    expect(longFile).toEqual({ path: longPath, before: null, after: longContent })
    const capturedCalls = await readGithubCalls(transport)
    const capturedApiCalls = [...apiCalls]
    expect(capturedCalls.filter(call => call.path.includes('/git/blobs/'))).toHaveLength(1)
    await writeFile(join(source, 'index.ts'), '// Edited locally after the retained preview\n')

    const files = dialog.getByRole('listbox', { name: 'Files', exact: true })
    await files.waitFor()
    const search = dialog.getByRole('searchbox', { name: 'Search files', exact: true })
    const previous = dialog.getByRole('button', { name: 'Previous files', exact: true })
    const next = dialog.getByRole('button', { name: 'Next files', exact: true })
    const acknowledgement = dialog.getByRole('checkbox', { name: 'I checked every file for private information and authorize this commit and pull request', exact: true })
    const confirm = dialog.getByRole('button', { name: 'Confirm commit and open PR', exact: true })
    const fileValues = (): Promise<string[]> => files.locator('option').evaluateAll(options => options
      .map(option => option.getAttribute('value') ?? '').filter(value => value !== ''))
    expect(await files.evaluate(element => element.tagName)).toBe('SELECT')
    expect(await files.getAttribute('size')).toBe('8')
    expect(await files.locator('option').count()).toBeLessThanOrEqual(51)
    expect(await fileValues()).toEqual(captured.files.slice(0, 50).map(file => file.path))
    expect(await dialog.getByText('Matching files: 2000', { exact: true }).count()).toBe(1)
    expect(await files.inputValue()).toBe('')
    expect(await files.getByRole('option', { name: 'Choose a file', exact: true }).isEnabled()).toBe(true)
    expect(await dialog.locator('pre').count()).toBe(0)
    expect(await dialog.textContent()).not.toContain(after)
    expect(await dialog.textContent()).not.toContain(JSON.stringify(after))
    expect(await acknowledgement.isChecked()).toBe(false)
    expect(await confirm.isEnabled()).toBe(false)
    await files.focus()
    expect(await files.inputValue()).toBe('')
    expect(await dialog.locator('pre').count()).toBe(0)
    const first = captured.files[0]
    const firstPageLast = captured.files[49]
    const last = captured.files.at(-1)
    if (first === undefined || firstPageLast === undefined || last === undefined) throw new Error('The large preview has incomplete page endpoints')
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => files.inputValue()).toBe(first.path)
    await expectSelectedPublicationText(dialog, first)
    await page.keyboard.press('End')
    await expect.poll(() => files.inputValue()).toBe(firstPageLast.path)
    await expectSelectedPublicationText(dialog, firstPageLast)
    await page.keyboard.press('Home')
    await expect.poll(() => files.inputValue()).toBe('')
    expect(await dialog.locator('pre').count()).toBe(0)
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => files.inputValue()).toBe(first.path)
    await expectSelectedPublicationText(dialog, first)
    for (let pageIndex = 1; pageIndex < Math.ceil(captured.files.length / 50); pageIndex++) {
      await next.click()
      expect(await files.inputValue()).toBe('')
      expect(await dialog.locator('pre').count()).toBe(0)
      expect(await files.locator('option').count()).toBeLessThanOrEqual(51)
      expect(await fileValues()).toEqual(captured.files.slice(pageIndex * 50, (pageIndex + 1) * 50).map(file => file.path))
    }
    expect(await next.isEnabled()).toBe(false)
    expect(await previous.isEnabled()).toBe(true)
    await files.selectOption(last.path)
    await expectSelectedPublicationText(dialog, last)
    const lastDisclosure = await showPublicationEscapedText(dialog, 'After', last.after)
    await previous.click()
    expect(await files.inputValue()).toBe('')
    expect(await dialog.locator('pre').count()).toBe(0)
    expect(await dialog.evaluate((element, id) => element.ownerDocument.getElementById(id) === null, lastDisclosure)).toBe(true)

    await search.fill('INDEX.TS')
    expect(await fileValues()).toEqual([PUBLISH_SOURCE_PATH])
    expect(await previous.isEnabled()).toBe(false)
    expect(await next.isEnabled()).toBe(false)
    await files.focus()
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => files.inputValue()).toBe(PUBLISH_SOURCE_PATH)
    await expectSelectedPublicationText(dialog, unicodeFile)
    const beforeDisclosure = await showPublicationEscapedText(dialog, 'Before', before)
    expect(await dialog.locator('pre').allTextContents()).toEqual([before, JSON.stringify(before), after])
    const afterDisclosure = await showPublicationEscapedText(dialog, 'After', after)
    expect(await dialog.locator('pre').allTextContents()).toEqual([before, JSON.stringify(before), after, JSON.stringify(after)])
    await search.fill('no-such-source-file')
    expect(await fileValues()).toEqual([])
    expect(await files.locator('option').count()).toBe(1)
    expect(await files.inputValue()).toBe('')
    expect(await dialog.locator('pre').count()).toBe(0)
    expect(await dialog.getByText('Matching files: 0', { exact: true }).count()).toBe(1)
    await dialog.getByRole('status').filter({ hasText: /no .*files|no .*matches|no .*results/i }).waitFor()
    expect(await previous.isEnabled()).toBe(false)
    expect(await next.isEnabled()).toBe(false)
    for (const id of [beforeDisclosure, afterDisclosure]) {
      expect(await dialog.evaluate((element, controlledId) => element.ownerDocument.getElementById(controlledId) === null, id)).toBe(true)
    }
    await search.fill('')
    expect(await fileValues()).toEqual(captured.files.slice(0, 50).map(file => file.path))
    expect(await previous.isEnabled()).toBe(false)
    expect(await next.isEnabled()).toBe(true)
    expect(await files.inputValue()).toBe('')
    expect(await dialog.locator('pre').count()).toBe(0)
    await search.fill('仕様-😀')
    expect(await fileValues()).toEqual([longPath])
    await files.selectOption(longPath)
    await expectSelectedPublicationText(dialog, longFile)
    expect(await dialog.getByRole('region', { name: 'Before', exact: true }).locator('pre').count()).toBe(0)
    expect(await dialog.getByRole('button', { name: 'Before: exact text with escaped line endings', exact: true }).count()).toBe(0)
    const longDisclosure = await showPublicationEscapedText(dialog, 'After', longContent)
    await dialog.getByRole('button', { name: 'After: exact text with escaped line endings', exact: true }).click()
    expect(await dialog.evaluate((element, id) => element.ownerDocument.getElementById(id)?.textContent, longDisclosure)).toBe('')
    await expectSelectedPublicationText(dialog, longFile)

    const selectedTitle = dialog.getByRole('heading', { name: longPath, exact: true })
    const assertFits = async (): Promise<void> => {
      await page.evaluate(() => document.fonts.ready)
      await selectedTitle.scrollIntoViewIfNeeded()
      expect(await dialog.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight
          && document.documentElement.scrollWidth <= innerWidth
          && [...element.querySelectorAll('button, input, select')].every((control) => {
            const rect = control.getBoundingClientRect()
            return rect.left >= bounds.left && rect.right <= bounds.right
          })
      })).toBe(true)
      expect(await selectedTitle.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      expect(await confirm.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight
      })).toBe(true)
    }
    await assertFits()
    await page.screenshot({ path: join(evidence, 'desktop-light.png') })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await assertFits()
    await page.screenshot({ path: join(evidence, 'desktop-dark.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await assertFits()
    await page.screenshot({ path: join(evidence, 'mobile-dark.png') })
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(false)
    await assertFits()
    await page.screenshot({ path: join(evidence, 'mobile-light.png') })
    expect(await acknowledgement.isChecked()).toBe(false)
    expect(await confirm.isEnabled()).toBe(false)
    await acknowledgement.check()
    expect(await confirm.isEnabled()).toBe(true)
    await search.fill('')
    expect(await files.inputValue()).toBe('')
    expect(await dialog.locator('pre').count()).toBe(0)
    await next.click()
    expect(await acknowledgement.isChecked()).toBe(true)
    expect(await confirm.isEnabled()).toBe(true)
    expect(await readGithubCalls(transport)).toEqual(capturedCalls)
    expect(apiCalls).toEqual(capturedApiCalls)
    expect(apiCalls.filter(path => path.endsWith('/publish'))).toEqual([])
    expect((await readGithubCalls(transport)).filter(call => call.method !== 'GET')).toEqual([])
    await branch.fill('creator/changed-target')
    expect(await dialog.getByRole('listbox', { name: 'Files', exact: true }).count()).toBe(0)
    expect(await dialog.locator('pre').count()).toBe(0)
    expect(await acknowledgement.count()).toBe(0)
    expect(await confirm.count()).toBe(0)
    expect(apiCalls).toEqual(capturedApiCalls)
    expect(scaffold.ctx.agentPresets.defaultId).toBe('standard')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    await browser?.close()
    await scaffold?.close()
    await rm(fixture, { recursive: true, force: true })
  }
})
