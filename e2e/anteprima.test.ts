// Anteprima della Mappa nel programma vero, con dati già nell'archivio: non chiama Claude e non consuma il piano.
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

test('mostra limiti, versione e citazioni, non spende senza conferma, e le segnalazioni restano', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-ante-'))
  const git = (...a: string[]): void => void execFileSync('git', ['-c', 'user.name=P', '-c', 'user.email=p@p', '-c', 'core.autocrlf=false', ...a], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.dart'), 'prima\nuno\n  salva()\ndue\ndopo\n')
  git('add', '.')
  git('commit', '-qm', 'Inizio')

  const path = await mainCheckout(repo)
  const userData = mkdtempSync(join(tmpdir(), 'hub-data-'))
  writeFileSync(join(userData, 'repos.json'), JSON.stringify({ repos: [path], attiva: path }))
  const cartella = join(userData, 'workspaces', createHash('sha256').update(path).digest('hex').slice(0, 16))
  mkdirSync(cartella, { recursive: true })
  const db = new Archivio(join(cartella, 'hub.db'))
  const versione = await leggiVersione(path)
  db.salvaLivello(versione, { titolo: 'Un prodotto di prova', aree: [{ nome: 'Area uno', spiega: 'Spiegazione area', funzioni: [{ nome: 'Salvare le note', spiega: 'Salva le note scritte', fonte: { testo: 'a.dart:3' } }, { nome: 'Senza prova', spiega: 'Citazione sbagliata', fonte: { testo: 'inventato.dart:1' } }] }] }, 'prova', { scoperte: ['lib/features/altro'], nonValidate: ['Senza prova'], documentiNonCoperti: [] }, new Set(['Senza prova']))
  const funzione = db.mappa().funzioni[0].id
  const flusso = {
    titolo: 'Salvataggio di una nota',
    nodi: [{ id: 'x', zona: 'z', kind: 'schermata', nome: 'La schermata', tec: 'a.dart' }, { id: 'y', zona: 'z', kind: 'dati', nome: 'Le note salvate', tec: 'a.dart' }],
    passi: [
      { da: 'x', a: 'y', tipo: 'dati', nome: 'Il telefono salva', spiega: 'Il telefono manda la nota', fonte: { certezza: 'verificato' as const }, ref: { f: 'a.dart', l: 3, s: 3, righe: ['  salva()'] } },
      { da: 'y', a: 'x', tipo: 'dati', nome: 'Citazione rotta', spiega: 'Questo brano non esiste', fonte: { certezza: 'verificato' as const }, ref: { f: 'a.dart', l: 9, s: 9, righe: ['non esiste'] }, rotto: true }
    ]
  }
  db.salvaFlusso(versione, { id: funzione, nome: 'Salvare le note', spiega: 'Salva le note scritte' }, flusso, 'prova')
  db.close()

  let app = await electron.launch({ args: [resolve('.'), '--lang=it', `--user-data-dir=${userData}`] })
  try {
    let page = await app.firstWindow()
    await page.getByRole('button', { name: /^Mappa sperimentale/ }).click()
    await page.getByRole('note').getByText('Anteprima sperimentale').waitFor()
    assert.match(await page.getByRole('note').innerText(), /1 era falso e 22 imprecisi/)
    await page.getByText('Un prodotto di prova').waitFor()
    assert.equal(await page.getByText('Potenzialmente superata').count(), 0)
    assert.equal(await page.locator('.ante-griglia .pill.bad').count(), 1, 'la funzione non validata si distingue')
    await page.getByText('lib/features/altro').waitFor()

    // Spendere chiede conferma con la stima, e rinunciare non fa partire nulla.
    await page.getByRole('button', { name: 'Ricava di nuovo la mappa' }).click()
    await page.getByText('circa 1 $ stimato e 10 minuti').waitFor()
    await page.getByText('È una stima, non una promessa').waitFor()
    await page.getByRole('button', { name: 'Non ora' }).click()
    assert.deepEqual(await page.evaluate((p) => window.hub.lavori.elenco(p), path), [])

    await page.getByRole('button', { name: 'Salvare le note' }).click()
    await page.getByRole('heading', { name: 'Salvataggio di una nota' }).waitFor()
    assert.match(await page.locator('.ante-flusso').innerText(), /Ricavato dal commit/)
    const passi = page.locator('.ante-passi > li')
    assert.equal(await passi.count(), 2)
    assert.match(await passi.nth(0).innerText(), /Spiegazione dedotta[\s\S]*Citazione trovata/)
    assert.match(await passi.nth(1).innerText(), /Citazione non valida/)
    assert.equal((await page.locator('.anteprima').innerText()).includes('Verificat'), false, 'la parola verificato non compare')

    // Il codice citato si legge con le righe attorno, e la nota chiarisce cosa dimostra.
    await passi.nth(0).getByRole('button', { name: 'Vedi il codice citato' }).click()
    await passi.nth(0).locator('.ante-riga').waitFor()
    assert.match(await passi.nth(0).locator('.ante-codice').innerText(), /prima[\s\S]*salva\(\)[\s\S]*dopo/)
    assert.match(await passi.nth(0).innerText(), /non che la spiegazione sia giusta/)

    // Cambiando funzione, codice aperto e conferma non restano attaccati a quella di prima.
    await page.locator('.ante-dettaglio').getByRole('button', { name: 'Ricava di nuovo il flusso' }).click()
    await page.getByText('circa 1 $ stimato e 5 minuti').waitFor()
    await page.getByRole('button', { name: 'Senza prova' }).click()
    await page.getByRole('heading', { name: 'Senza prova' }).waitFor()
    assert.equal(await page.getByText('circa 1 $ stimato e 5 minuti').count(), 0)
    assert.equal(await page.locator('.ante-codice').count(), 0)
    await page.getByRole('button', { name: 'Vedi il codice citato' }).click()
    await page.getByText('Questo codice non si può mostrare').waitFor()
    await page.getByRole('button', { name: 'Salvare le note' }).click()
    assert.equal(await page.getByText('Questo codice non si può mostrare').count(), 0)
    await page.getByRole('heading', { name: 'Salvataggio di una nota' }).waitFor()
    assert.equal(await page.locator('.ante-griglia section h3 .pill').first().innerText(), 'Dedotta')

    await passi.nth(0).getByRole('button', { name: 'Questa spiegazione è sbagliata' }).click()
    await passi.nth(0).getByLabel('Cosa non torna?').fill('Non manda nulla')
    await passi.nth(0).getByRole('button', { name: 'Salva la segnalazione' }).click()
    await page.getByText('Le tue segnalazioni (1)').waitFor()
    await page.getByRole('button', { name: 'Manca una funzione' }).click()
    await page.locator('.ante-mancanze').getByLabel('Cosa non torna?').fill('Manca la ricerca')
    await page.locator('.ante-mancanze').getByRole('button', { name: 'Salva la segnalazione' }).click()
    await page.getByText('Le tue segnalazioni (2)').waitFor()
    await app.close()

    // Il codice cambia: il risultato è marcato. Le segnalazioni restano e il passo si riconosce.
    writeFileSync(join(path, 'a.dart'), 'cambiato\n')
    git('commit', '-qam', 'Cambia')
    app = await electron.launch({ args: [resolve('.'), '--lang=it', `--user-data-dir=${userData}`] })
    page = await app.firstWindow()
    await page.getByText('Potenzialmente superata').waitFor()
    await page.getByText('Le tue segnalazioni (2)').waitFor()
    await page.getByRole('button', { name: 'Salvare le note' }).click()
    await page.getByText('Potenzialmente superato').waitFor()
    const dopo = page.locator('.ante-passi > li')
    await dopo.first().waitFor()
    assert.match(await dopo.nth(0).innerText(), /Citazione non valida[\s\S]*Forse vecchia[\s\S]*Incerta: l'hai contestata[\s\S]*La tua segnalazione: Non manda nulla/)
    // Il brano si legge ancora dal commit di origine anche se il file è cambiato.
    await dopo.nth(0).getByRole('button', { name: 'Vedi il codice citato' }).click()
    await dopo.nth(0).locator('.ante-riga').waitFor()
    assert.match(await dopo.nth(0).locator('.ante-codice').innerText(), /salva\(\)/)
  } finally {
    await app.close()
  }
})
