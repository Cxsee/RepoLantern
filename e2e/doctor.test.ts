// Come si avvia, nel programma vero: legge i file e non esegue nulla del progetto. Non usa Claude.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { _electron as electron } from 'playwright-core'

process.env.HUB_SECONDO_SCHERMO = '1'
import { mainCheckout } from '../src/main/repos.ts'

test('dice come si avvia un progetto, con le fonti, senza eseguirlo', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-doctor-'))
  const prova = join(repo, 'ESEGUITO.txt')
  const script = `node -e "require('fs').writeFileSync('ESEGUITO.txt','x')"`
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { dev: script, test: script, postinstall: script, prepare: script }, dependencies: { react: '1' } }, null, 2))
  writeFileSync(join(repo, 'package-lock.json'), '{}')
  writeFileSync(join(repo, '.env'), 'SEGRETO=valorenascosto\n')
  writeFileSync(join(repo, '.env.example'), 'API_KEY=valoredesempio\n')
  writeFileSync(join(repo, 'README.md'), '# Prova\n\n## Installation\n\nnpm ci\n')
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'jobs:\n  a:\n    steps:\n      - run: npm test\n')
  const path = await mainCheckout(repo)
  const userData = mkdtempSync(join(tmpdir(), 'hub-data-'))
  writeFileSync(join(userData, 'repos.json'), JSON.stringify({ repos: [path], attiva: path }))
  const app = await electron.launch({ args: [resolve('.'), '--lang=it', `--user-data-dir=${userData}`] })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: /^Come si avvia/ }).click()
    const zona = page.locator('.doctor')
    await zona.getByText('npm run dev').waitFor()
    const t = await zona.innerText()
    assert.match(t, /npm ci/)
    assert.match(t, /Ipotesi di RepoLantern/)
    assert.match(t, /Scritto nel progetto/)
    assert.match(t, /React/)
    assert.match(t, /API_KEY/)
    assert.match(t, /Installation/)
    assert.match(t, /integrazione continua/)
    assert.doesNotMatch(t, /valorenascosto|valoredesempio|SEGRETO/)
    assert.doesNotMatch(t, /postinstall/)
    await zona.getByRole('button', { name: /package\.json:\d+/ }).nth(1).click()
    await zona.locator('.file-riga.on').getByText('"dev"').waitFor()
    assert.equal(existsSync(prova), false)
  } finally {
    await app.close()
  }
  assert.equal(existsSync(prova), false)
})
