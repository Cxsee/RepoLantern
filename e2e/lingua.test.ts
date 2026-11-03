// Su un sistema non italiano Hub parla inglese, ovunque; la scelta manuale resta dopo il riavvio.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { _electron as electron } from 'playwright-core'
import { mainCheckout } from '../src/main/repos.ts'

const ITALIANO = /\b(non|della|delle|sono|questo|questa|nessun\w*|aggiungi|aggiorna|cerca|voce|voci|apri|sto|cartella|modifiche|sessioni?|ramo)\b/i

test('inglese predefinito in ogni sezione, e la scelta dell\'italiano resta', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-e2e-'))
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: repo })
  git('init', '-q')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', test: 'vitest' } }))
  git('add', '.')
  git('commit', '-qm', 'first')
  const path = await mainCheckout(repo)
  const userData = mkdtempSync(join(tmpdir(), 'hub-data-'))
  writeFileSync(join(userData, 'repos.json'), JSON.stringify({ repos: [path], attiva: path }))

  const app = await electron.launch({ args: [resolve('.'), '--lang=en', `--user-data-dir=${userData}`] })
  const page = await app.firstWindow()
  await page.getByRole('button', { name: /^How to run it/ }).waitFor()
  for (const sezione of [/^Home/, /^How to run it/, /^To do/, /^Status/, /^Branches/, /^Claude/, /^Experimental map/]) {
    await page.getByRole('button', { name: sezione }).click()
    await page.waitForTimeout(400)
    const testo = await page.locator('body').innerText()
    assert.equal(ITALIANO.exec(testo)?.[0], undefined, `${sezione}: ${testo.slice(0, 400)}`)
  }
  await page.getByLabel('Language').selectOption('it')
  await page.getByRole('button', { name: /^Come si avvia/ }).waitFor()
  await app.close()

  const riaperta = await electron.launch({ args: [resolve('.'), '--lang=en', `--user-data-dir=${userData}`] })
  await (await riaperta.firstWindow()).getByRole('button', { name: /^Come si avvia/ }).waitFor()
  await riaperta.close()
})
