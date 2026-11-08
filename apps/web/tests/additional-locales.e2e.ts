/** Shipped language selection, metadata and narrow settings through the assembled Web profile. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const languages = [
  ['es', 'es-MX', 'Menú de cuenta', 'Configuración', 'Complementos', 'Idioma', 'Español'],
  ['fr', 'fr-CA', 'Menu du compte', 'Paramètres', 'Plugins', 'Langue', 'Français'],
  ['de', 'de-DE', 'Kontomenü', 'Einstellungen', 'Plugins', 'Sprache', 'Deutsch'],
  ['ru', 'ru-RU', 'Меню аккаунта', 'Настройки', 'Плагины', 'Язык', 'Русский'],
  ['pt', 'pt-BR', 'Menu da conta', 'Configurações', 'Plug-ins', 'Idioma', 'Português'],
] as const

async function selectLanguage(page: Page, choice: Locator, preference: string): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => {
      if (candidate.request().method() !== 'POST'
        || new URL(candidate.url()).pathname !== '/api/settings/mutate') return false
      const { payload: { args } } = candidate.request().postDataJSON() as {
        payload: { args: { ns: string; ops: { op: string; path: string[]; value?: unknown }[] } }
      }
      return args.ns === 'locale' && args.ops.some(op => op.op === 'set'
        && op.path.length === 1 && op.path[0] === 'preference' && op.value === preference)
    }),
    choice.click(),
  ])
  expect(response.ok()).toBe(true)
  const outcome: unknown = await response.json()
  expect(outcome).toMatchObject({
    result: { ok: true, value: { ns: 'locale', value: { preference } } },
  })
}

it.each(languages)('selects %s from the browser, localizes metadata and persists an explicit choice', async (id, tag, accountMenu, settings, plugins, language, label) => {
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally { await resources.scaffold?.close() }
  })
  const scaffold = await launchWebScaffold()
  resources.scaffold = scaffold
  const browser = await chromium.launch()
  resources.browser = browser
  const page = await browser.newPage({ locale: tag, viewport: { width: 1440, height: 960 } })
  const tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, `additional-locale-${id}`))
  await page.goto(scaffold.authenticatedUrl)
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(id)
  await page.getByRole('button', { name: plugins, exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  const metadata = JSON.parse(await readFile(new URL(`../../../packages/experimental/auto-review/locale/${id}.json`, import.meta.url), 'utf8')) as { meta: { title: string; description: string } }
  await panel.getByText(metadata.meta.title, { exact: true }).waitFor()
  await panel.getByText(metadata.meta.description, { exact: true }).waitFor()
  await compareOrRefreshGolden(fileURLToPath(new URL(`./expected/additional-locales/${id}.expected.md`, import.meta.url)),
    await captureStableAria(page, `[data-plugin-panel] li:has-text(${JSON.stringify(metadata.meta.title)})`, scaffold.workspaceCwd), webSnapshotMode())
  await page.getByRole('button', { name: accountMenu, exact: true }).click()
  await page.getByRole('menuitem', { name: settings, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: settings, exact: true })
  await dialog.getByText(language, { exact: true }).waitFor()
  await dialog.getByRole('button', { name: label, exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => dialog.evaluate((element) => {
    const content = element.lastElementChild!
    return { panel: element.scrollWidth <= element.clientWidth + 1, content: content.scrollWidth <= content.clientWidth + 1 }
  })).toEqual({ panel: true, content: true })
  await dialog.getByRole('button', { name: label, exact: true }).click()
  await selectLanguage(page, page.getByRole('menuitem', { name: label, exact: true }), id)
  await expect.poll(() => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')).toContain(`preference: ${id}`)
  await dialog.getByRole('button', { name: label, exact: true }).click()
  await selectLanguage(page, page.getByRole('menuitem', { name: 'English', exact: true }), 'en')
  await expect.poll(() => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')).toContain('preference: en')
  const warningsBeforeReload = tripwire.warnings.length
  await page.reload()
  acknowledgeReloadConnectionLoss(tripwire, warningsBeforeReload)
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('en')
  expect(tripwire.warnings).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
})
