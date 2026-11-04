// La revisione senza AI: non spende senza conferma, dice cosa non ha guardato, e dal risultato si arriva al To do senza doppioni.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { _electron as electron } from 'playwright-core'
import { mainCheckout } from '../src/main/repos.ts'

test('controllo automatico, nessun lavoro senza conferma, e voce nel To do una volta sola', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-e2e-'))
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: repo })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.ts'), 'export const x = 1\n')
  git('add', '.')
  git('commit', '-qm', 'one')
  const path = await mainCheckout(repo)
  const userData = mkdtempSync(join(tmpdir(), 'hub-data-'))
  writeFileSync(join(userData, 'repos.json'), JSON.stringify({ repos: [path], attiva: path }))
  const app = await electron.launch({ args: [resolve('.'), '--lang=en', `--user-data-dir=${userData}`] })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: /^Review/ }).click()
    await page.getByRole('button', { name: 'Run the automatic check' }).click()
    await page.getByText('There are no changes to review.').waitFor()

    writeFileSync(join(repo, 'a.ts'), 'export const x = 1\ndb.query("select * from u where id=" + id)\nconst password = "correct-horse-battery"\n')
    writeFileSync(join(repo, 'id.pem'), 'chiave')
    await page.getByRole('button', { name: 'Run the automatic check' }).click()
    await page.getByText('Builds an SQL query by joining text').waitFor()
    const testo = await page.locator('.doctor').innerText()
    assert.doesNotMatch(testo, /correct-horse/, 'il valore di un segreto non si mostra')
    assert.match(testo, /Files not reviewed: 1 \(secret files: 1\)/)
    assert.match(testo, /doesn't mean|false alarms/)

    // Chiedere a Claude passa da una conferma: prima di confermare non parte nessun lavoro.
    await page.getByRole('button', { name: 'Review with Claude' }).click()
    await page.getByRole('button', { name: 'Not now' }).click()
    const lavori = await page.evaluate((p) => window.hub.lavori.elenco(p), path)
    assert.equal(lavori.length, 0)

    const voce = page.locator('.review-voce', { hasText: 'SQL query' })
    await voce.getByRole('button', { name: 'Add to To do' }).click()
    await voce.getByText('Added to To do.').waitFor()
    assert.match(readFileSync(join(repo, '.hub', 'todo.json'), 'utf8'), /a\.ts:2 \(RepoLantern review, /)
    await page.getByRole('button', { name: /^To do/ }).click()
    await page.getByRole('button', { name: /^Review/ }).click()
    await page.locator('.review-voce', { hasText: 'SQL query' }).getByRole('button', { name: 'Add to To do' }).click()
    await page.getByText('Already in To do.').waitFor()
    assert.equal(JSON.parse(readFileSync(join(repo, '.hub', 'todo.json'), 'utf8')).length, 1)
    assert.doesNotMatch(git('status', '--short').toString(), /\.hub/, 'il To do non finisce in git')
  } finally {
    await app.close()
  }
})
