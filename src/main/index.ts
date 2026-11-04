import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, unwatchFile, watch, watchFile, type FSWatcher } from 'node:fs'
import { homedir, release } from 'node:os'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import { promisify } from 'node:util'
import { lingua, linguaDaLocale, setLingua, t, type Chiave, type Lingua } from '../shared/i18n.ts'
import { readAgents } from './agents'
import { Archivio, statoVersione } from './archivio'
import { Lavori } from './lavori'
import { contesto, estraiJson, lettoreDaCommit, Ricavo } from './mappa'
import { Chats, readHistory, readRecent, saveRecent, type Decision } from './chat'
import { readBranch, readBranchDiff, readCommit, readCommitDiff, readGraph, readWorktreeChanges, readWorktreeDiff } from './gitnav'
import { addRepo, isKnown, listRepos, removeRepo, setActive } from './repos'
import { nextDelay, readSocial, refreshSocial, sessionPrompt, setSocialInterval, startEmulator } from './social'
import { datiVecchiDisponibili, importaDatiVecchi, Pianificatore, propostaSocial, SOCIAL_VUOTO, validaSocial, type ConfigSocial } from './moduli'
import { applyChallenge, buildChallenge, buildPrompt, findRelated, needsChallenge, prepare, scanLines, todoKey, todoText, verify, type Prepared, type Report, type Scope } from './review'
import { applyEdits, buildFixPrompt, fileHash, parseProposal } from './fix'
import { diagnosticReport } from './diagnostica'
import { findClaude } from './chat'
import { visita } from './doctor'
import { branoFile, cercaNelCodice } from './ricercaCodice'
import { dentroLaRepo, git, leggiTesto, SEGRETO, sorvegliaGit } from './scansione'
import { githubUrl, listWorktreePaths, readStatus } from './status'
import { addTodo, excludeFromGit, readTodos, removeTodo, restoreTodo, safeDocPath, scanDocs, todoPath, updateTodo, type Todo } from './todo'

const MAX_TEXT = 2000
let win: BrowserWindow | null = null
let watched: string | null = null

let statusWatchers: FSWatcher[] = []
let statusTimer: NodeJS.Timeout | undefined

const run = promisify(execFile)
const claudeDir = join(homedir(), '.claude')
// Enough to undo while the app is open and the file is as we left it; after that, git is the way back.
const primaDellaCorrezione = new Map<string, { testo: string; dopo: string }>()
const reposFile = (): string => join(app.getPath('userData'), 'repos.json')
const linguaFile = (): string => join(app.getPath('userData'), 'lingua.json')
const leggiLingua = async (): Promise<Lingua> => {
  const salvata = await readFile(linguaFile(), 'utf8').catch(() => '')
  return salvata === '"it"' || salvata === '"en"' ? (JSON.parse(salvata) as Lingua) : linguaDaLocale(app.getLocale())
}

function stopStatusWatch(): void {
  statusWatchers.forEach((w) => w.close())
  statusWatchers = []
  clearTimeout(statusTimer)
}

// Avvisa l'interfaccia quando cambiano branch o sessioni; le modifiche ai file le coglie l'aggiornamento periodico.
async function startStatusWatch(repo: string): Promise<void> {
  stopStatusWatch()
  const notify = (): void => {
    clearTimeout(statusTimer)
    statusTimer = setTimeout(() => win?.webContents.send('stato-cambiato', repo), 300)
  }
  const { stdout } = await run('git', ['rev-parse', '--git-common-dir'], { cwd: repo })
  const targets: [string, (name: string) => boolean][] = [
    [resolve(repo, stdout.trim()), (name) => ['HEAD', 'index', 'packed-refs', 'FETCH_HEAD'].includes(name)],
    [join(claudeDir, 'sessions'), (name) => name.endsWith('.json')]
  ]
  for (const [dir, relevant] of targets) {
    try {
      const watcher = watch(dir, (_event, name) => {
        if (name && relevant(name)) notify()
      })
      watcher.on('error', () => watcher.close())
      statusWatchers.push(watcher)
    } catch {
      // Cartella assente: resta l'aggiornamento periodico.
    }
  }
}

async function knownWorktree(repo: string, path: unknown): Promise<string> {
  const wanted = normalize(String(path)).toLowerCase()
  const found = (await listWorktreePaths(repo)).map(normalize).find((p) => p.toLowerCase() === wanted)
  if (!found) throw new Error(t('ipc.unknownFolder'))
  return found
}

const chatsFile = (): string => join(app.getPath('userData'), 'chats.json')
const chats = new Chats(
  (tab, event) => {
    const e = event as { type?: string; subtype?: string; session_id?: string }
    if (e.type === 'system' && e.subtype === 'init' && e.session_id) {
      const info = tabInfo.get(tab)
      if (info) void saveRecent(chatsFile(), info.repo, { sessionId: e.session_id, cwd: info.cwd, titolo: info.titolo, quando: new Date().toISOString() })
    }
    win?.webContents.send('chat-evento', tab, event)
  },
  (tab, error) => win?.webContents.send('chat-fine', tab, error)
)
const tabInfo = new Map<string, { repo: string; cwd: string; titolo: string }>()

const overlayColors = (): { color: string; symbolColor: string; height: number } =>
  nativeTheme.shouldUseDarkColors ? { color: '#0e0f12', symbolColor: '#a5a9b2', height: 40 } : { color: '#f4f3ee', symbolColor: '#55564f', height: 40 }

function openTerminal(cwd: string): void {
  const detached = { detached: true, stdio: 'ignore' } as const
  if (process.platform !== 'win32') {
    spawn('x-terminal-emulator', [], { ...detached, cwd }).on('error', () => {}).unref()
    return
  }
  const terminal = spawn('wt.exe', ['-d', cwd], detached)
  terminal.on('error', () => spawn('cmd.exe', [], { ...detached, cwd }).on('error', () => {}).unref())
  terminal.unref()
}

const cleanText = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > MAX_TEXT) throw new Error(t('ipc.badItemText'))
  return text
}

const isTodo = (t: Partial<Todo> | null): t is Todo =>
  !!t && typeof t.id === 'string' && typeof t.testo === 'string' && typeof t.fatta === 'boolean' && typeof t.creata === 'string'

// Tutti i canali che lavorano su una repo accettano solo repo già aggiunte dall'utente.
function repoHandler<A extends unknown[], R>(channel: string, fn: (repo: string, ...args: A) => Promise<R>): void {
  ipcMain.handle(channel, async (_e, repo: unknown, ...args: A) => {
    if (typeof repo !== 'string' || !(await isKnown(reposFile(), repo))) throw new Error(t('ipc.unknownRepo'))
    return fn(repo, ...args)
  })
}

type Aperto = { db: Archivio; lavori: Lavori; ricavo: Ricavo; ferma: () => void; coda: Promise<unknown> }
const archivi = new Map<string, Promise<Aperto>>()

const cartellaRepo = (repo: string): string => join(app.getPath('userData'), 'workspaces', createHash('sha256').update(repo).digest('hex').slice(0, 16))

// Un archivio per repo, fuori dalla repo. Gli aggiornamenti passano uno alla volta.
function apriArchivio(repo: string): Promise<Aperto> {
  const gia = archivi.get(repo)
  if (gia) return gia
  const apertura = (async (): Promise<Aperto> => {
    const cartella = cartellaRepo(repo)
    await mkdir(cartella, { recursive: true })
    const db = new Archivio(join(cartella, 'hub.db'))
    db.impostaWorkspace(repo, basename(repo))
    await db.aggiorna(repo)
    const lavori = await Lavori.apri(db, repo, { avvisa: (id, evento) => win?.webContents.send('lavoro-cambiato', repo, id, evento?.tipo ?? null) })
    const aperto: Aperto = { db, lavori, ricavo: new Ricavo(db, lavori, repo), coda: Promise.resolve(), ferma: () => {} }
    aperto.ferma = await sorvegliaGit(repo, () => {
      aperto.coda = aperto.coda.catch(() => {}).then(() => db.aggiorna(repo)).then(() => win?.webContents.send('archivio-cambiato', repo))
    })
    return aperto
  })()
  archivi.set(repo, apertura)
  apertura.catch(() => archivi.delete(repo))
  return apertura
}

function watchTodos(repo: string): void {
  if (watched) unwatchFile(watched)
  watched = todoPath(repo)
  // watchFile regge file ancora inesistenti e i salvataggi via rinomina, anche quelli fatti da Claude.
  watchFile(watched, { interval: 1000 }, () => win?.webContents.send('todos-cambiati', repo))
}

const socialFile = (repo: string): string => join(cartellaRepo(repo), 'social.json')
const socialVecchio = (): string => join(app.getPath('userData'), 'social.json')
const configSocial = async (repo: string): Promise<ConfigSocial> => (await apriArchivio(repo)).db.preferenza('modulo:social', SOCIAL_VUOTO)
const pianoSocial = new Pianificatore()
const socialInCorso = new Set<string>()

// ponytail: si aggiorna solo la repo attiva; se un giorno più repo usano Social, un timer per ciascuna.
function scheduleSocial(): Promise<void> {
  return pianoSocial.pianifica(async () => {
    const { repos, attiva } = await listRepos(reposFile())
    const repo = repos.find((r) => r.path === attiva && !r.manca)?.path
    if (!repo || !(await configSocial(repo)).attivo) return null
    const attesa = nextDelay(await readSocial(socialFile(repo)), Date.now())
    return attesa === null ? null : { repo, attesa }
  }, (repo) => void updateSocial(repo))
}

async function updateSocial(repo: string): Promise<void> {
  if (socialInCorso.has(repo)) return
  socialInCorso.add(repo)
  win?.webContents.send('social-cambiato')
  try {
    await refreshSocial(socialFile(repo), app.getPath('userData'))
  } finally {
    socialInCorso.delete(repo)
    await scheduleSocial()
    win?.webContents.send('social-cambiato')
  }
}

function registerIpc(): void {
  repoHandler('social:read', async (repo) => ({ ...(await readSocial(socialFile(repo))), inCorso: socialInCorso.has(repo) }))
  repoHandler('social:refresh', (repo) => updateSocial(repo))
  repoHandler('social:setInterval', async (repo, ore: unknown) => {
    await setSocialInterval(socialFile(repo), ore)
    await scheduleSocial()
  })
  repoHandler('social:session', async (repo) => {
    const { avd, istruzioni } = await configSocial(repo)
    return sessionPrompt(basename(repo), avd, avd ? startEmulator(avd) : null, istruzioni)
  })
  repoHandler('moduli:leggi', async (repo) => ({
    social: await configSocial(repo),
    proposta: await propostaSocial(repo),
    datiVecchi: await datiVecchiDisponibili(socialVecchio(), socialFile(repo))
  }))
  repoHandler('moduli:attivaSocial', async (repo, avd: unknown, istruzioni: unknown) => {
    const config = validaSocial(avd, istruzioni)
    const { db } = await apriArchivio(repo)
    await importaDatiVecchi(socialVecchio(), socialFile(repo))
    db.scriviPreferenza('modulo:social', { attivo: true, ...config })
    await scheduleSocial()
  })
  repoHandler('moduli:togliSocial', async (repo) => {
    const { db } = await apriArchivio(repo)
    db.scriviPreferenza('modulo:social', { ...(await configSocial(repo)), attivo: false })
    await scheduleSocial()
  })
  // Dà l'ultima visita e segna questa. La prima volta non c'è nulla da confrontare.
  repoHandler('preferenze:visitaHome', async (repo) => {
    const { db } = await apriArchivio(repo)
    const visto = db.preferenza<number | null>('home:visto', null)
    db.scriviPreferenza('home:visto', Date.now())
    return visto
  })
  repoHandler('preferenze:sezione', async (repo) => (await apriArchivio(repo)).db.preferenza<string | null>('sezione', null))
  repoHandler('preferenze:scriviSezione', async (repo, id: unknown) => (await apriArchivio(repo)).db.scriviPreferenza('sezione', String(id).slice(0, 40)))
  ipcMain.handle('diagnostic:report', async () => {
    const { repos } = await listRepos(reposFile())
    const errori = await Promise.all(repos.filter((r) => archivi.has(r.path)).map(async (r) => (await apriArchivio(r.path)).db.lavori().map((l) => l.errore).filter((e): e is string => Boolean(e))))
    const versioneGit = await promisify(execFile)('git', ['--version']).then((r) => r.stdout.trim(), () => null)
    const claude = await findClaude().then(() => true, () => false)
    return diagnosticReport({ app: app.getVersion(), electron: process.versions.electron, node: process.versions.node, os: `${process.platform} ${release()}`, language: lingua(), git: versioneGit, claude, repos: repos.length, errors: errori.flat() }, [...repos.map((r) => r.path), homedir()])
  })
  ipcMain.handle('lingua:get', () => lingua())
  ipcMain.handle('lingua:set', async (_e, l: unknown) => {
    if (l !== 'en' && l !== 'it') return
    setLingua(l)
    await writeFile(linguaFile(), JSON.stringify(l))
    win?.webContents.reload()
  })
  ipcMain.handle('repos:list', () => listRepos(reposFile()))
  ipcMain.handle('repos:add', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: t('ipc.chooseRepo') })
    if (!canceled && filePaths[0]) await addRepo(reposFile(), filePaths[0])
    return listRepos(reposFile())
  })
  repoHandler('repos:select', async (repo) => {
    await setActive(reposFile(), repo)
    void scheduleSocial().catch(() => {})
    return listRepos(reposFile())
  })
  repoHandler('repos:remove', async (repo) => {
    await removeRepo(reposFile(), repo)
    return listRepos(reposFile())
  })
  repoHandler('todos:watch', async (repo) => watchTodos(repo))
  repoHandler('todos:list', (repo) => readTodos(repo))
  repoHandler('todos:add', (repo, testo: unknown) => addTodo(repo, cleanText(testo)))
  repoHandler('todos:setDone', (repo, id: string, fatta: boolean) => updateTodo(repo, String(id), { fatta: fatta === true }))
  repoHandler('todos:setText', (repo, id: string, testo: unknown) => updateTodo(repo, String(id), { testo: cleanText(testo) }))
  repoHandler('todos:remove', (repo, id: string) => removeTodo(repo, String(id)))
  repoHandler('todos:restore', async (repo, todo: Todo, index: number) => {
    if (!isTodo(todo)) throw new Error(t('ipc.badItem'))
    return restoreTodo(repo, todo, Number(index) || 0)
  })
  repoHandler('docs:list', (repo) => scanDocs(repo))
  repoHandler('docs:open', async (repo, file: string) => {
    const path = safeDocPath(repo, String(file))
    if (!path) throw new Error(t('ipc.badFile'))
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
  repoHandler('chat:send', async (repo, tab: unknown, path: unknown, resumeId: unknown, text: unknown) => {
    const cwd = await knownWorktree(repo, path)
    const message = typeof text === 'string' ? text.trim() : ''
    if (typeof tab !== 'string' || !message) throw new Error(t('ipc.badMessage'))
    if (!tabInfo.has(tab)) tabInfo.set(tab, { repo, cwd, titolo: message.slice(0, 80) })
    await chats.send(tab, cwd, typeof resumeId === 'string' ? resumeId : null, message)
  })
  ipcMain.handle('chat:respond', (_e, tab: string, requestId: string, decision: Decision) => {
    if (!['allow', 'allowSession', 'deny'].includes(decision?.scelta)) throw new Error(t('ipc.badChoice'))
    chats.respond(String(tab), String(requestId), decision)
  })
  ipcMain.handle('chat:stop', (_e, tab: string) => chats.interrupt(String(tab)))
  ipcMain.handle('chat:close', (_e, tab: string) => {
    tabInfo.delete(String(tab))
    chats.close(String(tab))
  })
  repoHandler('chat:recent', (repo) => readRecent(chatsFile(), repo))
  repoHandler('chat:history', async (repo, path: unknown, sessionId: unknown) => readHistory(claudeDir, await knownWorktree(repo, path), String(sessionId)))
  repoHandler('git:graph', (repo, limit: unknown) => readGraph(repo, Number(limit)))
  repoHandler('git:commit', (repo, hash: unknown) => readCommit(repo, hash))
  repoHandler('git:commitDiff', (repo, hash: unknown, file: unknown) => readCommitDiff(repo, hash, file))
  repoHandler('git:branch', (repo, name: unknown, base: unknown) => readBranch(repo, name, base))
  repoHandler('git:branchDiff', (repo, name: unknown, base: unknown, file: unknown) => readBranchDiff(repo, name, base, file))
  repoHandler('git:worktreeChanges', async (repo, path: unknown) => readWorktreeChanges(await knownWorktree(repo, path)))
  repoHandler('git:worktreeDiff', async (repo, path: unknown, file: unknown) => readWorktreeDiff(await knownWorktree(repo, path), file))
  repoHandler('status:read', async (repo) => {
    const status = await readStatus(repo)
    return { ...status, ...(await readAgents(claudeDir, status.worktree.map((w) => w.path))) }
  })
  repoHandler('status:watch', (repo) => startStatusWatch(repo))
  repoHandler('archivio:apri', async (repo) => (await apriArchivio(repo)).db.riepilogo())
  repoHandler('anteprima:dati', async (repo) => {
    const { db } = await apriArchivio(repo)
    const m = db.mappa()
    return {
      ...m,
      funzioni: m.funzioni.map((f) => ({ ...f, nonDisponibile: db.nonDisponibile(f.id) })),
      flussi: db.tuttiFlussi(),
      commit: db.commitMappa(),
      versione: await statoVersione(repo),
      segnalazioni: db.segnalazioni(),
      lavori: db.lavori().map(({ prompt: _prompt, ...l }) => l)
    }
  })
  repoHandler('anteprima:flusso', async (repo, id: unknown) => (await apriArchivio(repo)).db.flussoCompleto(String(id), repo))
  repoHandler('anteprima:contesto', (repo, commit: unknown, file: unknown, riga: unknown) => contesto(repo, commit, file, riga))
  repoHandler('anteprima:segnala', async (repo, passo: unknown, testo: unknown) => {
    const { db } = await apriArchivio(repo)
    return typeof passo === 'string' ? db.segnalaPasso(passo, cleanText(testo)) : db.segnalaMancante(cleanText(testo))
  })
  repoHandler('ricavo:livello', async (repo) => (await apriArchivio(repo)).ricavo.livello())
  repoHandler('ricavo:flusso', async (repo, funzione: unknown) => (await apriArchivio(repo)).ricavo.flusso(String(funzione)))
  repoHandler('ricavo:dati', async (repo) => (await apriArchivio(repo)).db.mappa())
  repoHandler('ricavo:stato-flusso', async (repo, flusso: unknown) => (await apriArchivio(repo)).db.statoFlusso(String(flusso), repo))
  repoHandler('lavori:elenco', async (repo) => (await apriArchivio(repo)).db.lavori().map(({ prompt: _prompt, ...l }) => l))
  repoHandler('lavori:annulla', async (repo, id: unknown) => (await apriArchivio(repo)).lavori.annulla(String(id)))
  repoHandler('archivio:aggiorna', async (repo) => {
    const a = await apriArchivio(repo)
    a.coda = a.coda.catch(() => {}).then(() => a.db.aggiorna(repo))
    await a.coda
  })
  repoHandler('archivio:oggetto', async (repo, id: unknown) => {
    const { db } = await apriArchivio(repo)
    const o = db.oggetto(String(id))
    if (!o?.percorso) return o && { ...o, anteprima: null, commitAnteprima: null }
    const commit = await git(repo, 'rev-parse', '--verify', '--quiet', 'HEAD').then((c) => c.trim(), () => null)
    return { ...o, anteprima: await contesto(repo, commit, o.percorso, 1, 500), commitAnteprima: commit }
  })
  const preparaReview = async (repo: string, scope: unknown): Promise<Prepared> => {
    if (scope !== 'local' && scope !== 'branch' && scope !== 'project') throw new Error(t('review.badScope'))
    await git(repo, 'rev-parse', '--verify', 'HEAD^{commit}').catch(() => {
      throw new Error(t('review.noCommits'))
    })
    return prepare(repo, scope as Scope, (await readStatus(repo)).base, (file) => leggiTesto(repo, file))
  }
  const salvaReview = async (repo: string, p: Prepared, claude: Report['claude'], altri: Prepared['skipped'] = []): Promise<Report> => {
    const report: Report = { scope: p.scope, commit: p.commit, base: p.base, when: new Date().toISOString(), reviewed: p.files.length - altri.length, skipped: [...p.skipped, ...altri], local: p.files.flatMap((f) => scanLines(f.file, f.lines)).slice(0, 200), claude }
    ;(await apriArchivio(repo)).db.scriviPreferenza('review:ultima', report)
    return report
  }
  repoHandler('review:last', async (repo) => ({
    report: (await apriArchivio(repo)).db.preferenza<Report | null>('review:ultima', null),
    head: (await git(repo, 'rev-parse', '--verify', 'HEAD^{commit}').catch(() => '')).trim() || null
  }))
  repoHandler('review:local', async (repo, scope: unknown) => {
    const p = await preparaReview(repo, scope)
    return p.empty ? null : salvaReview(repo, p, null)
  })
  repoHandler('review:claude', async (repo, scope: unknown) => {
    const p = await preparaReview(repo, scope)
    if (p.empty) return null
    const { lavori } = await apriArchivio(repo)
    const { prompt, skipped } = buildPrompt(p, await findRelated(repo, p))
    const id = lavori.accoda(t('review.jobTitle'), prompt, undefined, undefined, p.commit)
    const l = await lavori.attendi(id)
    if (l.stato !== 'finito') throw new Error(l.errore ?? t(`job.${l.stato}` as Chiave))
    const dati = estraiJson(l.esito ?? '')
    if (dati === null) throw new Error(t('review.badAnswer'))
    const perFile = new Map(p.files.map((f) => [f.file, f.lines]))
    const lettore = p.scope === 'project' ? await lettoreDaCommit(repo, p.commit) : null
    const righeDi = async (file: string) => {
      if (!lettore) return perFile.get(file) ?? null
      const testo = perFile.has(file) ? await lettore.leggi(file) : null
      return testo === null ? null : testo.split(/\r?\n/).map((text, i) => ({ line: i + 1, text }))
    }
    const primo = await verify(dati, righeDi)
    let [findings, costo, durata, challenged, challengeFailed] = [primo.findings, l.costo ?? 0, l.durata ?? 0, 0, false]
    const daControllare = findings.filter(needsChallenge).slice(0, 10)
    if (daControllare.length) {
      // If the second reader fails, the first result is still worth showing, and the screen says it wasn't double-checked.
      const dopo = await lavori.attendi(lavori.accoda(t('review.jobTitleChallenge'), buildChallenge(daControllare, p), undefined, undefined, p.commit))
      costo += dopo.costo ?? 0
      durata += dopo.durata ?? 0
      const risposta = dopo.stato === 'finito' ? estraiJson(dopo.esito ?? '') : null
      if (risposta === null) challengeFailed = true
      else {
        const rivisti = applyChallenge(daControllare, risposta)
        findings = findings.map((f) => rivisti[daControllare.indexOf(f)] ?? f)
        challenged = daControllare.length
      }
    }
    return salvaReview(repo, p, { summary: primo.summary, discarded: primo.discarded, findings, cost: costo, seconds: Math.round(durata / 1000), challenged, challengeFailed }, skipped)
  })
  repoHandler('review:judge', async (repo, chiave: unknown, giudizio: unknown) => {
    const { db } = await apriArchivio(repo)
    const tutti = db.preferenza<Record<string, string>>('review:giudizi', {})
    if (giudizio === 'real' || giudizio === 'false' || giudizio === 'overrated') tutti[String(chiave).slice(0, 700)] = giudizio
    else delete tutti[String(chiave).slice(0, 700)]
    db.scriviPreferenza('review:giudizi', tutti)
    return tutti
  })
  repoHandler('review:judgements', async (repo) => (await apriArchivio(repo)).db.preferenza<Record<string, string>>('review:giudizi', {}))
  const fileDaCorreggere = async (repo: string, file: unknown): Promise<string> => {
    const vero = await dentroLaRepo(await realpath(repo), String(file))
    if (!vero || SEGRETO.test(basename(vero))) throw new Error(t('fix.badFile'))
    return vero
  }
  repoHandler('review:proposeFix', async (repo, f: { title: string; file: string; line: number; why: string; fix: string }) => {
    const vero = await fileDaCorreggere(repo, f?.file)
    const testo = await readFile(vero, 'utf8')
    const commit = (await git(repo, 'rev-parse', '--verify', 'HEAD^{commit}')).trim()
    const { lavori } = await apriArchivio(repo)
    const l = await lavori.attendi(lavori.accoda(t('fix.jobTitle'), buildFixPrompt(f, testo), undefined, undefined, commit))
    if (l.stato !== 'finito') throw new Error(l.errore ?? t(`job.${l.stato}` as Chiave))
    const p = parseProposal(estraiJson(l.esito ?? ''))
    if (!p) throw new Error(t('fix.badAnswer'))
    if (p.edits.length && applyEdits(testo, p.edits) === null) throw new Error(t('fix.noMatch'))
    return { ...p, hash: fileHash(testo), cost: l.costo ?? 0 }
  })
  repoHandler('review:applyFix', async (repo, file: unknown, edits: { search: string; replace: string }[], hash: unknown) => {
    const vero = await fileDaCorreggere(repo, file)
    const testo = await readFile(vero, 'utf8')
    if (fileHash(testo) !== hash) throw new Error(t('fix.stale'))
    const nuovo = applyEdits(testo, edits)
    if (nuovo === null) throw new Error(t('fix.noMatch'))
    await writeFile(`${vero}.repolantern-tmp`, nuovo)
    await rename(`${vero}.repolantern-tmp`, vero)
    primaDellaCorrezione.set(vero, { testo, dopo: fileHash(nuovo) })
  })
  repoHandler('review:undoFix', async (repo, file: unknown) => {
    const vero = await fileDaCorreggere(repo, file)
    const prima = primaDellaCorrezione.get(vero)
    if (!prima || fileHash(await readFile(vero, 'utf8')) !== prima.dopo) throw new Error(t('fix.cantUndo'))
    await writeFile(`${vero}.repolantern-tmp`, prima.testo)
    await rename(`${vero}.repolantern-tmp`, vero)
    primaDellaCorrezione.delete(vero)
  })
  repoHandler('review:todo', async (repo, f: { title?: unknown; file?: unknown; line?: unknown }, commit: unknown) => {
    if (typeof f?.title !== 'string' || !f.title.trim() || typeof f.file !== 'string' || !f.file.trim()) throw new Error(t('review.badFinding'))
    const voce = { title: f.title.slice(0, 200), file: f.file.slice(0, 400), line: Number(f.line) || 1 }
    if ((await readTodos(repo)).some((x) => x.testo.startsWith(todoKey(voce)))) return false
    await addTodo(repo, todoText(voce, String(commit)))
    return true
  })
  repoHandler('doctor:visita', async (repo) => {
    const elenco = (await git(repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0').filter(Boolean)
    return visita(elenco, (file) => leggiTesto(repo, file))
  })
  repoHandler('codice:cerca', (repo, testo: unknown) => cercaNelCodice(repo, testo))
  repoHandler('codice:brano', (repo, file: unknown, riga: unknown) => branoFile(repo, file, riga))
  repoHandler('open:file', async (repo, file: unknown, riga?: unknown) => {
    const vero = await dentroLaRepo(await realpath(repo), String(file))
    if (!vero) throw new Error(t('ipc.badFile'))
    if (SEGRETO.test(basename(vero))) throw new Error(t('ipc.noSecrets'))
    const alla = Number.isInteger(riga) && (riga as number) > 0 ? `:${riga}` : ''
    await shell.openExternal(`vscode://file/${encodeURI(vero.replaceAll('\\', '/'))}${alla}`)
  })
  repoHandler('archivio:cerca', async (repo, testo: unknown) => (await apriArchivio(repo)).db.cerca(String(testo).slice(0, MAX_TEXT)))
  ipcMain.handle('status:unwatch', () => stopStatusWatch())
  repoHandler('open:vscode', async (repo, path: unknown) => {
    const dir = (await knownWorktree(repo, path)).replaceAll('\\', '/')
    await shell.openExternal(`vscode://file/${encodeURI(dir)}`)
  })
  repoHandler('open:terminal', async (repo, path: unknown) => openTerminal(await knownWorktree(repo, path)))
  repoHandler('open:folder', async (repo, path: unknown) => {
    const error = await shell.openPath(await knownWorktree(repo, path))
    if (error) throw new Error(error)
  })
  repoHandler('open:github', async (repo, branch: unknown) => {
    const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd: repo })
    const url = githubUrl(stdout)
    if (!url) throw new Error(t('ipc.notGithub'))
    const path = typeof branch === 'string' ? `/tree/${branch.split('/').map(encodeURIComponent).join('/')}` : ''
    await shell.openExternal(url + path)
  })
}

function createWindow(): void {
  // Le prove automatiche si aprono sul secondo schermo, per non disturbare chi lavora sul primo.
  const other = process.env.HUB_SECONDO_SCHERMO ? screen.getAllDisplays().find((d) => d.id !== screen.getPrimaryDisplay().id) : undefined
  win = new BrowserWindow({
    ...(other ? { x: other.workArea.x + 40, y: other.workArea.y + 40 } : {}),
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayColors(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0f12' : '#f4f3ee',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  win.once('ready-to-show', () => win?.show())
  // La hub non naviga mai altrove: i link esterni si aprono nel browser, solo se https.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => (win = null))
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore()
    win?.focus()
  })
  void app.whenReady().then(async () => {
    setLingua(await leggiLingua())
    registerIpc()
    createWindow()
    void scheduleSocial().catch(() => {})
    nativeTheme.on('updated', () => win?.setTitleBarOverlay(overlayColors()))
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    chats.closeAll()
    for (const apertura of archivi.values()) void apertura.then((a) => {
      a.ferma()
      return a.lavori.chiudi()
    }).catch(() => {})
  })
}
