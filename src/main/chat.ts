import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import { t } from '../shared/i18n.ts'
import { projectSlug } from './agents.ts'

const run = promisify(execFile)
const SESSION_ID = /^[0-9a-f-]{36}$/i
const MAX_HISTORY_BYTES = 50 * 1024 * 1024
const MAX_RECENT = 30

export type Decision = { scelta: 'allow' | 'allowSession' | 'deny'; risposte?: Record<string, string> }
type Pending = { input: Record<string, unknown>; suggestions: Record<string, unknown>[] }
export type Recent = { sessionId: string; cwd: string; titolo: string; quando: string }

// I dati del permesso restano qui: l'interfaccia dice solo cosa ha scelto, non può cambiare il comando che viene approvato.
export function buildPermissionResponse(pending: Pending, decision: Decision): Record<string, unknown> {
  if (decision.scelta === 'deny') return { behavior: 'deny', message: "Negato dall'utente" }
  const risposte = decision.risposte && Object.values(decision.risposte).every((v) => typeof v === 'string') ? decision.risposte : null
  const updatedInput = risposte ? { ...pending.input, answers: risposte } : pending.input
  if (decision.scelta === 'allow') return { behavior: 'allow', updatedInput }
  // "Per questa sessione" non deve mai finire nei file di impostazioni della repo.
  return { behavior: 'allow', updatedInput, updatedPermissions: pending.suggestions.map((s) => ({ ...s, destination: 'session' })) }
}

export const DIVIETI_SEGRETI = ['Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/*.jks)', 'Read(**/*.keystore)']
// Non è una barriera: lo stesso comando si può scrivere in molti modi. Serve a far chiedere conferma anche se una regola generale lo consentirebbe.
export const COMANDI_DA_CONFERMARE = ['Bash(git push*)', 'Bash(git checkout*)', 'Bash(git switch*)', 'Bash(git merge*)', 'Bash(git rebase*)', 'Bash(git reset*)']

export function claudeArgs(resumeId: string | null, opzioni: { chrome?: boolean } = {}): string[] {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default', '--settings', JSON.stringify({ permissions: { deny: DIVIETI_SEGRETI, ask: COMANDI_DA_CONFERMARE } })]
  if (opzioni.chrome) args.push('--chrome')
  if (resumeId) {
    if (!SESSION_ID.test(resumeId)) throw new Error(t('chat.badSession'))
    args.push('--resume', resumeId)
  }
  return args
}

export async function findClaude(): Promise<string> {
  const { stdout } = await run('where.exe', ['claude']).catch(() => ({ stdout: '' }))
  const found = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l))
  const fallback = join(homedir(), '.local', 'bin', 'claude.exe')
  if (found) return found
  if (existsSync(fallback)) return fallback
  throw new Error(t('chat.notInstalled'))
}

// Eventi molto frequenti che l'interfaccia non usa: non vale la pena spedirli.
const isNoise = (m: any): boolean =>
  (m.type === 'system' && m.subtype === 'thinking_tokens') ||
  (m.type === 'stream_event' && ['thinking_delta', 'signature_delta', 'input_json_delta'].includes(m.event?.delta?.type))

export type Comando = { exe: string; args: string[] }
type Chat = { proc: ChildProcessWithoutNullStreams; pending: Map<string, Pending>; stderr: string; closing: boolean; cwd: string; sessioni: Set<string> }

export class Chats {
  private chats = new Map<string, Chat>()
  private avvii = new Map<string, Promise<Chat>>()
  private chiuseInAvvio = new Set<string>()
  private comando: () => Promise<Comando>
  private emit: (tab: string, event: unknown) => void
  private ended: (tab: string, error: string | null) => void

  constructor(emit: (tab: string, event: unknown) => void, ended: (tab: string, error: string | null) => void, comando?: () => Promise<Comando>) {
    this.comando = comando ?? (async () => ({ exe: await findClaude(), args: [] }))
    this.emit = emit
    this.ended = ended
  }

  private async start(tab: string, cwd: string, resumeId: string | null): Promise<Chat> {
    const { exe, args } = await this.comando()
    if (this.chiuseInAvvio.has(tab)) throw new Error(t('chat.tabClosed'))
    const proc = spawn(exe, [...args, ...claudeArgs(resumeId, { chrome: true })], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const chat: Chat = { proc, pending: new Map(), stderr: '', closing: false, cwd, sessioni: new Set(resumeId ? [resumeId] : []) }
    this.chats.set(tab, chat)

    let buffer = ''
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (data: string) => {
      buffer += data
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (line) this.handleLine(tab, chat, line)
      }
    })
    proc.stderr.on('data', (data: string) => {
      chat.stderr = (chat.stderr + data).slice(-2000)
    })
    proc.stdin.on('error', () => {})
    let finished = false
    const finish = (error: string | null): void => {
      if (finished) return
      finished = true
      if (this.chats.get(tab) === chat) this.chats.delete(tab)
      this.ended(tab, chat.closing ? null : error)
    }
    proc.on('error', (e) => finish(t('chat.notStarted', { error: e.message })))
    proc.on('exit', (code) => finish(code ? chat.stderr.trim() || t('chat.exitCode', { code }) : null))
    return chat
  }

  private handleLine(tab: string, chat: Chat, line: string): void {
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      this.emit(tab, { type: 'testo_grezzo', testo: line })
      return
    }
    if (isNoise(event)) return
    if (typeof event.session_id === 'string') chat.sessioni.add(event.session_id)
    if (event.type === 'control_request') {
      const request = event.request
      if (request?.subtype === 'can_use_tool') {
        chat.pending.set(event.request_id, { input: request.input ?? {}, suggestions: Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [] })
      } else {
        // Richiesta che la hub non conosce: rispondere subito, altrimenti Claude resterebbe in attesa per sempre.
        this.write(chat, { type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: `Non gestita: ${request?.subtype}` } })
        return
      }
    }
    if (event.type === 'control_cancel_request') chat.pending.delete(event.request_id)
    this.emit(tab, event)
  }

  private write(chat: Chat, message: unknown): void {
    chat.proc.stdin.write(JSON.stringify(message) + '\n')
  }

  async send(tab: string, cwd: string, resumeId: string | null, text: string): Promise<void> {
    let chat = this.chats.get(tab)
    if (!chat) {
      // Due invii ravvicinati devono trovare lo stesso processo, non avviarne due.
      let avvio = this.avvii.get(tab)
      if (!avvio) {
        avvio = this.start(tab, cwd, resumeId).finally(() => {
          this.avvii.delete(tab)
          this.chiuseInAvvio.delete(tab)
        })
        this.avvii.set(tab, avvio)
      }
      chat = await avvio
    }
    // Una scheda è legata a una cartella e a una sessione: un messaggio per un'altra non deve finire qui.
    if (normalize(chat.cwd).toLowerCase() !== normalize(cwd).toLowerCase()) throw new Error(t('chat.otherFolder'))
    if (resumeId && chat.sessioni.size && !chat.sessioni.has(resumeId)) throw new Error(t('chat.otherSession'))
    this.write(chat, { type: 'user', message: { role: 'user', content: text } })
  }

  respond(tab: string, requestId: string, decision: Decision): void {
    const chat = this.chats.get(tab)
    const pending = chat?.pending.get(requestId)
    if (!chat || !pending) return
    chat.pending.delete(requestId)
    this.write(chat, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: buildPermissionResponse(pending, decision) } })
  }

  interrupt(tab: string): void {
    const chat = this.chats.get(tab)
    if (chat) this.write(chat, { type: 'control_request', request_id: `stop-${Date.now()}`, request: { subtype: 'interrupt' } })
  }

  close(tab: string): void {
    // Una scheda chiusa mentre Claude sta partendo non deve più avviarlo.
    if (this.avvii.has(tab)) this.chiuseInAvvio.add(tab)
    const chat = this.chats.get(tab)
    if (!chat) return
    chat.closing = true
    // Va chiuso tutto l'albero: Claude può avere comandi ancora in esecuzione.
    if (chat.proc.pid) execFile('taskkill', ['/PID', String(chat.proc.pid), '/T', '/F'], () => {})
  }

  closeAll(): void {
    for (const tab of new Set([...this.chats.keys(), ...this.avvii.keys()])) this.close(tab)
  }
}

export async function readHistory(claudeDir: string, cwd: string, sessionId: string): Promise<unknown[]> {
  if (!SESSION_ID.test(sessionId)) throw new Error(t('chat.badSession'))
  const raw = await readFile(join(claudeDir, 'projects', projectSlug(cwd), `${sessionId}.jsonl`), 'utf8')
  // ponytail: da oltre 50 MB si perde l'inizio della cronologia mostrata; la ripresa in Claude resta completa.
  const text = raw.length > MAX_HISTORY_BYTES ? raw.slice(raw.indexOf('\n', raw.length - MAX_HISTORY_BYTES) + 1) : raw
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

type RecentFile = Record<string, Recent[]>

export async function readRecent(file: string, repo: string): Promise<Recent[]> {
  const data: RecentFile = await readFile(file, 'utf8').then(JSON.parse, () => ({}))
  return data[repo] ?? []
}

export async function saveRecent(file: string, repo: string, item: Recent): Promise<void> {
  const data: RecentFile = await readFile(file, 'utf8').then(JSON.parse, () => ({}))
  const previous = data[repo]?.find((r) => r.sessionId === item.sessionId)
  const merged = previous ? { ...item, titolo: previous.titolo } : item
  data[repo] = [merged, ...(data[repo] ?? []).filter((r) => r.sessionId !== item.sessionId)].slice(0, MAX_RECENT)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2))
  await rename(`${file}.tmp`, file)
}
