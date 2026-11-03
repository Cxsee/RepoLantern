// La Home nel programma vero: cosa è cambiato e dove porta ogni voce. Non usa Claude.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { _electron as electron } from 'playwright-core'

process.env.HUB_SECONDO_SCHERMO = '1'
import { mainCheckout } from '../src/main/repos.ts'

test('la Home dice cosa è cambiato, senza allarmi, e ogni voce porta a destinazione', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-home-'))
  const git = (...a: string[]): void => void execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=a@a', ...a], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'master')
  writeFileSync(join(repo, 'a.txt'), 'a')
  git('add', '.')
  git('commit', '-qm', 'Primo commit')
  git('checkout', '-q', '-b', 'lavoro/nuovo')
  git('commit', '-q', '--allow-empty', '-m', 'Sul ramo')
  git('checkout', '-q', 'master')
  const path = await mainCheckout(repo)
  const userData = mkdtempSync(join(tmpdir(), 'hub-data-'))
  writeFileSync(join(userData, 'repos.json'), JSON.stringify({ repos: [path], attiva: path }))

  let app = await electron.launch({ args: [resolve('.'), '--lang=it', `--user-data-dir=${userData}`] })
  try {
    let page = await app.firstWindow()
    const home = page.locator('.home')
    await home.getByRole('heading', { name: 'Gli ultimi commit' }).waitFor()
    await home.getByRole('button', { name: /Primo commit/ }).waitFor()
    await home.getByRole('heading', { name: 'Niente in corso' }).waitFor()
    await home.getByRole('heading', { name: 'Branch con commit fuori dalla base' }).waitFor()
    assert.doesNotMatch(await home.innerText(), /abbandonat|urgent|rischio|attenzione|problem/i)

    // Il branch si apre direttamente, non solo la sezione.
    await home.getByRole('button', { name: /lavoro\/nuovo/ }).click()
    await page.getByRole('heading', { name: 'Branch', exact: true }).waitFor()
    await page.locator('.insp-crumbs').getByText('lavoro/nuovo').waitFor()

    // La destinazione vale una volta: tornando su Branch dal menu non si riapre da sola.
    await page.getByRole('button', { name: /^Stato/ }).click()
    await page.getByRole('button', { name: /^Branch/ }).click()
    await page.getByRole('heading', { name: 'Branch', exact: true }).waitFor()
    await page.locator('.nav-tools').waitFor()
    assert.equal(await page.locator('.insp-crumbs').count(), 0)

    await page.getByRole('button', { name: /^Home/ }).click()
    await home.getByRole('button', { name: /Apri la lista/ }).click()
    await page.getByLabel('Nuova voce').fill('Una cosa da fare')
    await page.getByRole('button', { name: 'Aggiungi', exact: true }).click()
    await page.getByText('Una cosa da fare').waitFor()

    // Una modifica in corso compare come fatto, e porta al suo worktree.
    writeFileSync(join(path, 'a.txt'), 'cambiato')
    await page.getByRole('button', { name: /^Home/ }).click()
    await home.getByRole('heading', { name: 'Da fare: 1' }).waitFor()
    await home.getByRole('button', { name: /Una cosa da fare/ }).waitFor()
    await home.getByRole('button', { name: /1 file non committato/ }).click()
    await page.locator('.insp-crumbs').waitFor()
    await page.getByRole('button', { name: /^Home/ }).click()
    await app.close()

    // Alla riapertura confronta con l'ultima visita.
    await new Promise((r) => setTimeout(r, 1100))
    git('commit', '-qam', 'Fatto da fuori')
    app = await electron.launch({ args: [resolve('.'), '--lang=it', `--user-data-dir=${userData}`] })
    page = await app.firstWindow()
    const dopo = page.locator('.home')
    await dopo.getByRole('heading', { name: 'Commit più recenti della tua ultima visita' }).waitFor()
    await dopo.getByRole('button', { name: /Fatto da fuori/ }).waitFor()
    assert.equal(await dopo.getByRole('button', { name: /Primo commit/ }).count(), 0)

    // Tornare sulla Home nella stessa sessione non azzera le novità.
    await page.getByRole('button', { name: /^To do/ }).click()
    await page.getByRole('button', { name: /^Home/ }).click()
    await dopo.getByRole('button', { name: /Fatto da fuori/ }).waitFor()
    await page.screenshot({ path: join(tmpdir(), 'hub-home.png') })
  } finally {
    await app.close()
  }
})
