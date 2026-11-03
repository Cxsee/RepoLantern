// Zona Branch nel programma vero: si naviga da worktree e branch fino alle righe cambiate. Parte da build già fatta.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { _electron as electron } from 'playwright-core'

process.env.HUB_SECONDO_SCHERMO = '1'
import { mainCheckout } from '../src/main/repos.ts'

test("l'albero mostra branch, commit e worktree e si percorre", async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-albero-'))
  const git = (...a: string[]): void => void execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=a@a', ...a], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'master')
  for (const n of ['Uno', 'Due', 'Tre']) git('commit', '-q', '--allow-empty', '-m', n)
  git('checkout', '-q', '-b', 'lavoro/nuovo', 'HEAD~1')
  git('commit', '-q', '--allow-empty', '-m', 'Sul ramo')
  git('checkout', '-q', 'master')
  const wt = join(mkdtempSync(join(tmpdir(), 'hub-wt-')), 'chioma')
  git('worktree', 'add', '-q', wt, 'lavoro/nuovo')

  const path = await mainCheckout(repo)
  const userData = mkdtempSync(join(tmpdir(), 'hub-data-'))
  writeFileSync(join(userData, 'repos.json'), JSON.stringify({ repos: [path], attiva: path }))
  const app = await electron.launch({ args: [resolve('.'), '--lang=it', `--user-data-dir=${userData}`] })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    // Senza movimento i clic non aspettano la fine della crescita.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: /^Branch/ }).click()
    const tree = page.locator('.tree')
    await tree.getByRole('button', { name: 'Branch lavoro/nuovo' }).waitFor()
    assert.equal(await page.locator('.arbor-leaf[data-hash]').count(), 4)
    assert.equal(await tree.getByRole('button', { name: /^Worktree/ }).count(), 2)
    await tree.getByText('Foglia chiara: un commit').waitFor()
    await page.waitForTimeout(1600)

    // Toccando il nome la camera vola sul ramo e si apre il pannello.
    const camera = (): Promise<string | null> => page.locator('.arbor-svg > g').getAttribute('transform')
    const inspector = page.locator('.inspector')
    const before = await camera()
    await tree.getByRole('button', { name: 'Branch lavoro/nuovo' }).click()
    await inspector.getByRole('heading', { name: 'lavoro/nuovo' }).waitFor()
    await page.waitForTimeout(1500)
    assert.notEqual(await camera(), before)
    assert.ok((await page.locator('.arbor-limb.dim').count()) > 0)

    // Una foglia è un commit; le frecce passano alle altre foglie del ramo.
    await page.getByRole('button', { name: "Tutto l'albero" }).click()
    await page.waitForTimeout(1200)
    await tree.getByRole('button', { name: 'Tre', exact: true }).click()
    await inspector.getByRole('heading', { name: 'Tre' }).waitFor()
    await tree.focus()
    await page.keyboard.press('ArrowDown')
    await inspector.getByRole('heading', { name: 'Due' }).waitFor()

    // La mela apre il worktree.
    await page.waitForTimeout(1400)
    await page.getByRole('button', { name: "Tutto l'albero" }).click()
    await page.waitForTimeout(1200)
    await tree.getByRole('button', { name: 'Worktree chioma' }).click()
    await inspector.getByText('Non salvate in un commit').waitFor()

    // Trascinare sposta la vista senza scegliere nulla.
    await page.waitForTimeout(1500)
    const moved = await camera()
    const area = (await tree.boundingBox())!
    await page.mouse.move(area.x + 30, area.y + area.height / 2)
    await page.mouse.down()
    await page.mouse.move(area.x + 120, area.y + area.height / 2 + 60, { steps: 5 })
    await page.mouse.up()
    assert.notEqual(await camera(), moved)
    await inspector.getByText('Non salvate in un commit').waitFor()
    assert.deepEqual(errors, [])
  } finally {
    await app.close()
  }
})

test('si scende da branch a commit, file e righe, e si torna indietro', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-branch-'))
  const git = (...a: string[]): void => void execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=a@a', '-c', 'core.autocrlf=false', ...a], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'master')
  writeFileSync(join(repo, 'a.txt'), 'uno\n')
  git('add', '.')
  git('commit', '-q', '-m', 'Primo commit')
  git('checkout', '-q', '-b', 'lavoro/nuovo')
  writeFileSync(join(repo, 'a.txt'), 'due\n')
  git('commit', '-qam', 'Cambia la riga')
  git('checkout', '-q', 'master')
  git('checkout', '-q', '-b', 'altro')
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  git('add', '.')
  git('commit', '-qm', 'Ramo laterale')
  git('checkout', '-q', 'master')
  const wt = join(mkdtempSync(join(tmpdir(), 'hub-wt-')), 'albero')
  git('worktree', 'add', '-q', wt, 'lavoro/nuovo')
  writeFileSync(join(wt, 'nuovo.txt'), 'appena scritto\n')

  const path = await mainCheckout(repo)
  const userData = mkdtempSync(join(tmpdir(), 'hub-data-'))
  writeFileSync(join(userData, 'repos.json'), JSON.stringify({ repos: [path], attiva: path }))
  const app = await electron.launch({ args: [resolve('.'), '--lang=it', `--user-data-dir=${userData}`] })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.getByRole('button', { name: /^Branch/ }).click()
    await page.getByRole('button', { name: 'Elenco' }).click()

    const graph = page.locator('.graph-rows')
    await graph.getByText('Ramo laterale').waitFor()
    assert.equal(await page.locator('.commit-row').count(), 3)
    assert.ok((await page.locator('.lane').count()) >= 2)

    // Branch: i rami non collegati si spengono.
    const rail = page.locator('.rail')
    await rail.getByRole('button', { name: /nuovo/ }).last().click()
    const inspector = page.locator('.inspector')
    await inspector.getByRole('heading', { name: 'lavoro/nuovo' }).waitFor()
    await page.locator('.commit-row.dim', { hasText: 'Ramo laterale' }).waitFor()
    assert.equal(await page.locator('.commit-row.dim', { hasText: 'Cambia la riga' }).count(), 0)

    // Da branch a commit, a file, alle righe numerate.
    await inspector.locator('.mini-commits').getByRole('button', { name: /Cambia la riga/ }).click()
    await inspector.getByRole('heading', { name: 'Cambia la riga' }).waitFor()
    await inspector.getByRole('button', { name: /a\.txt/ }).click()
    await inspector.locator('.d-tolta .code', { hasText: 'uno' }).waitFor()
    assert.equal(await inspector.locator('.d-aggiunta .code').innerText(), 'due')

    // Il percorso porta indietro.
    await inspector.getByRole('button', { name: 'lavoro/nuovo' }).first().click()
    await inspector.getByRole('heading', { name: 'lavoro/nuovo' }).waitFor()

    // Le frecce scorrono i commit.
    await graph.getByRole('button', { name: /Primo commit/ }).click()
    await page.keyboard.press('ArrowUp')
    await inspector.locator('.insp-title').filter({ hasNotText: 'Primo commit' }).waitFor()

    // Esc torna indietro di un passo.
    await page.keyboard.press('Escape')
    await inspector.getByRole('heading', { name: 'lavoro/nuovo' }).waitFor()

    // Worktree: file nuovo non salvato.
    await rail.getByRole('button', { name: /albero/ }).click()
    await inspector.getByText('Non salvate in un commit').waitFor()
    await inspector.getByRole('button', { name: /nuovo\.txt/ }).click()
    await inspector.locator('.d-aggiunta .code', { hasText: 'appena scritto' }).waitFor()

    // La ricerca filtra elenco e grafo.
    await page.getByRole('button', { name: 'Repo', exact: true }).click()
    await page.getByLabel('Cerca branch, worktree e commit').fill('laterale')
    await page.locator('.commit-row.dim', { hasText: 'Primo commit' }).waitFor()
    await page.getByLabel('Cerca branch, worktree e commit').fill('altro')
    assert.equal(await rail.locator('.nav-item').count(), 1)
    await page.getByLabel('Cerca branch, worktree e commit').fill('')

    // Dal worktree si apre una chat lì, senza mandare messaggi.
    await rail.getByRole('button', { name: /albero/ }).click()
    await inspector.getByRole('button', { name: 'Chat con Claude qui' }).click()
    await page.getByRole('tab', { name: /lavoro\/nuovo/ }).waitFor()
    await page.getByLabel('Messaggio per Claude').waitFor()
    assert.deepEqual(errors, [])
  } finally {
    await app.close()
  }
})

test("nella vista Elenco un tratto dritto si raccoglie, si apre, e una ricerca lo trova", async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-storia-'))
  const git = (...a: string[]): void => void execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=a@a', ...a], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'master')
  for (const n of ['Radice', 'Secondo', 'Terzo', 'Quarto', 'Quinto', 'Testa']) git('commit', '-q', '--allow-empty', '-m', n)
  const path = await mainCheckout(repo)
  const userData = mkdtempSync(join(tmpdir(), 'hub-data-'))
  writeFileSync(join(userData, 'repos.json'), JSON.stringify({ repos: [path], attiva: path }))
  const app = await electron.launch({ args: [resolve('.'), '--lang=it', `--user-data-dir=${userData}`] })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: /^Branch/ }).click()
    await page.getByRole('button', { name: 'Elenco' }).click()
    await page.getByRole('button', { name: /Testa/ }).waitFor()
    await page.getByRole('button', { name: /Radice/ }).first().waitFor()
    const gruppo = page.locator('.commit-gruppo button')
    assert.match(await gruppo.innerText(), /4 commit/)
    assert.equal(await page.locator('.commit-row').count(), 3)

    await gruppo.click()
    await page.getByRole('button', { name: /Terzo/ }).waitFor()
    assert.equal(await page.locator('.commit-row').count(), 6)
    await page.getByRole('button', { name: 'Richiudi' }).click()
    await page.locator('.commit-gruppo').waitFor()

    // Cercando un commit dentro il gruppo, il gruppo si apre da solo.
    await page.getByLabel('Cerca branch, worktree e commit').fill('Terzo')
    await page.getByRole('button', { name: /Terzo/ }).waitFor()
    assert.equal(await page.locator('.commit-gruppo').count(), 0)
    await page.getByRole('button', { name: /Terzo/ }).click()
    await page.getByLabel('Cerca branch, worktree e commit').fill('')
    // Il commit scelto resta visibile anche a ricerca finita.
    assert.equal(await page.locator('.commit-row.on').count(), 1)
  } finally {
    await app.close()
  }
})
