import { readdir, readFile, stat } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'

export type Subagent = { id: string; descrizione: string; tipo: string; attivo: boolean; attivita: number }
export type Session = { id: string; nome: string; cwd: string; stato: string; origine: string; aggiornata: number; subagenti: Subagent[] }
export type AgentsResult = { sessioni: Session[]; illeggibili: number }

const key = (path: string): string => normalize(path).toLowerCase()

const isInside = (path: string, folder: string): boolean => {
  const p = key(path)
  const f = key(folder).replace(/[\\/]+$/, '')
  return p === f || p.startsWith(f + sep)
}

const RECENT_MS = 60_000

// finished diventa true a ogni fine turno, anche se il subagente poi riprende dopo un lavoro in background.
// ponytail: un subagente fermo da oltre un minuto ad aspettare quel lavoro risulta finito; non c'è un segnale più preciso nei file.
export const isActive = (finished: unknown, activity: number, now: number): boolean => finished !== true || now - activity < RECENT_MS

export const projectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

// ponytail: un PID riusato da un altro programma fa sembrare viva una sessione chiusa; confrontare procStart se capita.
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readSubagents(claudeDir: string, cwd: string, sessionId: string): Promise<Subagent[]> {
  const dir = join(claudeDir, 'projects', projectSlug(cwd), sessionId, 'subagents')
  const files = await readdir(dir).catch(() => [] as string[])
  const items = await Promise.all(
    files
      .filter((f) => f.endsWith('.meta.json'))
      .map(async (file): Promise<Subagent | null> => {
        const id = file.replace(/^agent-/, '').replace(/\.meta\.json$/, '')
        try {
          const meta = JSON.parse(await readFile(join(dir, file), 'utf8'))
          // La conversazione del subagente cambia a ogni passo: la sua data dice quando ha lavorato l'ultima volta.
          const log = await stat(join(dir, file.replace('.meta.json', '.jsonl'))).catch(() => stat(join(dir, file)))
          return { id, descrizione: String(meta.description ?? id), tipo: String(meta.agentType ?? ''), attivo: isActive(meta.finished, log.mtimeMs, Date.now()), attivita: log.mtimeMs }
        } catch {
          return null
        }
      })
  )
  return items.filter((s) => s !== null).sort((a, b) => b.attivita - a.attivita)
}

export async function readAgents(claudeDir: string, folders: string[], alive: (pid: number) => boolean = processAlive): Promise<AgentsResult> {
  const dir = join(claudeDir, 'sessions')
  // Solo i .json: nella stessa cartella ci sono file .key che la hub non deve mai aprire.
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'))
  let illeggibili = 0
  const sessioni = await Promise.all(
    files.map(async (file): Promise<Session | null> => {
      try {
        const d = JSON.parse(await readFile(join(dir, file), 'utf8'))
        if (typeof d.pid !== 'number' || typeof d.sessionId !== 'string' || typeof d.cwd !== 'string') throw new Error('formato')
        if (!alive(d.pid) || !folders.some((f) => isInside(d.cwd, f))) return null
        // updatedAt cambia solo col cambio di stato: la conversazione dice quando la sessione ha lavorato davvero.
        const log = await stat(join(claudeDir, 'projects', projectSlug(d.cwd), `${d.sessionId}.jsonl`)).catch(() => null)
        return {
          id: d.sessionId,
          nome: String(d.name ?? ''),
          cwd: d.cwd,
          stato: String(d.status ?? ''),
          origine: String(d.entrypoint ?? ''),
          aggiornata: Math.max(Number(d.updatedAt ?? 0), log?.mtimeMs ?? 0),
          subagenti: await readSubagents(claudeDir, d.cwd, d.sessionId)
        }
      } catch {
        illeggibili++
        return null
      }
    })
  )
  return { sessioni: sessioni.filter((s) => s !== null).sort((a, b) => b.aggiornata - a.aggiornata), illeggibili }
}
