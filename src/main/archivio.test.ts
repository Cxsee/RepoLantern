import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Archivio, controllaBrano, leggiVersione, MIGRAZIONI } from './archivio.ts'

const TESTO = ['uno', 'due', 'tre', 'quattro', ''].join('\n')
const AUTORE = 'claude-prova'
const flussoDi = (file = 'a.txt', s = 2, righe = ['due', 'tre']): any => ({
  titolo: 'Flusso',
  nodi: [{ id: 'x', zona: 'z', kind: 'schermata', nome: 'Schermata', tec: 'x.dart' }, { id: 'y', zona: 'z', kind: 'dati', nome: 'Dati', tec: 'y.sql' }],
  passi: [{ da: 'x', a: 'y', tipo: 'dati', nome: 'Passo', spiega: 'Spiega', fonte: { certezza: 'verificato' }, ref: { f: file, l: s, s, righe } }]
})
const nuovoDb = (): string => join(mkdtempSync(join(tmpdir(), 'hubdb-')), 'hub.db')

function repo(): { dir: string; git: (...a: string[]) => string; db: Archivio } {
  const dir = mkdtempSync(join(tmpdir(), 'hub-'))
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'user.name=Prova', '-c', 'user.email=p@p', '-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  git('init', '-q', '-b', 'master')
  writeFileSync(join(dir, 'a.txt'), TESTO)
  writeFileSync(join(dir, 'b.txt'), 'altro\n')
  git('add', '.')
  git('commit', '-qm', 'primo')
  return { dir, git, db: new Archivio(nuovoDb()) }
}

test('il brano è valido, spostato o non valido', () => {
  const r = { l: 2, s: 2, righe: ['due', 'tre'] }
  assert.deepEqual(controllaBrano(TESTO, r), { stato: 'valido', riga: 2 })
  assert.deepEqual(controllaBrano(TESTO.replace(/\n/g, '\r\n'), r), { stato: 'valido', riga: 2 })
  assert.deepEqual(controllaBrano('nuova\n' + TESTO, r), { stato: 'spostato', riga: 3 })
  assert.equal(controllaBrano('uno\nquattro\n', r).stato, 'non-valido')
  assert.equal(controllaBrano('due\ntre\nx\ndue\ntre\n', { l: 2, s: 7, righe: ['due', 'tre'] }).stato, 'non-valido')
  assert.equal(controllaBrano(TESTO, { l: 9, s: 2, righe: ['due'] }).stato, 'non-valido')
  assert.equal(controllaBrano(TESTO, { l: 2, s: 2, righe: [] }).stato, 'non-valido')
})

test('funzione e attività si ritrovano dai due lati', async () => {
  const { dir, db } = repo()
  const { funzione } = db.salvaFlusso(await leggiVersione(dir), { nome: 'F', spiega: 'S' }, flussoDi(), AUTORE)
  const att = db.aggiungiAttivita('Sistemare F')
  db.collega(att, funzione, 'riguarda', 'utente', 'verificato')
  assert.deepEqual(db.legamiDi(att).map((l) => [l.altro, l.verso]), [[funzione, 'uscente']])
  assert.deepEqual(db.legamiDi(funzione).map((l) => [l.altro, l.verso]), [[att, 'entrante']])
})

test('una modifica al brano lo invalida, altrove no', async () => {
  const { dir, db } = repo()
  const { flusso } = db.salvaFlusso(await leggiVersione(dir), { nome: 'F', spiega: 'S' }, flussoDi(), AUTORE)
  assert.equal((await db.statoFlusso(flusso, dir)).riferimenti[0].versioneUguale, true)
  writeFileSync(join(dir, 'b.txt'), 'cambiato\n')
  let s = await db.statoFlusso(flusso, dir)
  assert.equal(s.riferimenti[0].stato, 'valido')
  assert.equal(s.riferimenti[0].fileModificato, false)
  assert.equal(s.versione.modifiche, 1)
  assert.equal(s.riferimenti[0].versioneUguale, false)
  writeFileSync(join(dir, 'a.txt'), 'nuova\n' + TESTO)
  s = await db.statoFlusso(flusso, dir)
  assert.deepEqual([s.riferimenti[0].stato, s.riferimenti[0].riga, s.riferimenti[0].fileModificato], ['spostato', 3, true])
  writeFileSync(join(dir, 'a.txt'), 'uno\n')
  assert.equal((await db.statoFlusso(flusso, dir)).riferimenti[0].stato, 'non-valido')
})

test('due stati dello stesso worktree sono due versioni, lo stesso stato è una sola', async () => {
  const { dir } = repo()
  const pulita = await leggiVersione(dir)
  assert.equal(pulita.impronta, null)
  writeFileSync(join(dir, 'b.txt'), 'primo stato\n')
  const uno = await leggiVersione(dir)
  assert.equal(uno.impronta, (await leggiVersione(dir)).impronta)
  writeFileSync(join(dir, 'b.txt'), 'secondo stato\n')
  const due = await leggiVersione(dir)
  assert.deepEqual([uno.commit, uno.modifiche], [due.commit, due.modifiche])
  assert.notEqual(uno.impronta, due.impronta)
  mkdirSync(join(dir, 'nuova'))
  writeFileSync(join(dir, 'nuova', 'c.txt'), 'x')
  assert.equal((await leggiVersione(dir)).modifiche, 2)
})

test('due worktree danno risultati diversi e dicono quale si legge', async () => {
  const { dir, git, db } = repo()
  const altro = join(mkdtempSync(join(tmpdir(), 'hubwt-')), 'wt')
  git('worktree', 'add', '-q', '-b', 'prova', altro)
  writeFileSync(join(altro, 'a.txt'), 'uno\n')
  execFileSync('git', ['-c', 'user.name=Prova', '-c', 'user.email=p@p', 'commit', '-qam', 'cambia'], { cwd: altro })
  const { flusso } = db.salvaFlusso(await leggiVersione(dir), { nome: 'F', spiega: 'S' }, flussoDi(), AUTORE)
  const qui = await db.statoFlusso(flusso, dir)
  const la = await db.statoFlusso(flusso, altro)
  assert.deepEqual([qui.versione.branch, qui.riferimenti[0].stato, qui.riferimenti[0].versioneUguale], ['master', 'valido', true])
  assert.deepEqual([la.versione.branch, la.riferimenti[0].stato, la.riferimenti[0].versioneUguale], ['prova', 'non-valido', false])
})

test('un riferimento non esce dal worktree e non apre segreti', async () => {
  const { dir, db } = repo()
  const fuori = mkdtempSync(join(tmpdir(), 'hubfuori-'))
  writeFileSync(join(fuori, 'f.txt'), TESTO)
  writeFileSync(join(dir, '..', 'fuori-hub.txt'), TESTO)
  // Una giunzione non chiede i privilegi di un collegamento simbolico e si segue allo stesso modo.
  symlinkSync(fuori, join(dir, 'ponte'), 'junction')
  writeFileSync(join(dir, '.env'), TESTO)
  writeFileSync(join(dir, 'chiave.key'), TESTO)
  const v = await leggiVersione(dir)
  for (const file of ['../fuori-hub.txt', join(fuori, 'f.txt'), 'ponte/f.txt', '.env', 'chiave.key', '.', 'nessuno.txt']) {
    const { flusso } = db.salvaFlusso(v, { nome: file, spiega: 'S' }, flussoDi(file), AUTORE)
    assert.equal((await db.statoFlusso(flusso, dir)).riferimenti[0].stato, 'non-valido', file)
  }
  const { flusso } = db.salvaFlusso(v, { nome: 'buono', spiega: 'S' }, flussoDi(), AUTORE)
  assert.equal((await db.statoFlusso(flusso, dir)).riferimenti[0].stato, 'valido')
})

test('cancellare una funzione non lascia nulla di orfano', async () => {
  const { dir, db } = repo()
  const { funzione } = db.salvaFlusso(await leggiVersione(dir), { nome: 'F', spiega: 'S' }, flussoDi(), AUTORE)
  const att = db.aggiungiAttivita('A')
  db.collega(att, funzione, 'riguarda', 'utente', 'verificato')
  assert.equal(db.conta('provenienza'), 5)
  db.eliminaFunzione(funzione)
  for (const t of ['legami', 'flusso', 'nodo', 'passo', 'riferimento', 'provenienza'] as const) assert.equal(db.conta(t), 0, t)
})

test('un legame sbagliato viene rifiutato', async () => {
  const { dir, db } = repo()
  const { funzione } = db.salvaFlusso(await leggiVersione(dir), { nome: 'F', spiega: 'S' }, flussoDi(), AUTORE)
  const att = db.aggiungiAttivita('A')
  assert.throws(() => db.collega(att, funzione, 'inventato', 'x', 'dedotto'), /not allowed/)
  assert.throws(() => db.collega(funzione, att, 'riguarda', 'x', 'dedotto'), /not allowed/)
  assert.throws(() => db.collega(att, 'funzione:nessuna', 'riguarda', 'x', 'dedotto'), /does not exist/)
  assert.equal(db.conta('legami'), 0)
})

test('i dati git si leggono, anche senza commit, e i legami del worktree restano', async () => {
  const { dir, git, db } = repo()
  const uno = await db.aggiornaDaGit(dir)
  assert.deepEqual([uno.commit, uno.worktree], [1, 1])
  assert.ok(uno.ref >= 1)
  const att = db.aggiungiAttivita('A')
  const percorso = git('worktree', 'list', '--porcelain').split('\n')[0].slice(9)
  db.collega(att, `worktree:${percorso}`, 'lavora_su', 'git', 'verificato')
  await db.aggiornaDaGit(dir)
  assert.equal(db.legamiDi(att).length, 1)

  const vuota = mkdtempSync(join(tmpdir(), 'hubvuota-'))
  execFileSync('git', ['init', '-q'], { cwd: vuota })
  const dbv = new Archivio(':memory:')
  assert.deepEqual([(await dbv.aggiornaDaGit(vuota)).commit, (await leggiVersione(vuota)).commit], [0, null])
})

test('area, nodi e funzione si navigano e portano la provenienza', async () => {
  const { dir, db } = repo()
  const v = await leggiVersione(dir)
  const area = db.aggiungiArea(v, { nome: 'Giochi', spiega: 'S' }, AUTORE)
  const { funzione, flusso } = db.salvaFlusso(v, { nome: 'F', spiega: 'S', area }, flussoDi(), AUTORE)
  assert.deepEqual(db.funzioniDi(area).map((f) => f.id), [funzione])
  assert.equal(db.areaDi(funzione), area)
  assert.deepEqual(db.passiDi(flusso).map((p) => ({ ...p })), [{ nome: 'Passo', da: 'Schermata', a: 'Dati', tipo: 'dati' }])
  const p = db.provenienzaDi(funzione)
  assert.deepEqual([p?.fonte, p?.certezza, p?.autore, p?.versione_id], ['deduzione', 'dedotto', AUTORE, `versione:${v.commit}:pulita`])
  // Togliere un'area lascia le funzioni, senza area.
  db.eliminaArea(area)
  assert.equal(db.areaDi(funzione), null)
  assert.equal(db.provenienzaDi(area), null)
})

test('un passo con un nodo inesistente non salva nulla', async () => {
  const { dir, db } = repo()
  const f = flussoDi()
  f.passi[0].a = 'nessuno'
  assert.throws(() => db.salvaFlusso({ percorso: dir, branch: null, commit: 'x', impronta: null, modifiche: 0 }, { nome: 'F', spiega: 'S' }, f, AUTORE), /unknown node/)
  assert.deepEqual([db.conta('flusso'), db.conta('nodo'), db.conta('provenienza')], [0, 0, 0])
})

test('una sessione si lega a un worktree e a un\'attività, e sopravvive al worktree', async () => {
  const { dir, git, db } = repo()
  await db.aggiornaDaGit(dir)
  const percorso = git('worktree', 'list', '--porcelain').split('\n')[0].slice(9)
  const s = db.registraSessione('Prova', `worktree:${percorso}`, null)
  const att = db.aggiungiAttivita('A')
  db.collega(att, s, 'portata_avanti_in', 'hub', 'verificato')
  assert.equal(db.legamiDi(s).length, 1)
  assert.throws(() => db.registraSessione('Prova', 'worktree:nessuno', null), /FOREIGN KEY/)
  db.impostaWorkspace(dir, 'Prova')
  db.impostaWorkspace(dir, 'Prova due')
  assert.equal(db.conta('workspace'), 1)
})

test('un archivio già creato si riapre con i dati', async () => {
  const { dir } = repo()
  const file = nuovoDb()
  const a = new Archivio(file)
  a.salvaFlusso(await leggiVersione(dir), { nome: 'F', spiega: 'S' }, flussoDi(), AUTORE)
  a.close()
  const b = new Archivio(file)
  assert.equal(b.conta('flusso'), 1)
  b.close()
})

test('un archivio vecchio migra con i dati intatti e la provenienza riempita', async () => {
  const file = nuovoDb()
  new Archivio(file, MIGRAZIONI.slice(0, 1)).close()
  const { DatabaseSync } = await import('node:sqlite')
  const vecchio = new DatabaseSync(file)
  vecchio.exec(`insert into versione values ('versione:c:pulita', 'c', null, 0);
    insert into funzione (id, nome, spiega, versione_id) values ('funzione:1', 'F', 'S', 'versione:c:pulita');
    insert into flusso values ('flusso:1', 'funzione:1', 'T');
    insert into passo values ('passo:1', 'flusso:1', 0, 'P', 'S', 'verificato');`)
  vecchio.close()
  const db = new Archivio(file)
  assert.deepEqual([db.conta('flusso'), db.conta('passo'), db.conta('provenienza')], [1, 1, 3])
  assert.equal(db.provenienzaDi('funzione:1')?.autore, 'sconosciuto')
  assert.equal(db.areaDi('funzione:1'), null)
  db.close()
})

test('una migrazione interrotta a metà lascia l\'archivio com\'era', async () => {
  const { dir } = repo()
  const file = nuovoDb()
  const a = new Archivio(file)
  a.salvaFlusso(await leggiVersione(dir), { nome: 'F', spiega: 'S' }, flussoDi(), AUTORE)
  a.close()
  const rotta = 'create table mezza (id text); insert into tabella_che_non_esiste values (1);'
  assert.throws(() => new Archivio(file, [...MIGRAZIONI, rotta]), /tabella_che_non_esiste/)
  const b = new Archivio(file)
  assert.equal(b.conta('flusso'), 1)
  b.close()
  // La migrazione rifatta bene riparte da dove era: se la tabella fosse rimasta, fallirebbe.
  new Archivio(file, [...MIGRAZIONI, 'create table mezza (id text);']).close()
})

test('la lettura senza AI riempie profilo, voci e ricerca, e rilegge solo ciò che è cambiato', async () => {
  const { dir, git, db } = repo()
  writeFileSync(join(dir, 'guida.md'), '# Guida al dossier\n\n- [ ] Scrivere la guida\n')
  writeFileSync(join(dir, 'pubspec.yaml'), 'name: x\n')
  writeFileSync(join(dir, 'main.dart'), '// TODO sistemare\n')
  git('add', '.')
  git('commit', '-qm', 'Aggiunto il dossier')
  let r = await db.aggiorna(dir)
  assert.equal(r.profilo?.tipo, 'mobile')
  assert.deepEqual(r.profilo?.framework, ['Flutter'])
  assert.equal(r.profilo?.linguaggi.Dart, 1)
  assert.equal(r.voci, 2)
  assert.deepEqual(db.vociDi('guida.md').map((v) => ({ ...v })), [{ riga: 3, testo: 'Scrivere la guida', tipo: 'documento' }])
  assert.deepEqual(await db.aggiornaFile(dir), { file: 5, cambiati: 0, documentiLetti: 0 })

  assert.deepEqual(db.cerca('guida').map((t) => t.oggetto), ['file:guida.md'])
  assert.deepEqual(db.cerca('dossier').map((t) => t.tipo).sort(), ['commit', 'file'])
  assert.deepEqual(db.cerca('mast').map((t) => t.tipo), ['ref'])
  assert.deepEqual(db.cerca('  '), [])
  assert.deepEqual(db.cerca('"a" OR NEAR('), [])
  assert.deepEqual(db.cerca('nessunacorrispondenza'), [])

  writeFileSync(join(dir, 'guida.md'), '# Manuale\n')
  writeFileSync(join(dir, 'altro.md'), '# Altro\n')
  assert.deepEqual(await db.aggiornaFile(dir), { file: 6, cambiati: 2, documentiLetti: 2 })
  assert.deepEqual(db.cerca('manuale').map((t) => t.oggetto), ['file:guida.md'])
  assert.deepEqual(db.vociDi('guida.md'), [])

  rmSync(join(dir, 'altro.md'))
  r = await db.aggiorna(dir)
  assert.equal(r.file, 5)
  assert.deepEqual(db.cerca('altro').filter((t) => t.tipo === 'file'), [])
})

test('funzioni e attività si trovano e spariscono con la cancellazione, anche da un archivio migrato', async () => {
  const { dir, db } = repo()
  const { funzione } = db.salvaFlusso(await leggiVersione(dir), { nome: 'Sfida del giorno', spiega: 'Una partita al giorno' }, flussoDi(), AUTORE)
  db.aggiungiAttivita('Sistemare la sfida')
  assert.deepEqual(db.cerca('sfida').map((t) => t.tipo).sort(), ['attivita', 'funzione'])
  assert.deepEqual(db.cerca('partita').map((t) => t.oggetto), [funzione])
  db.eliminaFunzione(funzione)
  assert.deepEqual(db.cerca('sfida').map((t) => t.tipo), ['attivita'])

  const file = nuovoDb()
  const vecchio = new Archivio(file, MIGRAZIONI.slice(0, 2))
  vecchio.aggiungiAttivita('Attività di prima')
  vecchio.close()
  const nuovo = new Archivio(file)
  assert.deepEqual(nuovo.cerca('prima').map((t) => t.tipo), ['attivita'])
  nuovo.close()
})

test('dopo un rebase i commit vecchi spariscono dai dati e dalla ricerca', async () => {
  const { dir, git, db } = repo()
  git('commit', '-q', '--allow-empty', '-m', 'Commit da riscrivere')
  await db.aggiornaDaGit(dir)
  assert.equal(db.cerca('riscrivere').length, 1)
  git('commit', '-q', '--amend', '--allow-empty', '-m', 'Commit corretto')
  await db.aggiornaDaGit(dir)
  assert.equal(db.cerca('riscrivere').length, 0)
  assert.equal(db.cerca('corretto').length, 1)
  assert.equal(db.conta('commit_git'), 2)
})

test('una repo vuota si apre senza errori', async () => {
  const vuota = mkdtempSync(join(tmpdir(), 'hubvuota-'))
  execFileSync('git', ['init', '-q'], { cwd: vuota })
  const db = new Archivio(':memory:')
  const r = await db.aggiorna(vuota)
  assert.deepEqual([r.file, r.commit, r.voci, r.profilo], [0, 0, 0, null])
  assert.deepEqual(db.cerca('qualcosa'), [])
})

test('un archivio di una Hub più recente non viene toccato', () => {
  const file = nuovoDb()
  new Archivio(file, [...MIGRAZIONI, 'create table futura (id text);']).close()
  assert.throws(() => new Archivio(file), /newer version/)
})

test('il pannello dice solo ciò che l\'archivio sa, con la provenienza giusta', async () => {
  const { dir, git, db } = repo()
  writeFileSync(join(dir, 'guida.md'), '# Guida\n\n- [ ] Da fare\n')
  git('add', '.')
  git('commit', '-qm', 'Secondo commit')
  await db.aggiorna(dir)
  const v = await leggiVersione(dir)
  db.salvaLivello(v, { titolo: 'T', aree: [{ nome: 'Area', spiega: 'S', funzioni: [{ nome: 'F', spiega: 'Spiega', fonte: { testo: 'a.txt:1' } }] }] }, 'claude-x', {}, new Set(['F']))

  const file = db.oggetto('file:guida.md')!
  assert.deepEqual([file.tipo, file.provenienza.certezza, file.percorso, file.destinazione], ['file', 'certo', 'guida.md', { t: 'file', percorso: 'guida.md' }])
  assert.equal(file.voci[0].testo, 'Da fare')
  assert.deepEqual(file.legami, [])

  const commit = db.oggetto(`commit:${v.commit}`)!
  assert.deepEqual([commit.titolo, commit.provenienza.certezza, commit.destinazione], ['Secondo commit', 'certo', { t: 'commit', hash: v.commit }])

  const ramo = db.oggetto('ref:locale:master')!
  assert.deepEqual([ramo.titolo, ramo.destinazione], ['master', { t: 'branch', nome: 'master' }])

  const f = db.mappa().funzioni[0]
  const funzione = db.oggetto(f.id)!
  assert.equal(funzione.provenienza.certezza, 'dedotto')
  assert.match(funzione.provenienza.testo, /claude-x.*may be wrong/)
  assert.match(funzione.dati.map((d) => d[1]).join(' '), /invalid/)
  assert.deepEqual(funzione.destinazione, { t: 'funzione', id: f.id })

  const att = db.aggiungiAttivita('Sistemare F')
  db.collega(att, f.id, 'riguarda', 'utente', 'verificato')
  assert.deepEqual(db.oggetto(f.id)!.legami.map((l) => [l.titolo, l.verso]), [['Sistemare F', 'entrante']])
  assert.equal(db.oggetto(att)!.destinazione, null)
  assert.deepEqual(db.oggetto(att)!.legami.map((l) => l.titolo), ['F'])

  db.funzioneNonTrovata(f.id, v, 'Cercato ovunque', 'claude-x')
  assert.equal(db.oggetto(f.id)!.provenienza.certezza, 'non-disponibile')

  for (const assente of ['file:nessuno', 'commit:nessuno', 'ref:locale:nessuno', 'funzione:nessuna', 'attivita:nessuna', 'inventato', '']) assert.equal(db.oggetto(assente), null, assente)
  // I risultati appartengono solo a questo archivio.
  assert.deepEqual(new Archivio(':memory:').cerca('guida'), [])
})
