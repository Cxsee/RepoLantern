import { t } from '../../shared/i18n.ts'
import type { DocTodo, LogCommit, Status, Todo } from './hub'

export type DatiHome = { status: Status; commit: LogCommit[]; todo: Todo[]; documenti: DocTodo[]; lavori: { id: string; titolo: string; stato: string }[]; visto: number | null }
export type RiassuntoHome = {
  nuovi: LogCommit[]
  recenti: LogCommit[]
  primaVolta: boolean
  altriNuovi: number
  worktree: { path: string; nome: string; modifiche: number }[]
  branch: { nome: string; avanti: number; daInviare: number }[]
  altriBranch: number
  sessioni: { id: string; nome: string; subagenti: number }[]
  sessioniInAttesa: number
  lavori: { id: string; titolo: string }[]
  todo: { aperte: number; prime: string[]; neiDocumenti: number }
}

export const STATI: Record<string, string> = { get busy() { return t('status.busy') }, get idle() { return t('status.idle') } }
const MAX_COMMIT = 5
const MAX_BRANCH = 5
const MAX_TODO = 3

// Dice cosa c'è, non cosa significa: un branch vecchio o una modifica in corso non sono problemi di per sé.
export function riassumiHome(d: DatiHome): RiassuntoHome {
  const primaVolta = d.visto === null
  const dopo = primaVolta ? d.commit : d.commit.filter((c) => c.time > d.visto!)
  const ordinati = [...dopo].sort((a, b) => b.time - a.time)
  const inWorktree = new Set(d.status.worktree.map((w) => w.branch))
  const branch = d.status.branch
    .filter((b) => b.nome !== d.status.base && (b.avanti > 0 || b.upstreamAvanti > 0))
    .sort((a, b) => Number(inWorktree.has(b.nome)) - Number(inWorktree.has(a.nome)) || b.data.localeCompare(a.data))
  const aperte = d.todo.filter((t) => !t.fatta)
  return {
    nuovi: ordinati.slice(0, MAX_COMMIT),
    recenti: ordinati.length ? [] : [...d.commit].sort((a, b) => b.time - a.time).slice(0, MAX_COMMIT),
    primaVolta,
    altriNuovi: primaVolta ? 0 : Math.max(0, ordinati.length - MAX_COMMIT),
    worktree: d.status.worktree.filter((w) => !w.manca && w.modificati + w.nuovi > 0).map((w) => ({ path: w.path, nome: w.branch ?? t('common.noBranch'), modifiche: w.modificati + w.nuovi })),
    branch: branch.slice(0, MAX_BRANCH).map((b) => ({ nome: b.nome, avanti: b.avanti, daInviare: b.upstreamAvanti })),
    altriBranch: Math.max(0, branch.length - MAX_BRANCH),
    sessioni: d.status.sessioni.filter((s) => s.stato === 'busy').map((s) => ({ id: s.id, nome: s.nome, subagenti: s.subagenti.filter((a) => a.attivo).length })),
    sessioniInAttesa: d.status.sessioni.filter((s) => s.stato !== 'busy').length,
    lavori: d.lavori.filter((l) => l.stato === 'in-corso' || l.stato === 'in-coda').map((l) => ({ id: l.id, titolo: l.titolo })),
    todo: { aperte: aperte.length, prime: aperte.slice(0, MAX_TODO).map((t) => t.testo), neiDocumenti: d.documenti.length }
  }
}

// Una sessione di Hub guarda sempre dallo stesso punto: tornare sulla Home non azzera ciò che è cambiato.
// Si tiene la richiesta, non solo il risultato: due letture insieme non devono segnare la visita due volte.
const vistiInQuestaSessione = new Map<string, Promise<number | null>>()

export function ultimaVisita(repo: string, leggi: (repo: string) => Promise<number | null>): Promise<number | null> {
  const gia = vistiInQuestaSessione.get(repo)
  if (gia) return gia
  const visto = leggi(repo)
  vistiInQuestaSessione.set(repo, visto)
  visto.catch(() => vistiInQuestaSessione.delete(repo))
  return visto
}
