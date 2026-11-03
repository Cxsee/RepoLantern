import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { locale, t } from '../../shared/i18n.ts'
import { BranchTree } from './BranchTree'
import { message } from './errors'
import type { Destinazione } from './HomeZone'
import { ago, ancestorsOf, computeGraph, parseUnifiedDiff, type GraphRow, rigaVicina, storia } from './gitGraph'
import type { Branch, BranchDetail, ChangedFile, CommitDetail, DiffResult, FileStat, LogCommit, Status, Worktree } from './hub'

const PAGE = 1000
const ROW = 34
const LANE = 14
const MAX_LANES = 14
const REFRESH_MS = 10_000

type Step =
  | { t: 'branch'; nome: string }
  | { t: 'worktree'; path: string }
  | { t: 'commit'; hash: string }
  | { t: 'file'; origine: { t: 'commit'; hash: string } | { t: 'branch'; nome: string } | { t: 'worktree'; path: string }; path: string }

const norm = (p: string): string => p.replaceAll('\\', '/').toLowerCase()

function shortPath(path: string, repo: string): string {
  const [p, r] = [path.replaceAll('\\', '/'), repo.replaceAll('\\', '/')]
  if (norm(p) === norm(r)) return t('common.mainFolder')
  return norm(p).startsWith(norm(r) + '/') ? p.slice(r.length + 1) : p
}

function fileParts(path: string): { dir: string; base: string } {
  const clean = path.replace(/\/$/, '')
  const i = clean.lastIndexOf('/')
  return { dir: i >= 0 ? clean.slice(0, i + 1) : '', base: clean.slice(i + 1) + (path.endsWith('/') ? '/' : '') }
}

const STATUS_LABEL = (s: string): { label: string; tone: string } => {
  if (s === '??') return { label: t('branch.state.new'), tone: 's-add' }
  if (s.includes('D')) return { label: t('branch.state.deleted'), tone: 's-del' }
  if (s.includes('R')) return { label: t('branch.state.renamed'), tone: 's-mod' }
  if (s.includes('A')) return { label: t('branch.state.added'), tone: 's-add' }
  if (s.includes('U')) return { label: t('branch.state.conflict'), tone: 's-del' }
  return { label: t('branch.state.modified'), tone: 's-mod' }
}

function DistanceBar({ avanti, indietro }: { avanti: number; indietro: number }) {
  const scale = (n: number): number => (n <= 0 ? 0 : Math.min(100, 12 + Math.log10(n + 1) * 34))
  return (
    <span className="distance" aria-hidden="true">
      <span className="distance-side back"><i style={{ width: `${scale(indietro)}%` }} /></span>
      <span className="distance-side ahead"><i style={{ width: `${scale(avanti)}%` }} /></span>
    </span>
  )
}

function Rail({ repo, status, step, search, onPick }: { repo: string; status: Status; step: Step | undefined; search: string; onPick: (s: Step) => void }) {
  const q = search.trim().toLowerCase()
  const worktrees = status.worktree.filter((w) => !q || (w.branch ?? '').toLowerCase().includes(q) || w.path.toLowerCase().includes(q))
  const branches = status.branch.filter((b) => !q || b.nome.toLowerCase().includes(q))
  const inWorktree = new Set(status.worktree.map((w) => w.branch))

  const groups = useMemo(() => {
    const map = new Map<string, Branch[]>()
    for (const b of branches) {
      const slash = b.nome.indexOf('/')
      const key = slash > 0 ? b.nome.slice(0, slash) : ''
      map.set(key, [...(map.get(key) ?? []), b])
    }
    return [...map].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
  }, [branches])

  const branchButton = (b: Branch, label: string) => {
    const on = step?.t === 'branch' && step.nome === b.nome
    const isBase = b.nome === status.base
    const detail = isBase ? t('branch.base') : t('branch.aheadBehind', { ahead: b.avanti, behind: b.indietro })
    return (
      <li key={b.nome}>
        <button className={on ? 'nav-item on' : 'nav-item'} aria-current={on ? 'true' : undefined} onClick={() => onPick({ t: 'branch', nome: b.nome })}>
          <span className="nav-title">
            {inWorktree.has(b.nome) && <span className="wt-mark" title={t('branch.inWorktree')} aria-label={t('branch.inWorktree')} />}
            <span className="truncate" title={b.nome}>{label}</span>
          </span>
          <span className="nav-meta">
            {!isBase && <DistanceBar avanti={b.avanti} indietro={b.indietro} />}
            <span className="truncate">{detail}</span>
          </span>
        </button>
      </li>
    )
  }

  return (
    <div className="rail">
      <section>
        <h2 className="eyebrow">{t('branch.worktrees')} <span className="count">{worktrees.length}</span></h2>
        <ul className="nav-list">
          {worktrees.map((w) => {
            const on = step?.t === 'worktree' && norm(step.path) === norm(w.path)
            const dirty = w.modificati + w.nuovi
            return (
              <li key={w.path}>
                <button className={on ? 'nav-item on' : 'nav-item'} aria-current={on ? 'true' : undefined} disabled={w.manca} onClick={() => onPick({ t: 'worktree', path: w.path })}>
                  <span className="nav-title"><span className="wt-mark" aria-hidden="true" /><span className="truncate" title={w.branch ?? w.head}>{w.branch ?? t('branch.noBranchHead', { head: w.head })}</span></span>
                  <span className="nav-meta">
                    <span className="truncate" title={w.path}>{w.manca ? t('branch.folderGone') : shortPath(w.path, repo).replace('.claude/worktrees/', '')}</span>
                    {dirty > 0 && <span className="dirty">{t('common.unsaved', { n: dirty })}</span>}
                  </span>
                </button>
              </li>
            )
          })}
          {worktrees.length === 0 && <li className="meta">{t('branch.noResults')}</li>}
        </ul>
      </section>
      <section>
        <h2 className="eyebrow">{t('branch.branches')} <span className="count">{branches.length}</span></h2>
        {groups.map(([group, items]) =>
          group ? (
            <details key={group} className="nav-group" open>
              <summary>{group}/ <span className="count">{items.length}</span></summary>
              <ul className="nav-list">{items.map((b) => branchButton(b, b.nome.slice(group.length + 1)))}</ul>
            </details>
          ) : (
            <ul key="radice" className="nav-list">{items.map((b) => branchButton(b, b.nome))}</ul>
          )
        )}
        {branches.length === 0 && <p className="meta">{t('branch.noResults')}</p>}
      </section>
    </div>
  )
}

const GraphSvg = memo(function GraphSvg({ rows, commits, focus, selected, lanes }: { rows: GraphRow[]; commits: LogCommit[]; focus: Set<string> | null; selected: string | null; lanes: number }) {
  const x = (lane: number): number => Math.min(lane, MAX_LANES - 1) * LANE + LANE / 2 + 4
  const y = (row: number): number => row * ROW + ROW / 2
  return (
    <svg className="graph-svg" width={x(Math.min(lanes, MAX_LANES)) + 2} height={rows.length * ROW} aria-hidden="true">
      {rows.flatMap((row, r) =>
        row.lines.map((l, i) => {
          const [x1, x2, y1, y2] = [x(l.from), x(l.to), y(r), y(r + 1)]
          const d = x1 === x2 ? `M${x1} ${y1} V${y2}` : `M${x1} ${y1} C${x1} ${y1 + ROW * 0.6} ${x2} ${y2 - ROW * 0.6} ${x2} ${y2}`
          return <path key={`${r}-${i}`} d={d} className={`lane c${l.color}${focus && !(focus.has(l.hash) && focus.has(l.child)) ? ' dim' : ''}`} />
        })
      )}
      {rows.map((row, r) => {
        const commit = commits[r]
        const tip = commit.refs.some((ref) => ref.tipo === 'locale' || ref.tipo === 'head')
        const dim = focus && !focus.has(commit.hash)
        return (
          <g key={commit.hash} className={dim ? 'dim' : ''}>
            {commit.hash === selected && <circle cx={x(row.lane)} cy={y(r)} r={8.5} className={`halo c${row.color}`} />}
            <circle cx={x(row.lane)} cy={y(r)} r={tip ? 5 : 3.5} className={`${commit.parents.length > 1 ? 'node merge' : 'node'} c${row.color}`} />
          </g>
        )
      })}
    </svg>
  )
})

function Graph({ commits, focus, selected, search, hasMore, onSelect, onBranch, onMore }: {
  commits: LogCommit[]
  focus: Set<string> | null
  selected: string | null
  search: string
  hasMore: boolean
  onSelect: (hash: string) => void
  onBranch: (name: string) => void
  onMore: () => void
}) {
  const q = search.trim().toLowerCase()
  const [aperti, setAperti] = useState<ReadonlySet<string>>(new Set())
  const corrisponde = useCallback((c: LogCommit): boolean => !q || c.subject.toLowerCase().includes(q) || c.hash.startsWith(q) || c.author.toLowerCase().includes(q) || c.refs.some((r) => r.nome.toLowerCase().includes(q)), [q])
  // Un commit scelto o cercato non resta mai nascosto dentro un gruppo chiuso.
  const righe = useMemo(() => {
    const prova = storia(commits, aperti)
    const daAprire = prova.filter((r) => r.gruppo?.some((c) => c.hash === selected || (q && corrisponde(c)))).map((r) => r.commit.hash)
    return daAprire.length ? storia(commits, new Set([...aperti, ...daAprire])) : prova
  }, [commits, aperti, selected, q, corrisponde])
  const visibili = useMemo(() => righe.map((r) => r.commit), [righe])
  const { rows, lanes } = useMemo(() => computeGraph(visibili), [visibili])
  const scroller = useRef<HTMLDivElement>(null)
  const width = Math.min(lanes, MAX_LANES) * LANE + 12

  // Mostra sempre il commit scelto, senza spostare la vista se è già visibile.
  useEffect(() => {
    const el = scroller.current
    const index = visibili.findIndex((c) => c.hash === selected)
    if (!el || index < 0) return
    const top = index * ROW
    if (top < el.scrollTop || top + ROW > el.scrollTop + el.clientHeight) el.scrollTo({ top: Math.max(0, top - el.clientHeight / 3) })
  }, [selected, visibili])

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const daRiga = (e.target as HTMLElement).closest<HTMLElement>('[data-hash]')?.dataset.hash ?? null
    const next = rigaVicina(visibili, daRiga, selected, e.key === 'ArrowDown')
    if (next) onSelect(next)
  }

  return (
    <div className="graph" ref={scroller} onKeyDown={onKey}>
      <div className="graph-body" style={{ height: rows.length * ROW }}>
        <GraphSvg rows={rows} commits={visibili} focus={focus} selected={selected} lanes={lanes} />
        <ol className="graph-rows" aria-label={t('branch.commits')}>
          {righe.map(({ commit: c, gruppo, apreGruppo }) => {
            const on = c.hash === selected
            const dim = (!corrisponde(c) && !gruppo) || (focus && !focus.has(c.hash))
            if (gruppo) {
              return (
                <li key={c.hash} data-hash={c.hash} className={`commit-row commit-gruppo${dim ? ' dim' : ''}`} style={{ paddingLeft: width }}>
                  <button className="commit-hit" aria-expanded={false} onClick={() => setAperti((a) => new Set([...a, c.hash]))}>
                    <span className="commit-subject">{t('branch.nCommits', { n: gruppo.length })}</span>
                    <span className="commit-who">{t('branch.from', { subject: gruppo[gruppo.length - 1].subject })}</span>
                    <span className="commit-when">{ago(gruppo[0].time)}</span>
                  </button>
                </li>
              )
            }
            return (
              <li key={c.hash} data-hash={c.hash} className={`${on ? 'commit-row on' : 'commit-row'}${dim ? ' dim' : ''}`} style={{ paddingLeft: width }}>
                <button className="commit-hit" aria-current={on ? 'true' : undefined} onClick={() => onSelect(c.hash)}>
                  <span className="commit-subject">{c.subject}</span>
                  <span className="commit-who">{c.author}</span>
                  <span className="commit-when">{ago(c.time)}</span>
                </button>
                {apreGruppo && <button className="ref" title={t('branch.collapseTitle')} onClick={() => setAperti((a) => new Set([...a].filter((x) => x !== apreGruppo)))}>{t('branch.collapse')}</button>}
                {c.refs.length > 0 && (
                  <span className="refs">
                    {c.refs.map((r) =>
                      r.tipo === 'locale' ? (
                        <button key={r.nome} className="ref local" title={t('branch.open', { name: r.nome })} onClick={() => onBranch(r.nome)}>{r.nome}</button>
                      ) : (
                        <span key={`${r.tipo}${r.nome}`} className={`ref ${r.tipo}`} title={r.nome}>{r.nome}</span>
                      )
                    )}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      </div>
      {hasMore && <div className="graph-more"><button className="ghost" onClick={onMore}>{t('branch.loadMore', { n: PAGE })}</button></div>}
      {commits.length === 0 && <p className="muted graph-empty">{t('branch.noCommits')}</p>}
    </div>
  )
}

function Stats({ add, del }: { add: number | null; del: number | null }) {
  if (add === null || del === null) return <span className="stats">{t('branch.binary')}</span>
  return (
    <span className="stats">
      {add > 0 && <span className="plus">+{add}</span>}
      {del > 0 && <span className="minus">−{del}</span>}
    </span>
  )
}

function FileList({ files, onOpen }: { files: FileStat[]; onOpen: (path: string) => void }) {
  const [add, del] = files.reduce(([a, d], f) => [a + (f.add ?? 0), d + (f.del ?? 0)], [0, 0])
  return (
    <>
      <h3 className="eyebrow insp-label">{t('branch.changedFiles')} <span className="count">{files.length}</span> <Stats add={add} del={del} /></h3>
      <ul className="file-list">
        {files.map((f) => {
          const { dir, base } = fileParts(f.path)
          return (
            <li key={f.path}>
              <button onClick={() => onOpen(f.path)} title={f.da ? t('branch.was', { name: f.da }) : f.path}>
                <span className="file-name"><span className="file-dir">{dir}</span>{base}</span>
                <Stats add={f.add} del={f.del} />
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}

function CommitList({ commits, onOpen }: { commits: LogCommit[]; onOpen: (hash: string) => void }) {
  return (
    <ul className="mini-commits">
      {commits.map((c) => (
        <li key={c.hash}>
          <button onClick={() => onOpen(c.hash)}>
            <span className="truncate">{c.subject}</span>
            <span className="commit-when">{ago(c.time)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    load().then(
      (d) => {
        if (!live) return
        setData(d)
        setError('')
      },
      (e) => {
        if (!live) return
        setData(null)
        setError(message(e))
      }
    )
    return () => {
      live = false
    }
  }, [...deps, tick])
  return { data, error, reload: () => setTick((t) => t + 1) }
}

function DiffView({ diff }: { diff: DiffResult }) {
  const rows = useMemo(() => (diff.nuovo ? [] : parseUnifiedDiff(diff.testo)), [diff])
  if (diff.cartella) return <p className="muted">{t('branch.newFolder')}</p>
  if (diff.binario) return <p className="muted">{t('branch.binaryFile')}</p>
  if (diff.nuovo) {
    if (!diff.testo) return <p className="muted">{t('branch.emptyFile')}</p>
    const lines = diff.testo.replace(/\n$/, '').split(/\r?\n/)
    return (
      <>
        <div className="code-view"><table><tbody>{lines.map((l, i) => <tr key={i} className="d-aggiunta"><td className="ln" /><td className="ln">{i + 1}</td><td className="code">{l}</td></tr>)}</tbody></table></div>
        {diff.tagliato && <p className="meta">{t('branch.longFile')}</p>}
      </>
    )
  }
  if (rows.length === 0) return <p className="muted">{diff.tagliato ? t('branch.diffTooBig') : t('branch.noDiff')}</p>
  return (
    <>
      <div className="code-view">
        <table>
          <tbody>
            {rows.map((r, i) =>
              r.tipo === 'hunk' || r.tipo === 'nota' ? (
                <tr key={i} className={r.tipo === 'hunk' ? 'd-hunk' : 'd-nota'}><td className="ln" /><td className="ln" /><td className="code">{r.testo}</td></tr>
              ) : (
                <tr key={i} className={`d-${r.tipo}`}><td className="ln">{r.vecchia ?? ''}</td><td className="ln">{r.nuova ?? ''}</td><td className="code">{r.testo}</td></tr>
              )
            )}
          </tbody>
        </table>
      </div>
      {diff.tagliato && <p className="meta">{t('branch.longDiff')}</p>}
    </>
  )
}

function Loading({ error }: { error: string }) {
  return error ? <p className="error" role="alert">{error}</p> : <p className="muted">{t('common.reading')}</p>
}

function CommitInspector({ repo, hash, onFile, onBranch }: { repo: string; hash: string; onFile: (path: string) => void; onBranch: (name: string) => void }) {
  const { data, error } = useLoad<CommitDetail>(() => window.hub.git.commit(repo, hash), [repo, hash])
  if (!data) return <Loading error={error} />
  return (
    <>
      <p className="eyebrow">{t('branch.commitN', { hash: hash.slice(0, 8) })}</p>
      <h2 className="insp-title">{data.subject}</h2>
      {data.body && <p className="commit-body">{data.body}</p>}
      <p className="meta">{data.author} · {new Date(data.time).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })}{data.parents.length > 1 ? ` · ${t('branch.merge')}` : ''}</p>
      {data.refs.some((r) => r.tipo === 'locale') && (
        <div className="refs insp-refs">
          {data.refs.filter((r) => r.tipo === 'locale').map((r) => <button key={r.nome} className="ref local" onClick={() => onBranch(r.nome)}>{r.nome}</button>)}
        </div>
      )}
      {data.files.length ? <FileList files={data.files} onOpen={onFile} /> : <p className="muted insp-label">{t('branch.noFiles')}</p>}
    </>
  )
}

function BranchInspector({ repo, branch, status, onCommit, onFile, onChat, onError }: { repo: string; branch: Branch; status: Status; onCommit: (hash: string) => void; onFile: (path: string) => void; onChat: (cwd: string, titolo: string) => void; onError: (e: string) => void }) {
  const base = status.base
  const { data, error } = useLoad<BranchDetail>(() => (base ? window.hub.git.branch(repo, branch.nome, base) : Promise.resolve({ commits: [], files: [] })), [repo, branch.nome, base, branch.data])
  const worktree = status.worktree.find((w) => w.branch === branch.nome && !w.manca)
  const isBase = branch.nome === base
  const upstream = !branch.upstream ? t('branch.localOnly') : branch.upstreamSparito ? t('branch.goneRemote') : !branch.upstreamAvanti && !branch.upstreamIndietro ? t('branch.inSync') : [branch.upstreamAvanti && t('home.toPush', { n: branch.upstreamAvanti }), branch.upstreamIndietro && t('branch.toPull', { n: branch.upstreamIndietro })].filter(Boolean).join(', ')
  return (
    <>
      <p className="eyebrow">{t('branch.kind.branch')}</p>
      <h2 className="insp-title mono-title">{branch.nome}</h2>
      <dl className="insp-facts">
        <div className="fact"><dt>{isBase ? t('branch.role') : t('branch.relativeTo', { base: base ?? '' })}</dt><dd>{isBase ? t('branch.isBase') : t('branch.aheadBehindDot', { ahead: branch.avanti, behind: branch.indietro })}</dd></div>
        <div className="fact"><dt>{t('branch.remote')}</dt><dd>{upstream}</dd></div>
        <div className="fact"><dt>{t('branch.lastCommit')}</dt><dd>{ago(new Date(branch.data).getTime())}</dd></div>
      </dl>
      <div className="insp-actions">
        {worktree && <button onClick={() => onChat(worktree.path, branch.nome)}>{t('branch.chatHere')}</button>}
        {worktree && <button className="ghost" onClick={() => window.hub.open.vscode(repo, worktree.path).catch((e) => onError(message(e)))}>VS Code</button>}
        {status.github && branch.upstream && !branch.upstreamSparito && <button className="ghost" onClick={() => window.hub.open.github(repo, branch.nome).catch((e) => onError(message(e)))}>GitHub</button>}
      </div>
      {!worktree && <p className="meta">{t('branch.notInWorktree')}</p>}
      {!isBase && (data ? (
        <>
          <h3 className="eyebrow insp-label">{t('branch.onlyHere')} <span className="count">{data.commits.length}{data.commits.length === 200 ? '+' : ''}</span></h3>
          {data.commits.length ? <CommitList commits={data.commits} onOpen={onCommit} /> : <p className="muted">{t('branch.nothingNew', { base: base ?? '' })}</p>}
          {data.files.length > 0 && <FileList files={data.files} onOpen={onFile} />}
        </>
      ) : <Loading error={error} />)}
    </>
  )
}

function WorktreeInspector({ repo, worktree, refresh, onFile, onBranch, onChat, onError }: { repo: string; worktree: Worktree; refresh: number; onFile: (path: string) => void; onBranch: (name: string) => void; onChat: (cwd: string, titolo: string) => void; onError: (e: string) => void }) {
  const { data, error } = useLoad<ChangedFile[]>(() => window.hub.git.worktreeChanges(repo, worktree.path), [repo, worktree.path, refresh])
  return (
    <>
      <p className="eyebrow">{t('branch.kind.worktree')}</p>
      <h2 className="insp-title mono-title">{shortPath(worktree.path, repo).replace('.claude/worktrees/', '')}</h2>
      <p className="meta" title={worktree.path}>{worktree.path}</p>
      {worktree.branch && <div className="refs insp-refs"><button className="ref local" onClick={() => onBranch(worktree.branch!)}>{worktree.branch}</button></div>}
      <div className="insp-actions">
        <button onClick={() => onChat(worktree.path, worktree.branch ?? t('branch.kind.worktree'))}>{t('branch.chatHere')}</button>
        <button className="ghost" onClick={() => window.hub.open.vscode(repo, worktree.path).catch((e) => onError(message(e)))}>VS Code</button>
        <button className="ghost" onClick={() => window.hub.open.terminal(repo, worktree.path).catch((e) => onError(message(e)))}>{t('branch.terminal')}</button>
        <button className="ghost" onClick={() => window.hub.open.folder(repo, worktree.path).catch((e) => onError(message(e)))}>{t('branch.folder')}</button>
      </div>
      {data ? (
        <>
          <h3 className="eyebrow insp-label">{t('branch.uncommitted')} <span className="count">{data.length}</span></h3>
          {data.length === 0 ? <p className="muted">{t('branch.allSaved')}</p> : (
            <ul className="file-list">
              {data.map((f) => {
                const { dir, base } = fileParts(f.path)
                const s = STATUS_LABEL(f.stato)
                return (
                  <li key={f.path}>
                    <button onClick={() => onFile(f.path)} title={f.da ? t('branch.was', { name: f.da }) : f.path}>
                      <span className="file-name"><span className="file-dir">{dir}</span>{base}</span>
                      <span className={`file-state ${s.tone}`}>{s.label}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      ) : <Loading error={error} />}
    </>
  )
}

function FileInspector({ repo, step, base }: { repo: string; step: Extract<Step, { t: 'file' }>; base: string | null }) {
  const { origine, path } = step
  const { data, error } = useLoad<DiffResult>(() => {
    if (origine.t === 'commit') return window.hub.git.commitDiff(repo, origine.hash, path)
    if (origine.t === 'branch') return window.hub.git.branchDiff(repo, origine.nome, base ?? '', path)
    return window.hub.git.worktreeDiff(repo, origine.path, path)
  }, [repo, JSON.stringify(step), base])
  const { dir, base: name } = fileParts(path)
  return (
    <>
      <p className="eyebrow">{t('branch.kind.file')}</p>
      <h2 className="insp-title mono-title">{name}</h2>
      {dir && <p className="meta">{dir}</p>}
      <div className="diff-box">{data ? <DiffView diff={data} /> : <Loading error={error} />}</div>
    </>
  )
}

function stepLabel(step: Step): string {
  if (step.t === 'branch') return step.nome
  if (step.t === 'worktree') return t('branch.kind.worktree')
  if (step.t === 'commit') return step.hash.slice(0, 8)
  return fileParts(step.path).base
}

export function BranchZone({ repo, onChat, destinazione, onDestinazione }: { repo: string; onChat: (cwd: string, titolo: string) => void; destinazione?: Destinazione | null; onDestinazione?: () => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [commits, setCommits] = useState<LogCommit[]>([])
  const [limit, setLimit] = useState(PAGE)
  const [stack, setStack] = useState<Step[]>([])
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'albero' | 'elenco'>('albero')
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const busy = useRef(false)

  const load = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      const [s, g] = await Promise.all([window.hub.status.read(repo), window.hub.git.graph(repo, limit)])
      setStatus(s)
      setCommits((old) => (old.length === g.length && old[0]?.hash === g[0]?.hash && JSON.stringify(old.map((c) => c.refs)) === JSON.stringify(g.map((c) => c.refs)) ? old : g))
      setRefresh((r) => r + 1)
      setError('')
    } catch (e) {
      setError(message(e))
    } finally {
      busy.current = false
    }
  }, [repo, limit])

  useEffect(() => {
    void load()
    window.hub.status.watch(repo).catch(() => {})
    const stop = window.hub.status.onChange((changed) => {
      if (changed === repo) void load()
    })
    const timer = setInterval(() => void load(), REFRESH_MS)
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      stop()
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      void window.hub.status.unwatch()
    }
  }, [repo, load])

  const current = stack[stack.length - 1] as Step | undefined
  const root = stack[0]
  const push = (s: Step): void => setStack((all) => [...all, s])

  const tipOf = useCallback((name: string): string | null => commits.find((c) => c.refs.some((r) => r.tipo === 'locale' && r.nome === name))?.hash ?? null, [commits])

  const worktreeBranch = root?.t === 'worktree' ? status?.worktree.find((w) => norm(w.path) === norm(root.path))?.branch ?? null : null
  const focusTip = root?.t === 'branch' ? tipOf(root.nome) : worktreeBranch ? tipOf(worktreeBranch) : null
  const focus = useMemo(() => (focusTip ? ancestorsOf(focusTip, commits) : null), [focusTip, commits])

  const selected = useMemo(() => {
    const commitStep = [...stack].reverse().find((s) => s.t === 'commit')
    if (commitStep?.t === 'commit') return commitStep.hash
    return focusTip
  }, [stack, focusTip])

  const pickRoot = (s: Step): void => setStack([s])

  // Arrivando dalla Home si apre direttamente ciò che è stato scelto.
  useEffect(() => {
    if (!destinazione) return
    setStack([destinazione.t === 'commit' ? { t: 'commit', hash: destinazione.hash } : destinazione.t === 'branch' ? { t: 'branch', nome: destinazione.nome } : { t: 'worktree', path: destinazione.path }])
    onDestinazione?.()
  }, [destinazione, onDestinazione])
  const openCommit = (hash: string): void => setStack((all) => {
    // Dal grafo si resta dentro al branch aperto, sostituendo il commit precedente.
    const base = all.filter((s) => s.t === 'branch' || s.t === 'worktree')
    return [...base, { t: 'commit', hash }]
  })
  const goBranch = (name: string): void => pickRoot({ t: 'branch', nome: name })

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('input')) setStack((all) => all.slice(0, -1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!status) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">{t('common.readingRepo')}</p>

  const branch = current?.t === 'branch' ? status.branch.find((b) => b.nome === current.nome) : undefined
  const worktree = current?.t === 'worktree' ? status.worktree.find((w) => norm(w.path) === norm(current.path)) : undefined
  const dirty = status.worktree.reduce((sum, w) => sum + w.modificati + w.nuovi, 0)
  const ahead = status.branch.filter((b) => b.upstreamAvanti > 0)

  return (
    <div className={`nav-shell${current ? ' inspector-open' : ''}${view === 'albero' && !current ? ' inspector-hidden' : ''}`}>
      <div className="nav-tools">
        <input type="search" aria-label={t('branch.searchLabel')} placeholder={t('branch.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} />
        {focus && <button className="ghost" onClick={() => setStack([])}>{t('branch.showAll')}</button>}
        <div className="view-switch" role="group" aria-label={t('branch.view')}>
          <button className={view === 'albero' ? 'ghost on' : 'ghost'} aria-pressed={view === 'albero'} onClick={() => setView('albero')}>{t('branch.tree')}</button>
          <button className={view === 'elenco' ? 'ghost on' : 'ghost'} aria-pressed={view === 'elenco'} onClick={() => setView('elenco')}>{t('branch.list')}</button>
        </div>
      </div>
      {error && <p className="error nav-error" role="alert">{error}</p>}
      <Rail repo={repo} status={status} step={root} search={search} onPick={pickRoot} />
      {view === 'albero' ? (
        <BranchTree repoName={repo.replaceAll('\\', '/').split('/').pop() ?? ''} commits={commits} base={status.base} branches={status.branch.map((b) => b.nome)} worktrees={status.worktree.filter((w) => !w.manca)} selected={[...stack].reverse().find((s) => s.t === 'commit')?.t === 'commit' ? selected : null} activeBranch={current?.t === 'branch' ? current.nome : current?.t === 'worktree' ? worktreeBranch : null} panelOpen={!!current} search={search} hasMore={commits.length === limit} onSelect={openCommit} onBranch={goBranch} onWorktree={(path) => pickRoot({ t: 'worktree', path })} onMore={() => setLimit((l) => l + PAGE)} />
      ) : (
        <Graph commits={commits} focus={focus} selected={selected} search={search} hasMore={commits.length === limit} onSelect={openCommit} onBranch={goBranch} onMore={() => setLimit((l) => l + PAGE)} />
      )}
      <aside className="inspector" aria-label={t('branch.details')}>
        {stack.length > 0 && (
          <nav className="insp-crumbs" aria-label={t('branch.path')}>
            <button className="crumb" onClick={() => setStack([])}>{t('app.repo')}</button>
            {stack.map((s, i) => (
              <span key={i}>
                <span className="crumb-sep" aria-hidden="true">/</span>
                <button className="crumb" title={stepLabel(s)} disabled={i === stack.length - 1} aria-current={i === stack.length - 1 ? 'location' : undefined} onClick={() => setStack(stack.slice(0, i + 1))}>{stepLabel(s)}</button>
              </span>
            ))}
          </nav>
        )}
        <div className="insp-body" key={stack.length + (current ? JSON.stringify(current) : '')}>
          {!current && (
            <>
              <p className="eyebrow">{t('branch.overview')}</p>
              <h2 className="insp-title">{status.worktree.length === 1 ? t('branch.nWorktrees.one') : t('branch.nWorktrees.many', { n: status.worktree.length })}, {status.branch.length === 1 ? t('branch.nBranches.one') : t('branch.nBranches.many', { n: status.branch.length })}</h2>
              <dl className="insp-facts">
                <div className="fact"><dt>{t('branch.base')}</dt><dd>{status.base ?? t('branch.baseNotFound')}</dd></div>
                <div className="fact"><dt>{t('branch.filesToSave')}</dt><dd>{dirty}</dd></div>
                <div className="fact"><dt>{t('branch.branchesToPush')}</dt><dd>{ahead.length}</dd></div>
              </dl>
              <p className="muted">{t('branch.help')}</p>
              {status.github && <button className="link" onClick={() => window.hub.open.github(repo, null).catch((e) => setError(message(e)))}>{t('branch.openGithub')}</button>}
            </>
          )}
          {current?.t === 'commit' && <CommitInspector repo={repo} hash={current.hash} onBranch={goBranch} onFile={(path) => push({ t: 'file', origine: { t: 'commit', hash: current.hash }, path })} />}
          {current?.t === 'branch' && (branch ? <BranchInspector repo={repo} branch={branch} status={status} onCommit={openCommit} onChat={onChat} onError={setError} onFile={(path) => push({ t: 'file', origine: { t: 'branch', nome: current.nome }, path })} /> : <p className="muted">{t('branch.branchGone')}</p>)}
          {current?.t === 'worktree' && (worktree ? <WorktreeInspector repo={repo} worktree={worktree} refresh={refresh} onBranch={goBranch} onChat={onChat} onError={setError} onFile={(path) => push({ t: 'file', origine: { t: 'worktree', path: current.path }, path })} /> : <p className="muted">{t('branch.worktreeGone')}</p>)}
          {current?.t === 'file' && <FileInspector repo={repo} step={current} base={status.base} />}
        </div>
      </aside>
    </div>
  )
}
