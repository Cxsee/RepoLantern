// Ricerca e pannello nel programma vero: Ctrl+K, risultati, apertura della cosa giusta. Non usa Claude.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { _electron as electron } from 'playwright-core'

process.env.HUB_SECONDO_SCHERMO = '1'
import { Archivio, leggiVersione } from '../src/main/archivio.ts'
import { mainCheckout } from '../src/main/repos.ts'

test('Ctrl+K trova, spiega e apre la cosa giusta, senza intralciare chat e conferme', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-cerca-'))
  const git = (...a: string[]): void => void execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=a@a', '-c', 'core.autocrlf=false', ...a], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'master')
  writeFileSync(join(repo, 'dossier.dart'), 'void main() {}\n// TODO sistemare il dossier\n')
  writeFileSync(join(repo, 'guida.md'), '# Guida pirata\n\n- [ ] Scrivere la guida\n')
  writeFileSync(join(repo, '.env'), 'CHIAVE=finta\n')
  git('add', '.')
  git('commit', '-qm', 'Primo commit coccodrillo')
  git('checkout', '-q', '-b', 'lavoro/orso')
  git('commit', '-q', '--allow-empty', '-m', 'Sul ramo')
  git('checkout', '-q', 'master')

  const path = await mainCheckout(repo)
  const userData = mkdtempSync(join(tmpdir(), 'hub-data-'))
  writeFileSync(join(userData, 'repos.json'), JSON.stringify({ repos: [path], attiva: path }))
  const cartella = join(userData, 'workspaces', createHash('sha256').update(path).digest('hex').slice(0, 16))
  mkdirSync(cartella, { recursive: true })
  const db = new Archivio(join(cartella, 'hub.db'))
  db.salvaLivello(await leggiVersione(path), { titolo: 'Prodotto', aree: [{ nome: 'Area', spiega: 'S', funzioni: [{ nome: 'Funzione giraffa', spiega: 'Spiegazione di Claude', fonte: { testo: 'dossier.dart:1' } }] }] }, 'claude-prova', {})
  db.close()

  const app = await electron.launch({ args: [resolve('.'), '--lang=it', `--user-data-dir=${userData}`] })
  try {
    const page = await app.firstWindow()
    await page.locator('.home h2').first().waitFor()
    const dialogo = page.getByRole('dialog', { name: 'Cerca nel progetto' })
    const campo = page.getByLabel('Cerca file, commit, branch, funzioni e dentro il codice')

    // Pulsante visibile, oltre alla scorciatoia.
    await page.getByRole('button', { name: /^Cerca/ }).click()
    await campo.waitFor()
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('type')), 'search')
    await page.keyboard.press('Escape')
    assert.equal(await dialogo.count(), 0)

    // Chiudere la ricerca non lascia sullo schermo la sezione di prima.
    await page.getByRole('button', { name: /^Stato/ }).click()
    await page.getByRole('heading', { name: 'Stato', exact: true }).waitFor()
    assert.equal(await page.locator('.home').count(), 0)

    // Con la ricerca già aperta, Ctrl+K non ne apre una seconda né perde il testo.
    await page.keyboard.press('Control+k')
    await campo.fill('dossier')
    await page.keyboard.press('Control+k')
    assert.equal(await dialogo.count(), 1)
    assert.equal(await campo.inputValue(), 'dossier')

    // Risultato con tipo e percorso; pannello con dati certi, voci e collegamenti veri.
    await dialogo.getByRole('button', { name: /dossier\.dart/ }).waitFor()
    await dialogo.getByRole('button', { name: /dossier\.dart/ }).click()
    const pannello = dialogo.locator('.pannello')
    await pannello.getByText('Dato certo').waitFor()
    await pannello.getByText('sistemare il dossier').first().waitFor()
    await pannello.getByText('Nessun collegamento disponibile').waitFor()
    await pannello.getByText('void main()').waitFor()

    // La tastiera resta nel dialogo.
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), true)
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), true)
    await campo.focus()

    // L'anteprima dice da dove viene, anche se il file ha modifiche non committate.
    assert.match(await pannello.innerText(), /Prime righe nel commit/)

    // Si cerca anche dentro i file, e si legge il codice attorno alla riga trovata.
    await campo.fill('void main')
    const dentro = dialogo.getByRole('button', { name: /dossier\.dart:\d+/ })
    await dentro.waitFor()
    await dentro.click()
    await dialogo.locator('.file-riga.on').getByText('void main').waitFor()
    await dialogo.getByRole('button', { name: /Apri in VS Code a questa riga/ }).waitFor()
    await campo.fill('dossier')
    await dialogo.getByRole('button', { name: /dossier\.dart/ }).first().click()

    // Invio non apre i risultati della ricerca precedente.
    await campo.fill('giraffa')
    await page.keyboard.press('Enter')
    assert.equal(await dialogo.count(), 1)

    // Un segreto si trova per nome, ma il pannello non lo apre.
    await campo.fill('.env')
    await dialogo.getByRole('button', { name: /\.env/ }).click()
    await pannello.getByText('.env').first().waitFor()
    assert.ok(!(await pannello.innerText()).includes('CHIAVE'))

    // Una funzione è dedotta e lo dice; si apre al suo posto nell'anteprima.
    await campo.fill('giraffa')
    await dialogo.getByRole('button', { name: /Funzione giraffa/ }).click()
    await pannello.getByText('Dedotto', { exact: true }).waitFor()
    assert.match(await pannello.innerText(), /claude-prova/)
    await pannello.getByRole('button', { name: 'Apri nella Mappa' }).click()
    assert.equal(await dialogo.count(), 0)
    await page.locator('.ante-dettaglio').getByRole('heading', { name: 'Funzione giraffa' }).waitFor()

    // Un branch apre proprio quel branch.
    await page.keyboard.press('Control+k')
    await campo.fill('orso')
    await dialogo.getByRole('button', { name: /lavoro\/orso/ }).click()
    await pannello.getByRole('button', { name: 'Apri il branch' }).click()
    await page.locator('.insp-crumbs').getByText('lavoro/orso').waitFor()

    // Invio dalla casella apre il primo risultato: un commit.
    await page.keyboard.press('Control+k')
    await campo.fill('coccodrillo')
    await dialogo.getByRole('button', { name: /coccodrillo/ }).waitFor()
    await page.waitForTimeout(50)
    await page.keyboard.press('Enter')
    await dialogo.waitFor({ state: 'detached' })
    await page.locator('.insp-title', { hasText: 'coccodrillo' }).waitFor()

    // Un file nuovo si trova appena si riapre la ricerca.
    writeFileSync(join(path, 'nuovissimo.txt'), 'x')
    await page.keyboard.press('Control+k')
    await campo.fill('nuovissimo')
    await dialogo.getByRole('button', { name: /nuovissimo/ }).waitFor()
    await page.keyboard.press('Escape')

    // Nella chat con testo scritto: si apre la ricerca e il testo resta.
    await page.getByRole('button', { name: /^Claude/ }).click()
    await page.getByRole('button', { name: 'Inizia' }).click()
    const messaggio = page.getByLabel('Messaggio per Claude')
    await messaggio.fill('una frase a metà')
    await messaggio.focus()
    await page.keyboard.press('Control+k')
    await campo.waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await messaggio.inputValue(), 'una frase a metà')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Messaggio per Claude', 'la tastiera torna dov\'era')

    // Durante una richiesta di permesso la scorciatoia non ruba la tastiera.
    await page.evaluate(() => {
      const finta = document.createElement('div')
      finta.className = 'ask'
      finta.id = 'finta'
      document.body.append(finta)
    })
    await page.keyboard.press('Control+k')
    assert.equal(await dialogo.count(), 0)
    await page.evaluate(() => document.getElementById('finta')?.remove())
    await page.keyboard.press('Control+k')
    await campo.waitFor()
  } finally {
    await app.close()
  }
})
