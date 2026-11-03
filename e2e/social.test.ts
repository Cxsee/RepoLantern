// La zona Social con dati già salvati: non chiama né Claude né Metricool.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { _electron as electron } from 'playwright-core'

process.env.HUB_SECONDO_SCHERMO = '1'
import { mainCheckout } from '../src/main/repos.ts'

const punto = (t: string, viste: number) => ({ t, viste, like: 3, commenti: 1, condivisioni: 0 })

test('mostra i numeri per social, il delta e cambia intervallo', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-e2e-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const path = await mainCheckout(repo)
  const userData = mkdtempSync(join(tmpdir(), 'hub-data-'))
  writeFileSync(join(userData, 'repos.json'), JSON.stringify({ repos: [path], attiva: path }))
  mkdirSync(join(path, '.hub'))
  writeFileSync(join(path, '.hub', 'social.json'), JSON.stringify({ avd: 'Telefono_Prova', istruzioni: 'Proposta della repo' }))
  const now = new Date().toISOString()
  writeFileSync(join(userData, 'social.json'), JSON.stringify({
    ogniOre: 6, brand: '1', tentativo: now, aggiornato: now, errore: null,
    video: [
      { social: 'tiktok', url: 'https://www.tiktok.com/@s/video/1', testo: 'Video su TikTok', pubblicato: 1, punti: [punto(now, 100), punto(now, 150)] },
      { social: 'instagram', url: 'https://www.instagram.com/reel/2', testo: 'Reel su Instagram', pubblicato: 1, punti: [punto(now, 7)] }
    ]
  }))

  const app = await electron.launch({ args: [resolve('.'), '--lang=it', `--user-data-dir=${userData}`] })
  const page = await app.firstWindow()
  assert.equal(await page.getByRole('button', { name: /^Social/ }).count(), 0, 'senza modulo la sezione non c\'è')
  await page.getByRole('button', { name: 'Attiva Social' }).click()
  await page.getByText('Ci sono numeri già salvati').waitFor()
  // La proposta della repo si vede prima di confermare.
  await page.locator('input[value="Telefono_Prova"]').waitFor()
  assert.equal(await page.getByLabel('Istruzioni per la sessione guidata').inputValue(), 'Proposta della repo')
  await page.getByLabel('Istruzioni per la sessione guidata').fill('password: abc')
  await page.getByRole('button', { name: 'Attiva', exact: true }).click()
  await page.getByRole('alert').waitFor()
  await page.getByLabel('Istruzioni per la sessione guidata').fill('Parti da TikTok')
  await page.getByRole('button', { name: 'Attiva', exact: true }).click()
  await page.getByRole('link', { name: 'Video su TikTok' }).waitFor()
  await page.getByText('+50').waitFor()
  assert.equal(await page.getByRole('link', { name: 'Reel su Instagram' }).count(), 0)

  await page.getByRole('button', { name: 'Instagram' }).click()
  await page.getByRole('link', { name: 'Reel su Instagram' }).waitFor()

  await page.getByLabel('Ogni').selectOption('12')
  await page.getByRole('button', { name: /^To do/ }).click()
  await page.getByRole('button', { name: /^Social/ }).click()
  assert.equal(await page.getByLabel('Ogni').inputValue(), '12')

  // Togliere il modulo non rompe nulla e non cancella i dati.
  await page.getByRole('button', { name: 'Togli da questa repo' }).click()
  await page.getByRole('button', { name: 'Attiva Social' }).waitFor()
  assert.equal(await page.getByRole('button', { name: /^Social/ }).count(), 0)
  for (const sezione of [/^Stato/, /^Branch/, /^Claude/, /^To do/]) await page.getByRole('button', { name: sezione }).click()
  await page.getByRole('button', { name: 'Attiva Social' }).click()
  assert.equal(await page.getByLabel('Istruzioni per la sessione guidata').inputValue(), 'Parti da TikTok')
  await page.getByRole('button', { name: 'Attiva', exact: true }).click()
  await page.getByRole('link', { name: 'Video su TikTok' }).waitFor()
  assert.equal(await page.getByLabel('Ogni').inputValue(), '12')
  await app.close()

  // Ogni repo ricorda la sezione in cui eri.
  const riaperta = await electron.launch({ args: [resolve('.'), '--lang=it', `--user-data-dir=${userData}`] })
  const pagina = await riaperta.firstWindow()
  await pagina.getByRole('link', { name: 'Video su TikTok' }).waitFor()
  await riaperta.close()
})

test('senza collegamento chiede di collegare Metricool', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-e2e-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(join(repo, '.hub'))
  writeFileSync(join(repo, '.hub', 'social.json'), JSON.stringify({ avd: 'Telefono_Prova', istruzioni: 'Proposta' }))
  const path = await mainCheckout(repo)
  const userData = mkdtempSync(join(tmpdir(), 'hub-data-'))
  writeFileSync(join(userData, 'repos.json'), JSON.stringify({ repos: [path], attiva: path }))
  const app = await electron.launch({ args: [resolve('.'), '--lang=it', `--user-data-dir=${userData}`] })
  const page = await app.firstWindow()
  await page.getByRole('button', { name: 'Attiva Social' }).click()
  await page.getByRole('button', { name: 'Attiva', exact: true }).click()
  await page.getByRole('button', { name: 'Collega Metricool' }).waitFor()
  await page.getByRole('button', { name: 'Avvia sessione guidata' }).waitFor()
  await app.close()
})
