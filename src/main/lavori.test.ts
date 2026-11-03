import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Archivio } from './archivio.ts'
import { argsSolaLettura, copiaPulita, Lavori, pulisciCopieVecchie } from './lavori.ts'

// Un finto Claude: legge il prompt e si comporta come dice, senza consumare il piano.
const FINTO = `
import { spawn } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
let prompt = ''
process.stdin.on('data', (d) => (prompt += d))
process.stdin.on('end', () => {
  const dati = JSON.parse(prompt)
  const scrivi = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
  if (dati.traccia) writeFileSync(dati.traccia, JSON.stringify({ pid: process.pid, cwd: process.cwd(), file: readdirSync('.'), args: process.argv.slice(2) }))
  scrivi({ type: 'system', subtype: 'init', session_id: 's', model: 'finto' })
  if (dati.fai === 'aspetta') {
    const figlio = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
    if (dati.traccia) writeFileSync(dati.traccia, JSON.stringify({ pid: process.pid, figlio: figlio.pid, cwd: process.cwd(), file: readdirSync('.') }))
    setTimeout(() => {}, 120000)
    return
  }
  if (dati.fai === 'muori') { console.error('qualcosa di storto'); process.exit(3) }
  scrivi({ type: 'result', subtype: dati.fai === 'errore' ? 'error_max_turns' : 'success', is_error: dati.fai === 'errore', result: 'Risultato di ' + dati.nome, total_cost_usd: 0.5, num_turns: 2, usage: { input_tokens: 10, output_tokens: 20 } })
})
`

function ambiente(): { repo: string; db: Archivio; comando: () => Promise<{ exe: string; args: string[] }>; cartella: string; file: string } {
  const repo = mkdtempSync(join(tmpdir(), 'hub-lav-'))
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'user.name=P', '-c', 'user.email=p@p', ...a], { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
  git('init', '-q', '-b', 'master')
  writeFileSync(join(repo, 'a.txt'), 'a')
  writeFileSync(join(repo, '.env'), 'SEGRETO=finto')
  writeFileSync(join(repo, 'chiave.key'), 'finto')
  git('add', '.')
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'C:/Windows/win.ini', encoding: 'utf8' }).trim()
  git('update-index', '--add', '--cacheinfo', `120000,${blob},collegamento`)
  git('commit', '-qm', 'primo')
  git('reset', '-q', '--hard')
  writeFileSync(join(repo, 'in-corso.txt'), 'non committato')
  const cartella = mkdtempSync(join(tmpdir(), 'hub-finto-'))
  writeFileSync(join(cartella, 'finto.mjs'), FINTO)
  const file = join(cartella, 'hub.db')
  return { repo, db: new Archivio(file), comando: async () => ({ exe: process.execPath, args: [join(cartella, 'finto.mjs')] }), cartella, file }
}

const vivo = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const aspetta = async (fatto: () => boolean, ms = 8000): Promise<void> => {
  const t = Date.now()
  while (!fatto()) {
    if (Date.now() - t > ms) throw new Error('Tempo scaduto in attesa')
    await new Promise((r) => setTimeout(r, 30))
  }
}

test('la copia pulita viene dal commit, senza segreti né collegamenti', async () => {
  const { repo } = ambiente()
  const { cartella, commit } = await copiaPulita(repo)
  assert.deepEqual(readdirSync(cartella), ['a.txt'])
  assert.equal(commit.length, 40)
  rmSync(cartella, { recursive: true, force: true })
  assert.deepEqual(readdirSync(repo).sort().filter((f) => f === 'in-corso.txt'), ['in-corso.txt'])
})

test('una repo senza commit dà un errore invece di una copia vuota', async () => {
  const vuota = mkdtempSync(join(tmpdir(), 'hub-vuota-'))
  execFileSync('git', ['init', '-q'], { cwd: vuota })
  await assert.rejects(copiaPulita(vuota))
})

test('la ricetta di sola lettura non consente strumenti in più', () => {
  const a = argsSolaLettura('haiku')
  assert.equal(a[a.indexOf('--tools') + 1], 'Read,Glob,Grep')
  assert.equal(a[a.indexOf('--setting-sources') + 1], '')
  assert.ok(!a.includes('--allowedTools'))
  assert.ok(!a.includes('--chrome'))
  assert.match(a[a.indexOf('--settings') + 1], /\.env/)
})

test('un lavoro gira sulla copia, registra consumo e durata, e la copia sparisce', async () => {
  const { repo, db, comando, cartella } = ambiente()
  const traccia = join(cartella, 'traccia.json')
  const avvisi: string[] = []
  const lavori = await Lavori.apri(db, repo, { comando, avvisa: (_id, e) => void (e && avvisi.push(e.tipo)) })
  const id = lavori.accoda('Prova', JSON.stringify({ traccia, nome: 'uno' }))
  await lavori.fine()
  const l = db.lavoro(id)!
  assert.deepEqual([l.stato, l.esito, l.costo, l.turni, l.token_entrata, l.token_uscita, l.pid], ['finito', 'Risultato di uno', 0.5, 2, 10, 20, null])
  assert.ok(l.durata! > 0)
  assert.equal(l.commit_hash?.length, 40)
  const t = JSON.parse(readFileSync(traccia, 'utf8'))
  assert.deepEqual(t.file, ['a.txt'])
  assert.notEqual(t.cwd, repo)
  assert.ok(!existsSync(t.cwd), 'la copia deve sparire')
  assert.deepEqual(avvisi, ['avvio', 'fine'])
})

test('i lavori passano uno alla volta, nell\'ordine', async () => {
  const { repo, db, comando } = ambiente()
  const lavori = await Lavori.apri(db, repo, { comando })
  const uno = lavori.accoda('Uno', JSON.stringify({ fai: 'aspetta' }))
  const due = lavori.accoda('Due', JSON.stringify({ nome: 'due' }))
  await aspetta(() => db.lavoro(uno)!.pid !== null)
  assert.deepEqual([db.lavoro(uno)!.stato, db.lavoro(due)!.stato], ['in-corso', 'in-coda'])
  await lavori.annulla(uno)
  assert.equal(db.lavoro(uno)!.stato, 'annullato')
  await aspetta(() => db.lavoro(due)!.stato === 'finito')
})

test('annullare chiude tutto l\'albero dei processi', async () => {
  const { repo, db, comando, cartella } = ambiente()
  const traccia = join(cartella, 'traccia.json')
  const lavori = await Lavori.apri(db, repo, { comando })
  const id = lavori.accoda('Lungo', JSON.stringify({ fai: 'aspetta', traccia }))
  await aspetta(() => existsSync(traccia) && 'figlio' in JSON.parse(readFileSync(traccia, 'utf8')))
  const { pid, figlio, cwd } = JSON.parse(readFileSync(traccia, 'utf8'))
  await lavori.annulla(id)
  assert.equal(db.lavoro(id)!.stato, 'annullato')
  await aspetta(() => !vivo(pid) && !vivo(figlio))
  await aspetta(() => !existsSync(cwd))
})

test('annullare un lavoro in coda non lo fa partire', async () => {
  const { repo, db, comando } = ambiente()
  const lavori = await Lavori.apri(db, repo, { comando })
  const uno = lavori.accoda('Uno', JSON.stringify({ fai: 'aspetta' }))
  const due = lavori.accoda('Due', JSON.stringify({ nome: 'due' }))
  await lavori.annulla(due)
  assert.equal(db.lavoro(due)!.stato, 'annullato')
  await lavori.annulla(uno)
  assert.equal(db.lavoro(due)!.inizio, null)
})

test('il tempo massimo chiude il lavoro', async () => {
  const { repo, db, comando } = ambiente()
  const lavori = await Lavori.apri(db, repo, { comando })
  const id = lavori.accoda('Lungo', JSON.stringify({ fai: 'aspetta' }), 'sonnet', 1500)
  await lavori.fine()
  assert.equal(db.lavoro(id)!.stato, 'scaduto')
  assert.equal(db.lavoro(id)!.pid, null)
})

test('un errore di Claude e una chiusura improvvisa risultano errori con il motivo', async () => {
  const { repo, db, comando } = ambiente()
  const lavori = await Lavori.apri(db, repo, { comando })
  const a = lavori.accoda('A', JSON.stringify({ fai: 'errore', nome: 'a' }))
  await lavori.fine()
  assert.deepEqual([db.lavoro(a)!.stato, db.lavoro(a)!.errore, db.lavoro(a)!.costo], ['errore', 'Risultato di a', 0.5])
  const b = lavori.accoda('B', JSON.stringify({ fai: 'muori' }))
  await lavori.fine()
  assert.deepEqual([db.lavoro(b)!.stato, db.lavoro(b)!.errore], ['errore', 'qualcosa di storto'])
})

test('un programma che non parte è un errore, non un lavoro appeso', async () => {
  const { repo, db } = ambiente()
  const lavori = await Lavori.apri(db, repo, { comando: async () => ({ exe: 'C:\\non-esiste\\claude.exe', args: [] }) })
  const id = lavori.accoda('A', '{}')
  await lavori.fine()
  assert.equal(db.lavoro(id)!.stato, 'errore')
  assert.match(db.lavoro(id)!.errore!, /didn't start/)
})

test('una repo senza commit fa fallire il lavoro con un errore', async () => {
  const vuota = mkdtempSync(join(tmpdir(), 'hub-vuota-'))
  execFileSync('git', ['init', '-q'], { cwd: vuota })
  const { db, comando } = ambiente()
  const lavori = await Lavori.apri(db, vuota, { comando })
  const id = lavori.accoda('A', '{}')
  await lavori.fine()
  assert.equal(db.lavoro(id)!.stato, 'errore')
})

test('dopo un crash niente riparte da solo: i lavori risultano interrotti e il processo rimasto si chiude', async () => {
  const { repo, db, comando, cartella, file } = ambiente()
  const traccia = join(cartella, 'traccia.json')
  const prima = await Lavori.apri(db, repo, { comando })
  const lungo = prima.accoda('Lungo', JSON.stringify({ fai: 'aspetta', traccia }))
  const fermo = prima.accoda('Fermo', JSON.stringify({ nome: 'fermo' }))
  await aspetta(() => existsSync(traccia) && 'figlio' in JSON.parse(readFileSync(traccia, 'utf8')) && db.lavoro(lungo)!.pid_avvio !== null)
  const { pid, figlio } = JSON.parse(readFileSync(traccia, 'utf8'))

  // Come se Hub fosse morta di colpo: un secondo avvio trova il lavoro ancora "in corso".
  const dopo = new Archivio(file)
  const riaperti = await Lavori.apri(dopo, repo, { comando })
  assert.deepEqual([dopo.lavoro(lungo)!.stato, dopo.lavoro(fermo)!.stato], ['interrotto', 'interrotto'])
  await aspetta(() => !vivo(pid) && !vivo(figlio))
  assert.equal(dopo.lavoro(fermo)!.inizio, null)

  const nuovo = riaperti.rilancia(fermo)
  await riaperti.fine()
  assert.notEqual(nuovo, fermo)
  assert.equal(dopo.lavoro(nuovo)!.stato, 'finito')
  assert.equal(dopo.lavoro(fermo)!.stato, 'interrotto')
  assert.throws(() => riaperti.rilancia('lavoro:nessuno'))
  await prima.fine().catch(() => {})
})

test('un PID riusato da un altro programma non viene chiuso', async () => {
  const { repo, db, comando, file } = ambiente()
  const lavori = await Lavori.apri(db, repo, { comando })
  const id = lavori.accoda('Vecchio', JSON.stringify({ fai: 'aspetta' }))
  await aspetta(() => db.lavoro(id)!.pid_avvio !== null)
  const pid = db.lavoro(id)!.pid!
  const vero = db.lavoro(id)!.pid_avvio!
  // Stesso PID e stesso nome, avviato appena un istante dopo: è un altro processo.
  db.aggiornaLavoro(id, { pid_avvio: vero + 1 })
  await Lavori.apri(new Archivio(file), repo, { comando })
  assert.equal(vivo(pid), true)
  await lavori.annulla(id)
  assert.equal(vivo(pid), false)
})

test('chiudere Hub ferma il lavoro in corso e lascia ferma la coda', async () => {
  const { repo, db, comando } = ambiente()
  const lavori = await Lavori.apri(db, repo, { comando })
  const uno = lavori.accoda('Uno', JSON.stringify({ fai: 'aspetta' }))
  const due = lavori.accoda('Due', JSON.stringify({ nome: 'due' }))
  await aspetta(() => db.lavoro(uno)!.pid !== null)
  const pid = db.lavoro(uno)!.pid!
  await lavori.chiudi()
  assert.deepEqual([db.lavoro(uno)!.stato, db.lavoro(due)!.stato, db.lavoro(due)!.inizio, vivo(pid)], ['interrotto', 'interrotto', null, false])
})

test('un processo di cui non si conosce ancora l\'identità non viene chiuso', async () => {
  const { repo, db, comando, file } = ambiente()
  const lavori = await Lavori.apri(db, repo, { comando })
  const id = lavori.accoda('Vecchio', JSON.stringify({ fai: 'aspetta' }))
  await aspetta(() => db.lavoro(id)!.pid_avvio !== null)
  const pid = db.lavoro(id)!.pid!
  db.aggiornaLavoro(id, { pid_avvio: null })
  const altro = new Archivio(file)
  await Lavori.apri(altro, repo, { comando })
  assert.equal(altro.lavoro(id)!.stato, 'interrotto')
  assert.equal(vivo(pid), true)
  await lavori.annulla(id)
  assert.equal(vivo(pid), false)
})

test('un archivio git rotto non diventa una copia incompleta', async () => {
  const { repo } = ambiente()
  const blob = execFileSync('git', ['rev-parse', 'HEAD:a.txt'], { cwd: repo, encoding: 'utf8' }).trim()
  rmSync(join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true })
  const prima = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith('hub-lavoro-')))
  await assert.rejects(copiaPulita(repo), /failed/)
  assert.deepEqual(readdirSync(tmpdir()).filter((f) => f.startsWith('hub-lavoro-') && !prima.has(f)), [])
})

test('una copia fermata a metà sparisce e dà errore', async () => {
  const { repo } = ambiente()
  const stop = new AbortController()
  stop.abort()
  const prima = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith('hub-lavoro-')))
  await assert.rejects(copiaPulita(repo, stop.signal), /failed/)
  assert.deepEqual(readdirSync(tmpdir()).filter((f) => f.startsWith('hub-lavoro-') && !prima.has(f)), [])
})

const copiaFerma = (avviata: () => void) => (_repo: string, segnale?: AbortSignal): Promise<never> =>
  new Promise((_ok, ko) => {
    avviata()
    segnale?.addEventListener('abort', () => ko(new Error('fermata')))
  })

test('si può annullare mentre la copia è in corso, senza far partire Claude', async () => {
  const { repo, db, comando } = ambiente()
  let avviata = false
  const lavori = await Lavori.apri(db, repo, { comando, copia: copiaFerma(() => { avviata = true }) })
  const id = lavori.accoda('Copia lenta', '{}')
  await aspetta(() => avviata)
  await lavori.annulla(id)
  assert.deepEqual([db.lavoro(id)!.stato, db.lavoro(id)!.errore, db.lavoro(id)!.pid], ['annullato', null, null])
})

test('il tempo massimo vale anche per la copia', async () => {
  const { repo, db, comando } = ambiente()
  const lavori = await Lavori.apri(db, repo, { comando, copia: copiaFerma(() => {}) })
  const id = lavori.accoda('Copia lenta', '{}', 'sonnet', 100)
  await lavori.fine()
  assert.deepEqual([db.lavoro(id)!.stato, db.lavoro(id)!.errore], ['scaduto', null])
})

test('chiudere Hub durante la copia lascia il lavoro interrotto', async () => {
  const { repo, db, comando } = ambiente()
  let avviata = false
  const lavori = await Lavori.apri(db, repo, { comando, copia: copiaFerma(() => { avviata = true }) })
  const id = lavori.accoda('Copia lenta', '{}')
  await aspetta(() => avviata)
  await lavori.chiudi()
  assert.equal(db.lavoro(id)!.stato, 'interrotto')
})

test('le copie lasciate da un crash spariscono dopo un giorno, quelle recenti restano', async () => {
  const vecchia = mkdtempSync(join(tmpdir(), 'hub-lavoro-prova-'))
  const recente = mkdtempSync(join(tmpdir(), 'hub-lavoro-prova-'))
  const altra = mkdtempSync(join(tmpdir(), 'hub-altro-prova-'))
  const dueGiorniFa = new Date(Date.now() - 48 * 60 * 60 * 1000)
  for (const d of [vecchia, altra]) utimesSync(d, dueGiorniFa, dueGiorniFa)
  await pulisciCopieVecchie()
  assert.deepEqual([existsSync(vecchia), existsSync(recente), existsSync(altra)], [false, true, true])
  rmSync(recente, { recursive: true, force: true })
  rmSync(altra, { recursive: true, force: true })
})
