// Il percorso per chi è nuovo si chiude e resta chiuso; il report diagnostico non contiene percorsi.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { _electron as electron } from 'playwright-core'
import { mainCheckout } from '../src/main/repos.ts'

test('da dove iniziare porta alle sezioni e si chiude; il report non rivela percorsi', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-e2e-'))
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: repo })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.js'), 'x\n')
  git('add', '.')
  git('commit', '-qm', 'uno')
  const path = await mainCheckout(repo)
  const userData = mkdtempSync(join(tmpdir(), 'hub-data-'))
  writeFileSync(join(userData, 'repos.json'), JSON.stringify({ repos: [path], attiva: path }))
  const lancia = () => electron.launch({ args: [resolve('.'), '--lang=en', `--user-data-dir=${userData}`] })
  let app = await lancia()
  try {
    const page = await app.firstWindow()
    await page.getByText('New to this project? Start here').waitFor()
    await page.getByRole('button', { name: 'See how to run it and what you need' }).click()
    await page.getByRole('heading', { name: 'How to run it', level: 1 }).waitFor()
    await page.getByRole('button', { name: /^Home/ }).click()
    await page.getByRole('button', { name: 'Before you merge, review your changes' }).click()
    await page.getByRole('heading', { name: 'Review', level: 1 }).waitFor()
    await page.getByRole('button', { name: /^Home/ }).click()
    await page.getByRole('button', { name: 'Got it' }).click()
    assert.equal(await page.getByText('New to this project? Start here').count(), 0)

    const report = await page.evaluate(() => window.hub.diagnostic())
    assert.match(report, /RepoLantern diagnostic report/)
    assert.match(report, /Repositories added: 1/)
    assert.ok(!report.includes(path) && !report.includes(process.env.USERPROFILE ?? 'NESSUNO'), report)
    await app.close()

    app = await lancia()
    const riaperta = await app.firstWindow()
    await riaperta.getByRole('button', { name: /^Home/ }).click()
    await riaperta.getByRole('heading', { name: 'Home', level: 1 }).waitFor()
    assert.equal(await riaperta.getByText('New to this project? Start here').count(), 0, 'resta chiuso')
  } finally {
    await app.close()
  }
})
