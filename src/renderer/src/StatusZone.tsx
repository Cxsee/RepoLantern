import { useCallback, useEffect, useRef, useState } from 'react'
import { locale, lingua, t } from '../../shared/i18n.ts'
import { message } from './errors'
import { STATI } from './home'
import type { Session, Status } from './hub'

const REFRESH_MS = 10_000
const ORIGINI: Record<string, string> = { get 'claude-desktop'() { return t('status.origin.desktop') }, get cli() { return t('status.origin.cli') }, get 'sdk-cli'() { return t('status.origin.sdk') } }

function ago(when: number): string {
  const relative = new Intl.RelativeTimeFormat(lingua(), { numeric: 'auto' })
  const seconds = Math.round((when - Date.now()) / 1000)
  if (Math.abs(seconds) < 60) return t('time.now')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour')
  return relative.format(Math.round(hours / 24), 'day')
}

const same = (a: string, b: string): boolean => a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase()

function shortPath(path: string, repo: string): string {
  const [p, r] = [path.replaceAll('\\', '/'), repo.replaceAll('\\', '/')]
  if (same(p, r)) return t('common.mainFolder')
  return p.toLowerCase().startsWith(r.toLowerCase() + '/') ? p.slice(r.length + 1) : p
}

function SessionRow({ session, repo }: { session: Session; repo: string }) {
  const running = session.subagenti.filter((s) => s.attivo)
  const finished = session.subagenti.length - running.length
  return (
    <li className="row">
      <div className="row-main">
        <strong>{session.nome || t('status.unnamed')}</strong>
        {session.stato && <span className={session.stato === 'busy' ? 'pill busy' : 'pill'}>{STATI[session.stato] ?? session.stato}</span>}
      </div>
      <p className="meta">
        {[shortPath(session.cwd, repo), ORIGINI[session.origine] ?? session.origine, ago(session.aggiornata)].filter(Boolean).join(' · ')}
      </p>
      {running.length > 0 && (
        <ul className="subagents">
          {running.map((s) => (
            <li key={s.id}>
              <span className="pill busy">{t('status.subagentRunning')}</span> {s.descrizione}
              <span className="meta"> · {s.tipo ? `${s.tipo} · ` : ''}{ago(s.attivita)}</span>
            </li>
          ))}
        </ul>
      )}
      {finished > 0 && <p className="meta">{finished === 1 ? t('status.finished.one') : t('status.finished.many', { n: finished })}</p>}
    </li>
  )
}

export function StatusZone({ repo, onOpenBranches }: { repo: string; onOpenBranches: () => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState<Date | null>(null)
  const busy = useRef(false)

  const load = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      setStatus(await window.hub.status.read(repo))
      setUpdated(new Date())
      setError('')
    } catch (e) {
      setError(message(e))
    } finally {
      busy.current = false
    }
  }, [repo])

  useEffect(() => {
    void load()
    window.hub.status.watch(repo).catch(() => {})
    const stopChange = window.hub.status.onChange((changed) => {
      if (changed === repo) void load()
    })
    const timer = setInterval(() => void load(), REFRESH_MS)
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      stopChange()
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      void window.hub.status.unwatch()
    }
  }, [repo, load])


  if (!status) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">{t('status.reading')}</p>


  return (
    <>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="meta">
        {updated && t('status.updatedAt', { time: updated.toLocaleTimeString(locale()) })} <button className="link" onClick={() => void load()}>{t('common.refresh')}</button>
      </p>

      <dl className="readouts">
        <div className="readout frame"><dt>{t('status.activeSessions')}</dt><dd>{status.sessioni.length}</dd></div>
        <div className="readout frame"><dt>{t('status.worktreesChanged')}</dt><dd>{status.worktree.filter((w) => w.modificati || w.nuovi).length}/{status.worktree.length}</dd></div>
        <div className="readout frame"><dt>{t('status.branches')}</dt><dd>{status.branch.length}</dd></div>
        <div className="readout frame"><dt>{t('status.toPush')}</dt><dd>{status.branch.reduce((sum, b) => sum + b.upstreamAvanti, 0)}</dd></div>
      </dl>

      <section>
        <h2>{t('status.claudeSessions')} <span className="count">{status.sessioni.length}</span></h2>
        {status.illeggibili > 0 && (
          <p className="warning" role="status">
            {status.illeggibili === 1 ? t('status.unreadable.one') : t('status.unreadable.many', { n: status.illeggibili })}
          </p>
        )}
        {status.sessioni.length === 0 ? (
          <p className="muted">{t('status.noSessions')}</p>
        ) : (
          <ul className="rows">{status.sessioni.map((s) => <SessionRow key={s.id} session={s} repo={repo} />)}</ul>
        )}
      </section>

      <section>
        <button className="ghost" onClick={onOpenBranches}>{t('status.openBranches')}</button>
      </section>
    </>
  )
}
