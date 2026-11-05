import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { t } from '../shared/i18n.ts'
import type { Archivio, Lavoro } from './archivio.ts'
import { DIVIETI_SEGRETI, findClaude, type Comando } from './chat.ts'
import { normalizza, type EventoMotore } from './eventi.ts'
import { git, SEGRETO } from './scansione.ts'

const run = promisify(execFile)
const TEMPO_MASSIMO = 20 * 60 * 1000
const MAX_ESITO = 1024 * 1024
// Misurato il 5/11/2026 sulla Revisione: 32 difetti su 32 contro 31 dell'alias, senza segnalazioni inutili, più veloce e non più caro.
export const MODELLO_REVISIONE = 'claude-sonnet-5-5'
const MODELLO_RIPIEGO = 'sonnet'
// Un piano può non avere quel modello: Claude Code lo dice subito e senza consumare nulla.
export const modelloNonDisponibile = (errore: string | null | undefined): boolean => /issue with the selected model|may not have access to it|credits required/i.test(errore ?? '')

// Provata contro scrittura, comandi, segreti e cartelle esterne. Nessun lavoro automatico ha Bash, e gira su una copia pulita.
export function argsSolaLettura(modello: string): string[] {
  return ['-p', '--model', modello, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--tools', 'Read,Glob,Grep', '--settings', JSON.stringify({ permissions: { deny: DIVIETI_SEGRETI } })]
}

// La copia viene dal commit, quindi senza modifiche in corso. Segreti e collegamenti non vengono nemmeno estratti.
export async function copiaPulita(repo: string, segnale?: AbortSignal, rev = 'HEAD'): Promise<{ cartella: string; commit: string }> {
  const commit = (await git(repo, 'rev-parse', '--verify', `${rev}^{commit}`)).trim()
  const esclusi = (await git(repo, 'ls-tree', '-r', '-z', commit)).split('\0').filter(Boolean).flatMap((voce) => {
    const tab = voce.indexOf('\t')
    const percorso = voce.slice(tab + 1)
    return voce.startsWith('120000 ') || SEGRETO.test(basename(percorso)) ? [`:(exclude,literal)${percorso}`] : []
  })
  const cartella = await mkdtemp(join(tmpdir(), 'hub-lavoro-'))
  // Il tar di Windows, non quello di Git Bash che scambierebbe C: per un host remoto.
  const tarExe = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  try {
    const archivio = spawn('git', ['archive', '--format=tar', commit, '--', '.', ...esclusi], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, signal: segnale })
    const tar = spawn(tarExe, ['-x', '-f', '-', '-C', cartella], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, signal: segnale })
    const uscita = (p: typeof archivio | typeof tar): Promise<number | null> => new Promise((ok) => {
      p.on('error', () => ok(null))
      p.on('close', (c) => ok(c))
    })
    archivio.stdout.on('error', () => {})
    tar.stdin.on('error', () => {})
    archivio.stdout.pipe(tar.stdin)
    // Se uno dei due fallisce l'altro non deve restare appeso, e valgono entrambi i codici: un archivio tagliato non è una copia.
    const [daGit, daTar] = await Promise.all([uscita(archivio).then((c) => { if (c !== 0) tar.kill(); return c }), uscita(tar).then((c) => { if (c !== 0) archivio.kill(); return c })])
    if (daGit !== 0 || daTar !== 0) throw new Error(t('job.copyFailed'))
  } catch (e) {
    await rm(cartella, { recursive: true, force: true })
    throw e
  }
  return { cartella, commit }
}

// ponytail: una copia lasciata da un crash resta fino al primo avvio dopo un giorno; basta perché un lavoro dura al massimo minuti.
export async function pulisciCopieVecchie(adesso = Date.now()): Promise<void> {
  const nomi = await readdir(tmpdir()).catch(() => [] as string[])
  await Promise.all(nomi.filter((n) => n.startsWith('hub-lavoro-')).map(async (n) => {
    const dove = join(tmpdir(), n)
    const info = await stat(dove).catch(() => null)
    if (info && adesso - info.mtimeMs > 24 * 60 * 60 * 1000) await rm(dove, { recursive: true, force: true }).catch(() => {})
  }))
}

const chiudiAlbero = (pid: number): Promise<unknown> => run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {})

// L'ora esatta di creazione distingue un processo da un altro che ha ricevuto lo stesso PID, anche se si chiama allo stesso modo.
async function identita(pid: number): Promise<number | null> {
  const uscita = await run('powershell', ['-NoProfile', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`], { windowsHide: true }).catch(() => ({ stdout: '' }))
  const creato = Number(uscita.stdout.trim())
  return uscita.stdout.trim() && Number.isFinite(creato) ? creato : null
}

type Attivo = { id: string; proc: ChildProcessWithoutNullStreams | null; motivo: 'annullato' | 'scaduto' | 'interrotto' | null; stop: AbortController }
type Opzioni = { comando?: () => Promise<Comando>; avvisa?: (id: string, evento: EventoMotore | null) => void; copia?: typeof copiaPulita }

// Un lavoro alla volta per repo. Dopo un riavvio niente riparte da solo: ogni rilancio consuma il piano, quindi lo decide l'utente.
export class Lavori {
  private attivo: Attivo | null = null
  private attese = new Set<() => void>()
  private finito: Promise<void> = Promise.resolve()
  private comando: () => Promise<Comando>
  private copia: typeof copiaPulita
  private avvisa: (id: string, evento: EventoMotore | null) => void
  private db: Archivio
  private repo: string

  private constructor(db: Archivio, repo: string, opzioni: Opzioni) {
    this.db = db
    this.repo = repo
    this.comando = opzioni.comando ?? (async () => ({ exe: await findClaude(), args: [] }))
    this.avvisa = opzioni.avvisa ?? (() => {})
    this.copia = opzioni.copia ?? copiaPulita
  }

  static async apri(db: Archivio, repo: string, opzioni: Opzioni = {}): Promise<Lavori> {
    const lavori = new Lavori(db, repo, opzioni)
    await pulisciCopieVecchie()
    // Prima si segnano tutti, così nulla può partire mentre si chiude ciò che è rimasto.
    const rimasti = db.lavori().filter((l) => l.stato === 'in-corso' || l.stato === 'in-coda')
    for (const l of rimasti) db.aggiornaLavoro(l.id, { stato: 'interrotto', fine: Date.now(), pid: null, pid_avvio: null })
    for (const l of rimasti) {
      // Se l'identità non era stata ancora registrata il processo non si tocca: meglio uno rimasto che chiuderne uno altrui.
      if (l.stato === 'in-corso' && l.pid && l.pid_avvio && (await identita(l.pid)) === l.pid_avvio) await chiudiAlbero(l.pid)
    }
    return lavori
  }

  // Con un commit, il lavoro legge proprio quello: più lavori dello stesso ricavo vedono lo stesso codice anche se intanto arrivano commit nuovi.
  accoda(titolo: string, prompt: string, modello = 'sonnet', tempoMassimo = TEMPO_MASSIMO, commit?: string): string {
    const id = this.db.aggiungiLavoro(titolo, prompt, modello, tempoMassimo)
    if (commit) this.db.aggiornaLavoro(id, { commit_hash: commit })
    this.prossimo()
    return id
  }

  // Si risolve quando il lavoro è arrivato a uno stato finale, qualunque sia.
  attendi(id: string): Promise<Lavoro> {
    return new Promise((ok, ko) => {
      const prova = (): void => {
        const l = this.db.lavoro(id)
        if (!l) return ko(new Error(t('job.unknown')))
        if (l.stato !== 'in-coda' && l.stato !== 'in-corso') return ok(l)
        this.attese.add(prova)
      }
      prova()
    })
  }

  // Revisione e correzioni usano il modello misurato; se il piano non ce l'ha, si riprova una volta con quello predefinito.
  async revisiona(titolo: string, prompt: string, commit?: string): Promise<Lavoro> {
    const l = await this.attendi(this.accoda(titolo, prompt, MODELLO_REVISIONE, TEMPO_MASSIMO, commit))
    if (l.stato !== 'errore' || !modelloNonDisponibile(l.errore)) return l
    return this.attendi(this.accoda(titolo, prompt, MODELLO_RIPIEGO, TEMPO_MASSIMO, commit))
  }

  private sveglia(): void {
    const attese = [...this.attese]
    this.attese.clear()
    for (const prova of attese) prova()
  }

  rilancia(id: string): string {
    const l = this.db.lavoro(id)
    if (!l || l.stato === 'in-coda' || l.stato === 'in-corso') throw new Error(t('job.cannotRerun'))
    return this.accoda(l.titolo, l.prompt, l.modello, l.tempo_massimo)
  }

  async annulla(id: string): Promise<void> {
    const l = this.db.lavoro(id)
    if (l?.stato === 'in-coda') {
      this.db.aggiornaLavoro(id, { stato: 'annullato', fine: Date.now() })
      this.avvisa(id, null)
      this.sveglia()
    } else if (this.attivo?.id === id) {
      await this.ferma('annullato')
    }
  }

  // Alla chiusura di Hub: il lavoro in corso si ferma e risulta interrotto, quelli in coda restano fermi anche loro.
  async chiudi(): Promise<void> {
    for (const l of this.db.lavori()) if (l.stato === 'in-coda') this.db.aggiornaLavoro(l.id, { stato: 'interrotto', fine: Date.now() })
    this.sveglia()
    await this.ferma('interrotto')
  }

  // Aspetta che il lavoro corrente abbia finito davvero e registrato l'esito.
  fine(): Promise<void> {
    return this.finito
  }

  private async ferma(motivo: NonNullable<Attivo['motivo']>): Promise<void> {
    const a = this.attivo
    if (!a) return
    await this.arresta(a, motivo)
    await this.finito
  }

  // Vale in ogni fase: durante la copia ferma git e tar, dopo chiude Claude e tutto ciò che ha lanciato.
  private async arresta(a: Attivo, motivo: NonNullable<Attivo['motivo']>): Promise<void> {
    a.motivo ??= motivo
    a.stop.abort()
    if (a.proc?.pid) await chiudiAlbero(a.proc.pid)
  }

  private prossimo(): void {
    if (this.attivo) return
    const l = this.db.lavori().find((x) => x.stato === 'in-coda')
    if (!l) return
    const attivo: Attivo = { id: l.id, proc: null, motivo: null, stop: new AbortController() }
    this.attivo = attivo
    const scadenza = setTimeout(() => void this.arresta(attivo, 'scaduto'), l.tempo_massimo)
    this.finito = this.esegui(l).catch((e) => {
      // Un arresto voluto durante la preparazione non è un errore del lavoro.
      this.db.aggiornaLavoro(l.id, { stato: attivo.motivo ?? 'errore', fine: Date.now(), pid: null, pid_avvio: null, errore: attivo.motivo ? null : e instanceof Error ? e.message : String(e) })
    }).then(() => {
      clearTimeout(scadenza)
      const motivo = this.attivo?.motivo
      this.attivo = null
      this.avvisa(l.id, null)
      this.sveglia()
      if (motivo !== 'interrotto') this.prossimo()
    })
  }

  private async esegui(l: Lavoro): Promise<void> {
    const attivo = this.attivo!
    const inizio = Date.now()
    this.db.aggiornaLavoro(l.id, { stato: 'in-corso', inizio })
    this.avvisa(l.id, null)
    const { cartella, commit } = await this.copia(this.repo, attivo.stop.signal, l.commit_hash ?? 'HEAD')
    try {
      const { exe, args } = await this.comando()
      if (attivo.motivo) {
        this.db.aggiornaLavoro(l.id, { stato: attivo.motivo, fine: Date.now(), commit_hash: commit })
        return
      }
      const proc = spawn(exe, [...args, ...argsSolaLettura(l.modello)], { cwd: cartella, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      attivo.proc = proc
      this.db.aggiornaLavoro(l.id, { pid: proc.pid ?? null, commit_hash: commit })
      if (proc.pid) void identita(proc.pid).then((creato) => {
        if (attivo.proc === proc && proc.exitCode === null && creato) this.db.aggiornaLavoro(l.id, { pid_avvio: creato })
      }).catch(() => {})
      await this.segui(l, attivo, proc, inizio)
    } finally {
      await rm(cartella, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
    }
  }

  private segui(l: Lavoro, attivo: Attivo, proc: ChildProcessWithoutNullStreams, inizio: number): Promise<void> {
    return new Promise((ok) => {
      let buffer = ''
      let stderr = ''
      let esito: Extract<EventoMotore, { tipo: 'fine' }> | null = null
      proc.stdout.setEncoding('utf8')
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (d: string) => { stderr = (stderr + d).slice(-2000) })
      proc.stdout.on('data', (d: string) => {
        buffer += d
        let i: number
        while ((i = buffer.indexOf('\n')) >= 0) {
          const riga = buffer.slice(0, i).trim()
          buffer = buffer.slice(i + 1)
          if (!riga) continue
          let dati: unknown
          try { dati = JSON.parse(riga) } catch { continue }
          for (const evento of normalizza(dati)) {
            if (evento.tipo === 'fine') esito = evento
            this.avvisa(l.id, evento)
          }
        }
      })
      proc.stdin.on('error', () => {})
      proc.stdin.end(l.prompt)
      let chiuso = false
      const chiudi = (errore: string | null): void => {
        if (chiuso) return
        chiuso = true
        // Un avvio successivo può averlo già segnato interrotto: l'esito finale non si riscrive.
        if (this.db.lavoro(l.id)?.stato !== 'in-corso') return ok()
        const e = esito as Extract<EventoMotore, { tipo: 'fine' }> | null
        const stato = attivo.motivo ?? (errore || !e || e.errore ? 'errore' : 'finito')
        const testoErrore = stato !== 'errore' ? null : errore ?? (e ? e.testo || e.esito : stderr.trim() || t('job.noResult'))
        const fine = Date.now()
        this.db.aggiornaLavoro(l.id, { stato, fine, durata: fine - inizio, pid: null, pid_avvio: null, esito: e?.testo.slice(0, MAX_ESITO) ?? null, errore: testoErrore, costo: e?.costo ?? null, turni: e?.turni ?? null, token_entrata: e?.tokenEntrata ?? null, token_uscita: e?.tokenUscita ?? null })
        ok()
      }
      proc.on('error', (e) => chiudi(t('chat.notStarted', { error: e.message })))
      proc.on('close', () => chiudi(null))
    })
  }
}
