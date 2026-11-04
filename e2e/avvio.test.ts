// Prova di avvio del programma vero: parte da build già fatta (npm run build).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { _electron as electron } from 'playwright-core'

process.env.HUB_SECONDO_SCHERMO = '1'
import { mainCheckout } from '../src/main/repos.ts'

const open = (userData: string) => electron.launch({ args: [resolve('.'), '--lang=it', `--user-data-dir=${userData}`] })

test('una voce aggiunta resta dopo il riavvio e le voci dei .md compaiono', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-e2e-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  writeFileSync(join(repo, 'note.md'), '- [ ] voce nel documento\n')
  const path = await mainCheckout(repo)
  const userData = mkdtempSync(join(tmpdir(), 'hub-data-'))
  writeFileSync(join(userData, 'repos.json'), JSON.stringify({ repos: [path], attiva: path }))

  let app = await open(userData)
  let page = await app.firstWindow()
  await page.getByRole('heading', { name: 'Home' }).waitFor()
  await page.getByRole('button', { name: /^To do/ }).click()
  await page.getByLabel('Nuova voce').fill('prima voce')
  await page.getByRole('button', { name: 'Aggiungi', exact: true }).click()
  await page.getByText('prima voce').waitFor()
  await page.getByText('note.md').waitFor()
  assert.equal(await page.getByRole('button', { name: /^Social/ }).count(), 0)
  // Senza una configurazione o dati già salvati, Social non si propone.
  assert.equal(await page.getByRole('button', { name: 'Attiva Social' }).count(), 0)
  await page.getByRole('button', { name: /^Stato/ }).click()
  await page.getByRole('heading', { name: /Sessioni/ }).waitFor()
  await page.getByRole('button', { name: /^To do/ }).click()
  await app.close()

  // Una modifica esterna, come quelle di Claude, deve comparire da sola.
  app = await open(userData)
  page = await app.firstWindow()
  await page.getByText('prima voce').waitFor()
  const file = join(path, '.hub', 'todo.json')
  const todos = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify([...todos, { id: 'x', testo: 'scritta da fuori', fatta: false, creata: '2026-11-02' }]))
  await page.getByText('scritta da fuori').waitFor({ timeout: 8000 })
  await page.getByRole('button', { name: 'Elimina' }).first().click()
  await page.getByRole('button', { name: 'Annulla' }).click()
  await page.getByText('prima voce').waitFor()
  // Lo schermo si aggiorna prima del file: si aspetta la scrittura, senza contare sul tempo.
  for (let i = 0; i < 50 && JSON.parse(readFileSync(file, 'utf8')).length !== 2; i++) await page.waitForTimeout(100)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 2)

  // Un cambio di branch deve comparire prima dell'aggiornamento periodico da 10 secondi.
  await page.getByRole('button', { name: /^Branch/ }).click()
  await page.getByLabel('Cerca branch, worktree e commit').waitFor()
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'uno'], { cwd: repo })
  execFileSync('git', ['checkout', '-q', '-b', 'prova-live'], { cwd: repo })
  await page.locator('.rail').getByText('prova-live').first().waitFor({ timeout: 5000 })
  await app.close()
})
