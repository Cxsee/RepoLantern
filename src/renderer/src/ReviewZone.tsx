import { useCallback, useEffect, useState } from 'react'
import { t, type Chiave } from '../../shared/i18n.ts'
import { Conferma } from './AnteprimaZone'
import { message } from './errors'
import type { ReviewFinding, ReviewLocalFinding, ReviewReport, ReviewScope } from './hub'
import { PannelloCodice } from './Ricerca'

const SCOPES: ReviewScope[] = ['local', 'branch', 'project']
const RANK = { high: 0, medium: 1, low: 2 }

function Origin({ repo, file, line }: { repo: string; file: string; line: number }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>{file}:{line}</button>
      {open && <div className="doctor-origine"><PannelloCodice repo={repo} voce={{ file, riga: line, testo: '', tipo: 'codice' }} /></div>}
    </>
  )
}

function AddTodo({ repo, title, file, line, commit }: { repo: string; title: string; file: string; line: number; commit: string }) {
  const [state, setState] = useState<'idle' | 'added' | 'there'>('idle')
  const [error, setError] = useState('')
  if (state !== 'idle') return <span className="meta">{t(state === 'added' ? 'review.todoAdded' : 'review.todoThere')}</span>
  return (
    <>
      <button className="ghost small" onClick={() => window.hub.review.todo(repo, { title, file, line }, commit).then((added) => setState(added ? 'added' : 'there'), (e) => setError(message(e)))}>{t('review.addTodo')}</button>
      {error && <span className="error" role="alert"> {error}</span>}
    </>
  )
}

function Local({ repo, f, commit }: { repo: string; f: ReviewLocalFinding; commit: string }) {
  const title = t(`review.rule.${f.rule}` as Chiave)
  return (
    <li className="review-voce">
      <p><span className={f.kind === 'secret' ? 'pill warn' : 'pill'}>{t(f.kind === 'secret' ? 'review.kind.secret' : 'review.kind.pattern')}</span> <strong>{title}</strong></p>
      <p><code>{f.excerpt}</code></p>
      <p className="meta"><Origin repo={repo} file={f.file} line={f.line} /> <AddTodo repo={repo} title={title} file={f.file} line={f.line} commit={commit} /></p>
    </li>
  )
}

function Problem({ repo, f, commit }: { repo: string; f: ReviewFinding; commit: string }) {
  return (
    <li className="review-voce">
      <p>
        <span className={f.category === 'vulnerability' ? 'pill warn' : 'pill'}>{t(`review.category.${f.category}` as Chiave)}</span>{' '}
        <span className="pill">{t('review.severity', { level: t(`review.level.${f.severity}` as Chiave) })}</span>{' '}
        <span className="pill">{t('review.confidence', { level: t(`review.level.${f.confidence}` as Chiave) })}</span>
      </p>
      <p><strong>{f.title}</strong></p>
      <p>{f.why}</p>
      <p className="meta">{t('review.conditions', { text: f.conditions })}</p>
      <p>{t('review.fix', { text: f.fix })}</p>
      <p className="meta"><Origin repo={repo} file={f.file} line={f.line} /> <AddTodo repo={repo} title={f.title} file={f.file} line={f.line} commit={commit} /></p>
    </li>
  )
}

function Results({ repo, r, head }: { repo: string; r: ReviewReport; head: string | null }) {
  const c = r.claude
  const findings = c ? [...c.findings].sort((a, b) => RANK[a.severity] - RANK[b.severity] || RANK[a.confidence] - RANK[b.confidence]) : []
  const counts = r.skipped.reduce<Record<string, number>>((all, s) => ({ ...all, [s.reason]: (all[s.reason] ?? 0) + 1 }), {})
  const incomplete = r.skipped.some((s) => s.reason === 'budget' || s.reason === 'large')
  return (
    <div className="review-esito">
      <p className="meta">{t('review.checked', { n: r.reviewed, when: new Date(r.when).toLocaleString(), commit: r.commit.slice(0, 8) })}</p>
      {head && head !== r.commit && <p className="error" role="status">{t('review.stale')}</p>}
      {r.scope === 'local' && <p className="meta">{t('review.localNote')}</p>}
      {r.skipped.length > 0 && (
        <details className="doctor-altri">
          <summary>{t('review.skipped', { n: r.skipped.length, list: Object.entries(counts).map(([k, n]) => `${t(`review.reason.${k}` as Chiave)}: ${n}`).join(', ') })}</summary>
          <p className="meta">{r.skipped.slice(0, 200).map((s) => s.file).join(', ')}</p>
        </details>
      )}
      {incomplete && <p className="error" role="status">{t('review.incomplete')}</p>}
      {c && (
        <section>
          <h2>{t('review.claudeTitle')}</h2>
          {c.summary && <p>{c.summary}</p>}
          <p className="meta">{t('review.claudeNote', { cost: c.cost.toFixed(2), seconds: c.seconds })}</p>
          {c.discarded > 0 && <p className="meta">{t('review.discarded', { n: c.discarded })}</p>}
          {findings.length ? <ul className="review-voci">{findings.map((f) => <Problem key={`${f.file}${f.line}${f.title}`} repo={repo} f={f} commit={r.commit} />)}</ul> : <p>{t('review.noFindings')}</p>}
        </section>
      )}
      <section>
        <h2>{t('review.localTitle')}</h2>
        <p className="meta">{t('review.localExplain')}</p>
        {r.local.length ? <ul className="review-voci">{r.local.map((f) => <Local key={`${f.file}${f.line}${f.rule}`} repo={repo} f={f} commit={r.commit} />)}</ul> : <p>{t('review.noLocal')}</p>}
      </section>
    </div>
  )
}

export function ReviewZone({ repo }: { repo: string }) {
  const [scope, setScope] = useState<ReviewScope>('local')
  const [report, setReport] = useState<ReviewReport | null>(null)
  const [head, setHead] = useState<string | null>(null)
  const [busy, setBusy] = useState<'local' | 'claude' | null>(null)
  const [error, setError] = useState('')
  const [nothing, setNothing] = useState(false)

  useEffect(() => {
    let valid = true
    window.hub.review.last(repo).then((v) => {
      if (!valid) return
      setReport(v.report)
      setHead(v.head)
      if (v.report) setScope(v.report.scope)
    }, (e) => valid && setError(message(e)))
    return () => {
      valid = false
    }
  }, [repo])

  const run = useCallback((kind: 'local' | 'claude', job: Promise<ReviewReport | null>) => {
    setBusy(kind)
    setError('')
    setNothing(false)
    job.then((r) => {
      if (r) {
        setReport(r)
        setHead(r.commit)
      } else setNothing(true)
    }, (e) => {
      const text = message(e)
      if (!/annullato|cancel/i.test(text)) setError(text)
    }).finally(() => setBusy(null))
  }, [])

  const cancel = (): void => {
    void window.hub.lavori.elenco(repo).then((all) => all.find((l) => l.titolo === t('review.jobTitle') && (l.stato === 'in-corso' || l.stato === 'in-coda'))).then((l) => l && window.hub.lavori.annulla(repo, l.id))
  }

  return (
    <div className="doctor">
      <p className="meta"><span className="pill warn">{t('review.experimental')}</span> {t('review.intro')}</p>
      <div className="review-ambito" role="radiogroup" aria-label={t('review.scope')}>
        {SCOPES.map((s) => (
          <label key={s}><input type="radio" name="review-scope" checked={scope === s} disabled={busy !== null} onChange={() => setScope(s)} /> <strong>{t(`review.scope.${s}` as Chiave)}</strong> <span className="meta">{t(`review.scopeHelp.${s}` as Chiave)}</span></label>
        ))}
      </div>
      <div className="ante-azioni">
        <button className="ghost" disabled={busy !== null} onClick={() => run('local', window.hub.review.local(repo, scope))}>{t('review.runLocal')}</button>
        {busy === null && <Conferma key={scope} testo={t('review.confirm')} avvia={t('review.runClaude')} onAvvia={() => run('claude', window.hub.review.claude(repo, scope))} />}
      </div>
      {busy === 'local' && <p className="muted">{t('review.runningLocal')}</p>}
      {busy === 'claude' && <p className="muted">{t('review.runningClaude')} <button className="ghost small" onClick={cancel}>{t('review.cancel')}</button></p>}
      {error && <p className="error" role="alert">{error}</p>}
      {nothing && <div className="empty frame"><p>{t(scope === 'branch' ? 'review.nothingBranch' : 'review.nothing')}</p></div>}
      {report && !nothing && <Results repo={repo} r={report} head={head} />}
    </div>
  )
}
