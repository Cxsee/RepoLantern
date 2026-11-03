// Lettura senza AI nel programma vero: archivio, ricerca e un commit fatto da fuori. Parte da build già fatta.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { _electron as electron } from 'playwright-core'

process.env.HUB_SECONDO_SCHERMO = '1'
import { mainCheckout } from '../src/main/repos.ts'

test('un commit fatto da fuori compare in meno di 2 secondi e si trova', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-lettura-'))
  const git = (...a: string[]): void => void execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=a@a', ...a], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'master')
  writeFileSync(join(repo, 'guida.md'), '# Guida al dossier\n\n- [ ] Una cosa da fare\n')
  writeFileSync(join(repo, 'package.json'), '{"dependencies":{"react":"19"}}')
  git('add', '.')
  git('commit', '-qm', 'Inizio')

  const path = await mainCheckout(repo)
  const userData = mkdtempSync(join(tmpdir(), 'hub-data-'))
  writeFileSync(join(userData, 'repos.json'), JSON.stringify({ repos: [path], attiva: path }))
  const app = await electron.launch({ args: [resolve('.'), '--lang=it', `--user-data-dir=${userData}`] })
  try {
    const page = await app.firstWindow()
    const riepilogo = await page.evaluate((r) => window.hub.archivio.apri(r), path)
    assert.deepEqual([riepilogo.file, riepilogo.commit, riepilogo.voci, riepilogo.profilo?.tipo, riepilogo.profilo?.framework], [2, 1, 1, 'web', ['React']])
    assert.ok(existsSync(join(userData, 'workspaces')))
    assert.equal(readdirSync(join(userData, 'workspaces')).length, 1)
    assert.ok(!existsSync(join(repo, '.hub')), 'la repo non viene sporcata')

    const cerca = (testo: string): Promise<{ oggetto: string; tipo: string }[]> => page.evaluate(([r, t]) => window.hub.archivio.cerca(r, t), [path, testo])
    assert.deepEqual((await cerca('dossier')).map((t) => t.oggetto), ['file:guida.md'])

    await page.evaluate((r) => {
      const stop = window.hub.archivio.onChange((quale) => {
        if (quale !== r) return
        stop()
        ;(window as any).__avvisato = true
      })
    }, path)
    const inizio = Date.now()
    git('commit', '-q', '--allow-empty', '-m', 'Commit fatto da fuori')
    let trovati: { tipo: string }[] = []
    while (!trovati.length && Date.now() - inizio < 5000) trovati = await cerca('fuori')
    const durata = Date.now() - inizio
    console.log('commit da fuori visibile in', durata, 'ms')
    assert.deepEqual(trovati.map((t) => t.tipo), ['commit'])
    assert.ok(durata < 2000, `${durata} ms`)
    await page.waitForFunction(() => (window as any).__avvisato === true, undefined, { timeout: 2000 })
  } finally {
    await app.close()
  }
})
