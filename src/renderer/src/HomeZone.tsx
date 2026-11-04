import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../../shared/i18n.ts'
import { message } from './errors'
import { ago } from './gitGraph'
import { riassumiHome, ultimaVisita, type RiassuntoHome } from './home'
import { soloUltima } from './sezioni'

export type Destinazione = { t: 'worktree'; path: string } | { t: 'branch'; nome: string } | { t: 'commit'; hash: string }
const AGGIORNA_MS = 10_000

function Voce({ onClick, children, nota }: { onClick: () => void; children: React.ReactNode; nota?: string }) {
  return (
    <li>
      <button className="home-voce" onClick={onClick}>
        <span className="home-testo">{children}</span>
        {nota && <span className="meta">{nota}</span>}
      </button>
    </li>
  )
}

// La repo aperta può essere pulita mentre un altro worktree ha modifiche: la voce dice dove stanno.
const altraCartella = (path: string, repo: string): string => {
  const norma = (p: string): string => p.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()
  return norma(path) === norma(repo) ? '' : t('home.folder', { name: path.replaceAll('\\', '/').split('/').pop() ?? '' })
}

const CHIAVE_INIZIO = 'repolantern.start.done'
const inizioChiuso = (): boolean => {
  try {
    return localStorage.getItem(CHIAVE_INIZIO) === '1'
  } catch {
    return false
  }
}

// For someone opening a project they don't know: three steps in the order that pays off.
function DaDoveIniziare({ onZona }: { onZona: (id: string) => void }) {
  const [chiuso, setChiuso] = useState(inizioChiuso)
  if (chiuso) return null
  const chiudi = (): void => {
    setChiuso(true)
    try {
      localStorage.setItem(CHIAVE_INIZIO, '1')
    } catch {}
  }
  return (
    <section className="frame home-inizio" aria-label={t('home.start.title')}>
      <h2>{t('home.start.title')}</h2>
      <ol>
        <li><button className="link" onClick={() => onZona('avvio')}>{t('home.start.run')}</button></li>
        <li>{t('home.start.search')}</li>
        <li><button className="link" onClick={() => onZona('review')}>{t('home.start.review')}</button></li>
      </ol>
      <button className="ghost small" onClick={chiudi}>{t('home.start.close')}</button>
    </section>
  )
}

export function HomeZone({ repo, onZona, onBranch }: { repo: string; onZona: (id: string) => void; onBranch: (d: Destinazione) => void }) {
  const [r, setR] = useState<RiassuntoHome | null>(null)
  const [error, setError] = useState('')
  const ultima = useRef(soloUltima<RiassuntoHome>()).current

  const load = useCallback(() => {
    const lettura = (async () => {
      const [status, commit, todo, documenti, lavori, visto] = await Promise.all([
        window.hub.status.read(repo),
        window.hub.git.graph(repo, 300),
        window.hub.todos.list(repo),
        window.hub.docs.list(repo),
        window.hub.lavori.elenco(repo),
        ultimaVisita(repo, window.hub.preferenze.visitaHome)
      ])
      return riassumiHome({ status, commit, todo, documenti, lavori, visto })
    })()
    ultima(lettura, (v) => { setR(v); setError('') }, (e) => setError(message(e)))
  }, [repo, ultima])

  useEffect(() => {
    load()
    const stopArchivio = window.hub.archivio.onChange((quale) => {
      if (quale === repo) load()
    })
    const stopLavori = window.hub.lavori.onChange((quale) => {
      if (quale === repo) load()
    })
    const timer = setInterval(load, AGGIORNA_MS)
    return () => {
      stopArchivio()
      stopLavori()
      clearInterval(timer)
    }
  }, [repo, load])

  if (!r) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">{t('common.readingRepo')}</p>

  const inCorso = r.worktree.length + r.sessioni.length + r.lavori.length
  return (
    <div className="home">
      <DaDoveIniziare onZona={onZona} />
      {error && <p className="error" role="alert">{error}</p>}
      <section>
        <h2>{r.primaVolta ? t('home.latestCommits') : r.nuovi.length ? t('home.newCommits') : t('home.noNewCommits')}</h2>
        {r.nuovi.length + r.recenti.length > 0 && (
          <ul>
            {r.recenti.length > 0 && <li className="meta">{t('home.seenLatest')}</li>}
            {[...r.nuovi, ...r.recenti].map((c) => <Voce key={c.hash} onClick={() => onBranch({ t: 'commit', hash: c.hash })} nota={`${c.author}, ${ago(c.time)}`}>{c.subject}</Voce>)}
            {r.altriNuovi > 0 && <Voce onClick={() => onZona('branch')}>{t('home.moreCommits', { n: r.altriNuovi })}</Voce>}
          </ul>
        )}
      </section>
      <section>
        <h2>{inCorso ? t('home.inProgress') : t('home.nothingInProgress')}</h2>
        {inCorso > 0 && (
          <ul>
            {r.worktree.map((w) => <Voce key={w.path} onClick={() => onBranch({ t: 'worktree', path: w.path })} nota={altraCartella(w.path, repo) + (w.modifiche === 1 ? t('home.uncommitted.one') : t('home.uncommitted.many', { n: w.modifiche }))}>{w.nome}</Voce>)}
            {r.sessioni.map((s) => <Voce key={s.id} onClick={() => onZona('stato')} nota={s.subagenti ? t('home.sessionSub', { n: s.subagenti }) : t('home.session')}>{s.nome}</Voce>)}
            {r.lavori.map((l) => <Voce key={l.id} onClick={() => onZona('anteprima')} nota={t('home.job')}>{l.titolo}</Voce>)}
          </ul>
        )}
      </section>
      {r.sessioniInAttesa > 0 && (
        <section>
          <h2>{t('home.waiting')}</h2>
          <ul><Voce onClick={() => onZona('stato')}>{r.sessioniInAttesa === 1 ? t('home.sessionsWaiting.one') : t('home.sessionsWaiting.many', { n: r.sessioniInAttesa })}</Voce></ul>
        </section>
      )}
      <section>
        <h2>{r.branch.length ? t('home.branchesAhead') : t('home.noBranchesAhead')}</h2>
        {r.branch.length > 0 && (
          <ul>
            {r.branch.map((b) => <Voce key={b.nome} onClick={() => onBranch({ t: 'branch', nome: b.nome })} nota={[b.avanti ? t('home.outsideBase', { n: b.avanti }) : '', b.daInviare ? t('home.toPush', { n: b.daInviare }) : ''].filter(Boolean).join(', ')}>{b.nome}</Voce>)}
            {r.altriBranch > 0 && <Voce onClick={() => onZona('branch')}>{t('home.moreBranches', { n: r.altriBranch })}</Voce>}
          </ul>
        )}
      </section>
      <section>
        <h2>{r.todo.aperte ? t('home.todoCount', { n: r.todo.aperte }) : r.todo.neiDocumenti ? t('home.todoDocs') : t('home.todoNone')}</h2>
        <ul>
          {r.todo.prime.map((voce) => <Voce key={voce} onClick={() => onZona('todo')}>{voce}</Voce>)}
          {r.todo.neiDocumenti > 0 && <Voce onClick={() => onZona('todo')}>{r.todo.neiDocumenti === 1 ? t('home.docItems.one') : t('home.docItems.many', { n: r.todo.neiDocumenti })}</Voce>}
          {!r.todo.prime.length && !r.todo.neiDocumenti && <Voce onClick={() => onZona('todo')}>{t('home.openList')}</Voce>}
        </ul>
      </section>
    </div>
  )
}
