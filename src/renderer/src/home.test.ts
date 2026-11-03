import assert from 'node:assert/strict'
import test from 'node:test'
import { riassumiHome, ultimaVisita, type DatiHome } from './home.ts'

const commit = (hash: string, time: number) => ({ hash, parents: [], refs: [], author: 'A', time, subject: hash })
const branch = (nome: string, avanti: number, data = '2026-01-01', upstreamAvanti = 0) => ({ nome, avanti, indietro: 0, upstream: null, upstreamAvanti, upstreamIndietro: 0, upstreamSparito: false, data })
const worktree = (path: string, nome: string | null, modificati = 0, nuovi = 0, manca = false) => ({ path, branch: nome, head: 'h', modificati, nuovi, manca, errore: false })
const dati = (d: Partial<DatiHome> = {}): DatiHome => ({
  status: { base: 'main', worktree: [], branch: [], github: null, sessioni: [], illeggibili: 0 },
  commit: [], todo: [], documenti: [], lavori: [], visto: 100, ...d
})

test('mostra i commit dopo l\'ultima visita, i più recenti e quanti altri ce ne sono', () => {
  const r = riassumiHome(dati({ visto: 100, commit: [50, 150, 200, 300, 400, 500, 600, 700].map((t) => commit(`c${t}`, t)) }))
  assert.deepEqual(r.nuovi.map((c) => c.hash), ['c700', 'c600', 'c500', 'c400', 'c300'])
  assert.equal(r.altriNuovi, 2)
  assert.equal(r.primaVolta, false)
  assert.deepEqual(riassumiHome(dati({ visto: 900, commit: [commit('a', 100)] })).nuovi, [])
})

test('la prima volta mostra gli ultimi commit senza contarli come novità', () => {
  const r = riassumiHome(dati({ visto: null, commit: [commit('a', 1), commit('b', 2)] }))
  assert.equal(r.primaVolta, true)
  assert.deepEqual(r.nuovi.map((c) => c.hash), ['b', 'a'])
  assert.equal(r.altriNuovi, 0)
})

test('solo i worktree con modifiche, e nessuno che non esiste più', () => {
  const status = { ...dati().status, worktree: [worktree('a', 'main'), worktree('b', 'lavoro', 2, 1), worktree('c', null, 1), worktree('d', 'via', 5, 0, true)] }
  assert.deepEqual(riassumiHome(dati({ status })).worktree, [{ path: 'b', nome: 'lavoro', modifiche: 3 }, { path: 'c', nome: 'No branch', modifiche: 1 }])
})

test('i branch non includono la base né quelli già uniti, e prima vengono quelli aperti', () => {
  const status = { ...dati().status, worktree: [worktree('w', 'aperto')], branch: [branch('main', 9), branch('unito', 0), branch('nuovo', 1, '2026-06-01'), branch('aperto', 2, '2026-01-01'), branch('remoto', 0, '2026-02-01', 3)] }
  assert.deepEqual(riassumiHome(dati({ status })).branch.map((b) => b.nome), ['aperto', 'nuovo', 'remoto'])
  const tanti = { ...dati().status, branch: Array.from({ length: 8 }, (_, i) => branch(`b${i}`, 1)) }
  const r = riassumiHome(dati({ status: tanti }))
  assert.deepEqual([r.branch.length, r.altriBranch], [5, 3])
})

test('lavori, sessioni e to do', () => {
  const status = { ...dati().status, sessioni: [
    { id: 's', nome: 'Sessione', cwd: 'x', stato: 'busy', origine: 'o', aggiornata: 1, subagenti: [{ id: 'a', descrizione: 'd', tipo: 't', attivo: true, attivita: 1 }, { id: 'b', descrizione: 'd', tipo: 't', attivo: false, attivita: 0 }] },
    { id: 'i', nome: 'Ferma', cwd: 'x', stato: 'idle', origine: 'o', aggiornata: 1, subagenti: [] }
  ] }
  const todo = ['uno', 'due', 'tre', 'quattro'].map((testo, i) => ({ id: String(i), testo, fatta: false, creata: '' }))
  todo.push({ id: 'f', testo: 'fatta', fatta: true, creata: '' })
  const r = riassumiHome(dati({ status, todo, documenti: [{ file: 'a.md', riga: 1, testo: 'x' }], lavori: [{ id: '1', titolo: 'Corre', stato: 'in-corso' }, { id: '2', titolo: 'Finito', stato: 'finito' }, { id: '3', titolo: 'Fila', stato: 'in-coda' }] }))
  // Una sessione in attesa non è "in corso".
  assert.deepEqual(r.sessioni, [{ id: 's', nome: 'Sessione', subagenti: 1 }])
  assert.equal(r.sessioniInAttesa, 1)
  assert.deepEqual(r.lavori.map((l) => l.titolo), ['Corre', 'Fila'])
  assert.deepEqual(r.todo, { aperte: 4, prime: ['uno', 'due', 'tre'], neiDocumenti: 1 })
})

test('tornare sulla Home nella stessa sessione non azzera le novità', async () => {
  let letture = 0
  const leggi = async (): Promise<number | null> => (++letture === 1 ? 100 : Date.now())
  assert.equal(await ultimaVisita('repo-a', leggi), 100)
  assert.equal(await ultimaVisita('repo-a', leggi), 100)
  assert.equal(letture, 1)
  assert.equal(await ultimaVisita('repo-nuova', async () => null), null)
  assert.equal(await ultimaVisita('repo-nuova', async () => 5), null)
})

test('due letture insieme segnano la visita una volta sola, e un errore non resta in memoria', async () => {
  let letture = 0
  const leggi = async (): Promise<number | null> => {
    letture++
    await new Promise((r) => setTimeout(r, 5))
    return 100 + letture
  }
  assert.deepEqual(await Promise.all([ultimaVisita('repo-insieme', leggi), ultimaVisita('repo-insieme', leggi)]), [101, 101])
  assert.equal(letture, 1)
  await assert.rejects(ultimaVisita('repo-errore', async () => { throw new Error('x') }))
  await new Promise((r) => setTimeout(r, 1))
  assert.equal(await ultimaVisita('repo-errore', async () => 7), 7)
})

test('senza commit nuovi la Home mostra comunque gli ultimi', () => {
  const r = riassumiHome(dati({ visto: 900, commit: [100, 300, 200].map((t) => commit(`c${t}`, t)) }))
  assert.deepEqual([r.nuovi, r.recenti.map((c) => c.hash)], [[], ['c300', 'c200', 'c100']])
  assert.deepEqual(riassumiHome(dati({ visto: 150, commit: [commit('a', 100), commit('b', 200)] })).recenti, [])
})
