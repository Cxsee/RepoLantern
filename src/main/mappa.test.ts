import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Archivio, leggiVersione, statoVersione } from './archivio.ts'
import { Lavori } from './lavori.ts'
import { cartelleFunzione, contesto, controllaFlusso, controllaLivello, erroreJson, estraiJson, lettoreDaCommit, parole, percorsoSicuro, Ricavo, titoliDocumenti, validaFlusso, validaLivello, type Lettore } from './mappa.ts'

const lettore = (file: Record<string, string>): Lettore => ({ elenco: Object.keys(file), leggi: async (f) => file[f] ?? null })
const flusso = (): any => ({
  titolo: 'Flusso',
  zone: [{ id: 'z', nome: 'Zona' }],
  nodi: [{ id: 'x', zona: 'z', kind: 'schermata', nome: 'La schermata', tec: 'a.dart' }, { id: 'y', zona: 'z', kind: 'dati', nome: 'I dati salvati', tec: 'tabella utenti' }],
  passi: [{ da: 'x', a: 'y', tipo: 'dati', nome: 'Salva', spiega: 'Il telefono manda i dati', segno: 'salva()', fonte: { tipo: 'codice', certezza: 'verificato' }, ref: { f: 'a.dart', l: 2, s: 2, righe: ['  salva()'] } }]
})
const livello = (): any => ({ titolo: 'Un prodotto', aree: [{ nome: 'Area', spiega: 'Spiega', funzioni: [{ nome: 'Salvare', spiega: 'Salva le cose', fonte: { testo: 'a.dart:2' } }] }], interne: [] })

test('un percorso che esce dalla repo non passa', () => {
  for (const ok of ['a.dart', 'lib/a b/c.ts']) assert.ok(percorsoSicuro(ok), ok)
  for (const no of ['../a', 'a/../../b', '/etc/passwd', 'C:\\x', 'C:/x', 'a\\b', '', './a', 'a//b', 'a\0b', 3, null, 'x'.repeat(500)]) assert.ok(!percorsoSicuro(no), String(no))
})

test('la forma del flusso si valida prima di tutto', () => {
  assert.deepEqual(validaFlusso({ flusso: flusso() }), [])
  assert.deepEqual(validaFlusso({ trovata: false, motivo: 'cercato ovunque' }), [])
  assert.ok(validaFlusso({ trovata: false }).length)
  for (const rotto of [null, 3, {}, { flusso: {} }, { flusso: { titolo: 't' } }]) assert.ok(validaFlusso(rotto).length)
  const cambia = (fare: (f: any) => void, atteso: RegExp): void => {
    const f = flusso()
    fare(f)
    assert.match(validaFlusso({ flusso: f }).join(' | '), atteso)
  }
  cambia((f) => (f.passi[0].ref = undefined), /senza riferimento/)
  cambia((f) => (f.passi[0].ref.f = '../../segreti.txt'), /percorso non valido/)
  cambia((f) => (f.passi[0].ref.l = -1), /riga non valida/)
  cambia((f) => (f.passi[0].ref.righe = ['x'.repeat(600)]), /brano non valido/)
  cambia((f) => (f.passi[0].a = 'nessuno'), /nodo sconosciuto/)
  cambia((f) => (f.nodi[0].kind = 'altro'), /kind/)
  cambia((f) => (f.nodi[1].id = 'x'), /id non valido/)
  cambia((f) => (f.passi[0].fonte.certezza = 'sicurissimo'), /certezza/)
  cambia((f) => (f.passi = Array(50).fill(f.passi[0])), /fuori limite/)
})

test('la forma del livello si valida', () => {
  assert.deepEqual(validaLivello(livello()), [])
  for (const rotto of [null, {}, { titolo: 't' }, { titolo: 't', aree: [] }, { titolo: 't', aree: [{ nome: 'a' }] }]) assert.ok(validaLivello(rotto).length)
  const troppe = livello()
  troppe.aree[0].funzioni = Array(70).fill(troppe.aree[0].funzioni[0])
  assert.match(validaLivello(troppe).join(), /troppe/)
})

test('i controlli trovano brano rotto, spostato, segno finto, gergo e file inventato', async () => {
  const file = { 'a.dart': 'uno\n  salva()\n' }
  const buono = await controllaFlusso(lettore(file), flusso())
  assert.deepEqual([buono.errori, buono.esatti, buono.segniOk], [[], 1, 1])

  const spostato = flusso()
  const e = await controllaFlusso(lettore({ 'a.dart': 'nuova\nuno\n  salva()\n' }), spostato)
  assert.deepEqual([e.spostati, spostato.passi[0].ref.l, spostato.passi[0].ref.s, e.errori], [1, 3, 3, []])

  const rotto = await controllaFlusso(lettore({ 'a.dart': 'niente\n' }), flusso())
  assert.deepEqual(rotto.passiRotti, [0])

  const segno = flusso()
  segno.passi[0].segno = 'non è nel brano'
  assert.match((await controllaFlusso(lettore(file), segno)).errori.join(), /segno/)

  const gergo = flusso()
  gergo.passi[0].spiega = 'Chiama la RPC game_start'
  gergo.nodi[1].tec = 'inventato.dart'
  const eg = (await controllaFlusso(lettore(file), gergo)).errori.join(' | ')
  assert.match(eg, /gergo/)
  assert.match(eg, /tec non esiste/)
})

test('una citazione SQL vecchia viene segnalata', async () => {
  const f = flusso()
  f.nodi[0].tec = 'tabella'
  f.passi[0].ref = { f: 'db/migrations/1_a.sql', l: 2, s: 2, righe: ['  salva()'] }
  const file = { 'db/migrations/1_a.sql': 'create or replace function public.gioca() as\n  salva()\n', 'db/migrations/2_b.sql': 'create function gioca() as x\n' }
  assert.match((await controllaFlusso(lettore(file), f)).errori.join(), /ridefinita in 2_b\.sql/)
})

test('il livello segnala cartelle e documenti non coperti', async () => {
  const file = { 'lib/features/gioco/a.dart': 'import x\n  salva()\n', 'lib/features/altro/b.dart': 'x\n' }
  const d = livello()
  d.aree[0].funzioni[0].fonte.testo = 'lib/features/gioco/a.dart:1'
  const e = await controllaLivello(lettore(file), d, ['Ripassino senza spoiler', 'Salvare le cose'])
  assert.deepEqual(e.scoperte, ['lib/features/altro'])
  assert.equal(e.deboli, 1)
  assert.deepEqual(e.documentiNonCoperti, ['Ripassino senza spoiler'])
  d.interne = [{ cartella: 'lib/features/altro', motivo: 'interna' }]
  assert.deepEqual((await controllaLivello(lettore(file), d, [])).scoperte, [])
  d.aree[0].funzioni[0].fonte.testo = '../../fuori:1'
  assert.match((await controllaLivello(lettore(file), d, [])).errori.join(), /senza file/)
  assert.deepEqual(cartelleFunzione(['lib/features/test/a.dart', 'lib/features/x/y.png', 'node_modules/pages/z/a.js', 'src/pages/home/a.tsx']), ['src/pages/home'])
})

test('gergo e JSON', () => {
  assert.ok(parole('Chiama la RPC').length)
  assert.ok(parole('apre game_start').length)
  assert.deepEqual(parole('Il server prepara la partita'), [])
  assert.deepEqual(estraiJson('testo {"a":1} fine'), { a: 1 })
  assert.equal(estraiJson('niente'), null)
  assert.equal(estraiJson('{rotto}'), null)
})

function repoFinta(): { repo: string; db: Archivio; finto: (risposte: unknown[]) => () => Promise<{ exe: string; args: string[] }>; git: (...a: string[]) => string } {
  const repo = mkdtempSync(join(tmpdir(), 'hub-map-'))
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'user.name=P', '-c', 'user.email=p@p', '-c', 'core.autocrlf=false', ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  git('init', '-q', '-b', 'master')
  mkdirSync(join(repo, 'lib'))
  writeFileSync(join(repo, 'a.dart'), 'uno\n  salva()\n')
  writeFileSync(join(repo, '.env'), 'CHIAVE=finta\n')
  writeFileSync(join(repo, 'guida.md'), '# Salvare le cose\n')
  git('add', '.')
  git('commit', '-qm', 'primo')
  const cartella = mkdtempSync(join(tmpdir(), 'hub-finto-'))
  return {
    repo,
    git,
    db: new Archivio(join(cartella, 'hub.db')),
    finto: (risposte) => {
      const stato = join(cartella, 'contatore.txt')
      writeFileSync(stato, '0')
      writeFileSync(join(cartella, 'risposte.json'), JSON.stringify(risposte))
      const script = join(cartella, 'finto.mjs')
      writeFileSync(script, `
import { readFileSync, writeFileSync } from 'node:fs'
process.stdin.resume()
process.stdin.on('end', () => {
  const i = Number(readFileSync(${JSON.stringify(stato)}, 'utf8'))
  writeFileSync(${JSON.stringify(stato)}, String(i + 1))
  const r = JSON.parse(readFileSync(${JSON.stringify(join(cartella, 'risposte.json'))}, 'utf8'))[i]
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: typeof r === 'string' ? r : JSON.stringify(r), total_cost_usd: 0.25, num_turns: 1, usage: {} }) + String.fromCharCode(10))
})`)
      return async () => ({ exe: process.execPath, args: [script] })
    }
  }
}

test('il livello si salva con la sua provenienza e sostituisce il precedente', async () => {
  const { repo, db, finto, git } = repoFinta()
  const lavori = await Lavori.apri(db, repo, { comando: finto([livello()]) })
  const r = await new Ricavo(db, lavori, repo).livello()
  assert.deepEqual([r.correzioni, r.funzioni, r.costo, r.commit], [0, 1, 0.25, git('rev-parse', 'HEAD')])
  const dati = db.mappa()
  assert.equal(dati.stato?.titolo, 'Un prodotto')
  assert.deepEqual(dati.funzioni.map((f) => [f.nome, f.citazione, f.citazione_valida]), [['Salvare', 'a.dart:2', 1]])
  assert.equal(db.provenienzaDi(dati.funzioni[0].id)?.autore, 'sonnet')
  assert.equal(db.provenienzaDi(dati.funzioni[0].id)?.certezza, 'dedotto')
})

test('un livello con errori riceve una sola correzione, e poi gli errori restano visibili', async () => {
  const { repo, db, finto } = repoFinta()
  const conErrore = livello()
  conErrore.aree[0].funzioni[0].fonte.testo = 'inventato.dart:1'
  const lavori = await Lavori.apri(db, repo, { comando: finto([conErrore, conErrore, livello()]) })
  const r = await new Ricavo(db, lavori, repo).livello()
  assert.equal(r.correzioni, 1)
  assert.match(r.errori.join(), /file assente/)
  assert.equal(db.lavori().length, 2)
  assert.match(JSON.stringify(db.mappa().stato?.copertura), /file assente/)
  assert.deepEqual(db.mappa().funzioni.map((f) => [f.nome, f.citazione_valida]), [['Salvare', 0]])
})

test('una correzione rotta non cancella una risposta buona nella forma; una forma rotta non salva nulla', async () => {
  const uno = repoFinta()
  const conErrore = livello()
  conErrore.aree[0].funzioni[0].fonte.testo = 'inventato.dart:1'
  const l1 = await Lavori.apri(uno.db, uno.repo, { comando: uno.finto([conErrore, 'non è json']) })
  assert.equal((await new Ricavo(uno.db, l1, uno.repo).livello()).correzioni, 1)
  assert.equal(uno.db.mappa().funzioni.length, 1)

  const due = repoFinta()
  const l2 = await Lavori.apri(due.db, due.repo, { comando: due.finto(['niente', { titolo: 't' }]) })
  await assert.rejects(new Ricavo(due.db, l2, due.repo).livello(), /isn't valid/)
  assert.equal(due.db.mappa().funzioni.length, 0)
})

test('un flusso si lega alla funzione; un brano rotto resta non valido', async () => {
  const { repo, db, finto, git } = repoFinta()
  const buono = flusso()
  const rotto = flusso()
  rotto.nodi[0].tec = 'tabella'
  rotto.passi.push({ ...rotto.passi[0], nome: 'Altro', ref: { f: 'a.dart', l: 9, s: 9, righe: ['non esiste'] }, segno: 'non esiste' })
  const lavori = await Lavori.apri(db, repo, { comando: finto([livello(), { flusso: rotto }, { flusso: rotto }, { flusso: buono }]) })
  const ricavo = new Ricavo(db, lavori, repo)
  await ricavo.livello()
  const f = db.mappa().funzioni[0].id
  const r = await ricavo.flusso(f)
  assert.ok(r.trovata)
  if (!r.trovata) return
  assert.equal(r.correzioni, 1)
  assert.deepEqual(r.passiRotti, [1])
  assert.equal(db.flussiDi(f).length, 1)
  const stato = await db.statoFlusso(r.flusso, repo)
  assert.deepEqual(stato.riferimenti.map((x) => [x.stato, x.etichetta, x.spiegazione]), [['valido', 'citazione-trovata', 'dedotta'], ['non-valido', 'non-valido', 'dedotta']])
  // Rotto quando è stato ricavato: non torna buono perché quel testo ora c'è.
  writeFileSync(join(repo, 'a.dart'), 'uno\n  salva()\nnon esiste\n')
  assert.deepEqual((await db.statoFlusso(r.flusso, repo)).riferimenti.map((x) => x.etichetta), ['citazione-trovata', 'non-valido'])
  git('checkout', '--', 'a.dart')

  // Rifare il flusso sostituisce il precedente, senza duplicare la funzione.
  const r2 = await ricavo.flusso(f)
  assert.ok(r2.trovata)
  assert.equal(db.flussiDi(f).length, 1)
  assert.equal(db.mappa().funzioni.length, 1)
})

test('una funzione inesistente non viene inventata', async () => {
  const { repo, db, finto } = repoFinta()
  const lavori = await Lavori.apri(db, repo, { comando: finto([livello(), { trovata: false, motivo: 'Cercato ovunque' }]) })
  const ricavo = new Ricavo(db, lavori, repo)
  await ricavo.livello()
  const f = db.mappa().funzioni[0].id
  const r = await ricavo.flusso(f)
  assert.deepEqual([r.trovata, !r.trovata && r.motivo], [false, 'Cercato ovunque'])
  assert.equal(db.flussiDi(f).length, 0)
  assert.equal(db.provenienzaDi(f)?.certezza, 'non-disponibile')
})

test('la lettura dal commit non apre segreti né percorsi strani, e ignora le modifiche in corso', async () => {
  const { repo, git } = repoFinta()
  writeFileSync(join(repo, 'a.dart'), 'cambiato\n')
  const l = await lettoreDaCommit(repo, git('rev-parse', 'HEAD'))
  assert.match((await l.leggi('a.dart'))!, /salva/)
  assert.equal(await l.leggi('.env'), null)
  assert.equal(await l.leggi('../a.dart'), null)
  assert.equal(await l.leggi('nessuno.dart'), null)
  assert.deepEqual(await titoliDocumenti(l), ['Salvare le cose'])
})

test('forse vecchia guarda il file citato, anche con modifiche non committate', async () => {
  const { repo, db, git } = repoFinta()
  writeFileSync(join(repo, 'b.dart'), 'altro\n')
  git('add', '.')
  git('commit', '-qm', 'secondo')
  const f = flusso()
  f.nodi[0].tec = 'tabella'
  const { flusso: id } = db.salvaFlusso(await leggiVersione(repo), { nome: 'F', spiega: 'S' }, f, 'prova')
  const vecchia = async (): Promise<boolean> => (await db.statoFlusso(id, repo)).riferimenti[0].forseVecchia
  assert.equal(await vecchia(), false)
  writeFileSync(join(repo, 'b.dart'), 'cambiato non committato\n')
  assert.equal(await vecchia(), false, 'un altro file non conta')
  writeFileSync(join(repo, 'a.dart'), 'uno\n  salva()\n// aggiunta\n')
  assert.equal(await vecchia(), true, 'modifica non committata al file citato')
  git('add', '.')
  git('commit', '-qm', 'terzo')
  assert.equal(await vecchia(), true, 'modifica committata al file citato')
  assert.equal((await db.statoFlusso(id, repo)).riferimenti[0].stato, 'valido')
})

test('un JSON illeggibile arriva alla correzione con il suo vero motivo', async () => {
  assert.match(erroreJson('testo {"a":1}} fine'), /JSON non leggibile/)
  assert.match(erroreJson('niente'), /nessun oggetto/)
  assert.equal(erroreJson('{"a":1}'), '')
  const { repo, db, finto } = repoFinta()
  const lavori = await Lavori.apri(db, repo, { comando: finto([livello(), JSON.stringify({ flusso: flusso() }) + '}}x{', { flusso: flusso() }]) })
  const ricavo = new Ricavo(db, lavori, repo)
  await ricavo.livello()
  const r = await ricavo.flusso(db.mappa().funzioni[0].id)
  assert.deepEqual([r.trovata, r.correzioni], [true, 1])
  assert.match(db.lavori()[2].prompt, /JSON non leggibile/)
  assert.doesNotMatch(db.lavori()[2].prompt, /flusso o titolo mancanti/)
})

test('i documenti di lavoro non contano come funzioni del prodotto', async () => {
  const l = lettore({ 'README.md': '# Il prodotto', 'docs/audit-finale.md': '# Marco, 34 anni', 'docs/guida.md': '# Audit finale', 'docs/superpowers/x.md': '# Piano', 'docs/giochi.md': '# I giochi' })
  assert.deepEqual((await titoliDocumenti(l)).sort(), ['I giochi', 'Il prodotto'])
})

test('il contesto si legge dal commit e non esce dai suoi file', async () => {
  const { repo, git } = repoFinta()
  const commit = git('rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.dart'), 'cambiato\n')
  assert.deepEqual(await contesto(repo, commit, 'a.dart', 2, 1), { inizio: 1, righe: ['uno', '  salva()', ''] })
  assert.deepEqual((await contesto(repo, commit, 'a.dart', 999, 0))?.inizio, 3)
  for (const [c, f] of [[commit, '.env'], [commit, '../a.dart'], [commit, 'nessuno'], ['--output=x', 'a.dart'], ['deadbeef', 'a.dart'], [null, 'a.dart'], [commit, null]]) assert.equal(await contesto(repo, c, f, 1), null, `${c} ${f}`)
})

test('una segnalazione sopravvive a un nuovo ricavo e riconosce lo stesso passo', async () => {
  const { repo, db } = repoFinta()
  const f = flusso()
  f.nodi[0].tec = 'tabella'
  const v = await leggiVersione(repo)
  const { funzione, flusso: id } = db.salvaFlusso(v, { nome: 'F', spiega: 'S' }, f, 'prova')
  const prima = await db.flussoCompleto(id, repo)
  assert.deepEqual([prima.commit, prima.superato, prima.passi[0].segnalato, prima.passi[0].da, prima.passi[0].a], [v.commit, false, null, 'La schermata', 'I dati salvati'])
  db.segnalaPasso(prima.passi[0].passo, 'Falsa')
  const salvata = db.segnalazioni()[0]
  // Ciò che si segnala viene dall'archivio, non da chi chiama.
  assert.deepEqual([salvata.tipo, salvata.funzione, salvata.frase, salvata.file, salvata.commit_hash], ['spiegazione', 'F', f.passi[0].spiega, 'a.dart', v.commit])
  assert.throws(() => db.segnalaPasso('passo:inventato', 'x'), /Unknown/)
  const { flusso: nuovo } = db.salvaFlusso(v, { id: funzione, nome: 'F', spiega: 'S' }, f, 'prova')
  assert.notEqual(nuovo, id)
  const dopo = await db.flussoCompleto(nuovo, repo)
  assert.equal(dopo.passi[0].chiave, prima.passi[0].chiave)
  assert.equal(dopo.passi[0].segnalato, 'questa')
  // Stesso passo ma frase riscritta: non è la frase che era stata contestata.
  const riscritto = flusso()
  riscritto.nodi[0].tec = 'tabella'
  riscritto.passi[0].spiega = 'Una spiegazione diversa'
  const { flusso: terzo } = db.salvaFlusso(v, { id: funzione, nome: 'F', spiega: 'S' }, riscritto, 'prova')
  assert.equal((await db.flussoCompleto(terzo, repo)).passi[0].segnalato, 'precedente')
  db.segnalaMancante('Manca la ricerca')
  assert.equal(db.segnalazioni().length, 2)
  db.eliminaFunzione(funzione)
  assert.equal(db.segnalazioni().length, 2, 'non si perde nemmeno se la funzione sparisce')
  await assert.rejects(db.flussoCompleto(nuovo, repo), /Unknown/)
})

test('la versione distingue due stati anche con stessa dimensione e data, e distingue ciò che è solo nell\'indice', async () => {
  const { repo, git } = repoFinta()
  const quando = new Date('2026-01-02T03:04:05Z')
  writeFileSync(join(repo, 'a.dart'), 'AAAAAAAA\n')
  utimesSync(join(repo, 'a.dart'), quando, quando)
  const uno = await leggiVersione(repo)
  writeFileSync(join(repo, 'a.dart'), 'BBBBBBBB\n')
  utimesSync(join(repo, 'a.dart'), quando, quando)
  const due = await leggiVersione(repo)
  assert.notEqual(uno.impronta, due.impronta)
  git('add', 'a.dart')
  const inIndice = await leggiVersione(repo)
  assert.notEqual(inIndice.impronta, due.impronta, 'lo stesso contenuto ma pronto per il commit')
  assert.equal(inIndice.impronta, (await leggiVersione(repo)).impronta)
  const veloce = await statoVersione(repo)
  assert.deepEqual([veloce.commit, veloce.modifiche, 'impronta' in veloce], [inIndice.commit, 1, false])
})

test('il confronto con una versione ricavata da codice non committato guarda il contenuto', async () => {
  const { repo, db } = repoFinta()
  writeFileSync(join(repo, 'b.dart'), 'prima\n')
  const f = flusso()
  f.nodi[0].tec = 'tabella'
  const { flusso: id } = db.salvaFlusso(await leggiVersione(repo), { nome: 'F', spiega: 'S' }, f, 'prova')
  assert.equal((await db.statoFlusso(id, repo)).riferimenti[0].versioneUguale, true)
  writeFileSync(join(repo, 'b.dart'), 'dopo!\n')
  assert.equal((await db.statoFlusso(id, repo)).riferimenti[0].versioneUguale, false)
})

test('il JSON si trova anche dopo un testo con delle graffe', () => {
  const vero = { revisione: [{ passo: 1, esito: 'ok' }] }
  assert.deepEqual(estraiJson('Il server restituisce `{results, upcoming}`. Ecco:\n\n```json\n' + JSON.stringify(vero) + '\n```'), vero)
  assert.deepEqual(estraiJson('Vedi {a, b} e poi ' + JSON.stringify(vero)), vero)
  assert.deepEqual(estraiJson('```json\n{"a":1}\n```\ntesto\n```json\n{"b":2}\n```'), { b: 2 })
  assert.equal(estraiJson('solo {a, b} e basta'), null)
  assert.equal(estraiJson('{"a":1}} rotto {'), null)
  assert.equal(erroreJson('Vedi {a, b} e poi ' + JSON.stringify(vero)), '')
  assert.match(erroreJson('solo {a, b}'), /JSON non leggibile/)
})

test('un commento non prova un passo, il codice vicino a un commento sì', async () => {
  const prova = async (f: string, testo: string, l: number, ...righe: string[]) => {
    const fl = flusso()
    fl.passi[0].ref = { f, l, s: l, righe }
    fl.passi[0].segno = undefined
    fl.passi[0].fonte.certezza = 'dedotto'
    fl.nodi.forEach((x: any) => { x.tec = 'x' })
    return (await controllaFlusso(lettore({ [f]: testo }), fl)).passiRotti
  }
  assert.deepEqual(await prova('a.dart', '// salva tutto\nsalva();\n', 1, '// salva tutto'), [0])
  assert.deepEqual(await prova('a.dart', '// salva tutto\nsalva();\n', 1, '// salva tutto', 'salva();'), [0])
  assert.deepEqual(await prova('a.sql', '-- seconda passata\nselect 1;\n', 1, '-- seconda passata'), [0])
  assert.deepEqual(await prova('a.py', '# salva\nsalva()\n', 1, '# salva'), [0])
  assert.deepEqual(await prova('a.dart', '// salva tutto\nsalva();\n', 2, 'salva();'), [])
  assert.deepEqual(await prova('a.dart', 'salva(); // poi esce\n', 1, 'salva(); // poi esce'), [])
  assert.deepEqual(await prova('a.dart', '--conta;\n', 1, '--conta;'), [])
  assert.deepEqual(await prova('a.c', '#include <a.h>\n', 1, '#include <a.h>'), [])
  assert.deepEqual(await prova('a.ts', 'const x = 2\n  * y\n', 2, '  * y'), [])
  assert.deepEqual(await prova('a.ts', '/**\n * salva tutto\n */\nsalva()\n', 2, ' * salva tutto'), [0])
  assert.deepEqual(await prova('a.ts', '/* inizio\nsalva tutto\n*/\nsalva()\n', 2, 'salva tutto'), [0])
  assert.deepEqual(await prova('a.ts', '/* fine */\nconst x = 2\n  * y\n', 3, '  * y'), [])
  assert.deepEqual(await prova('a.ts', "const g = 'src/**/*.ts'\nsalva()\n", 2, 'salva()'), [])
  assert.deepEqual(await prova('a.ts', "const g = 'a/*'\nsalva()\n", 2, 'salva()'), [])
})

test('una definizione SQL superata non prova il passo, quella più recente sì', async () => {
  const f1 = 'db/migrations/1_a.sql'
  const f2 = 'db/migrations/2_b.sql'
  const file = { [f1]: 'create function f() returns int as $$\nselect 1;\n$$;\n', [f2]: 'create or replace function public.f() returns int as $$\nselect 2;\n$$;\n', 'a.dart': 'uno\n  salva()\ndue\n' }
  const prova = async (f: string, riga: string) => {
    const fl = flusso()
    fl.passi[0].ref = { f, l: 2, s: 2, righe: [riga] }
    fl.passi[0].segno = undefined
    fl.passi[0].fonte.certezza = 'dedotto'
    fl.nodi.forEach((x: any) => { x.tec = 'x' })
    return (await controllaFlusso(lettore(file), fl)).passiRotti
  }
  assert.deepEqual(await prova(f1, 'select 1;'), [0])
  assert.deepEqual(await prova(f2, 'select 2;'), [])
})
