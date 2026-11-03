import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { t } from '../../shared/i18n.ts'
import { buildTree, stepFrom, type Limb, type Tree } from './tree'
import { ago } from './gitGraph'
import type { LogCommit, Worktree } from './hub'

const MIN_ZOOM = 0.25
const MAX_ZOOM = 5
const LEAF_ZOOM = 2.2
const BRANCH_ZOOM = 1.7
const INTRO_MS = 400

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
const stillMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const leafPath = (s: number): string => `M0 0 Q${s * 0.45} ${-s * 0.42} ${s} 0 Q${s * 0.45} ${s * 0.42} 0 0 Z`

type Camera = { x: number; y: number; z: number }
type Box = { x: number; y: number; w: number; h: number }

const Crop = ({ limb, selected, query, byHash }: { limb: Limb; selected: string | null; query: string; byHash: Map<string, LogCommit> }) => (
  <g className="arbor-crop" style={{ transformOrigin: `${limb.tip[0]}px ${limb.tip[1]}px` }}>
    {limb.clumps.map((clump, i) => (
      <g key={i}>
        <path className="arbor-mass" d={clump.back} data-limb={limb.id} />
        {clump.tones.map((d, tone) => <path key={tone} className={`arbor-tone t${tone}`} d={d} />)}
      </g>
    ))}
    {limb.leaves.map((leaf) => {
      const c = byHash.get(leaf.hash)
      const match = !query || (c && (c.subject.toLowerCase().includes(query) || c.hash.startsWith(query) || c.author.toLowerCase().includes(query)))
      return (
        <g key={leaf.hash} className={match ? 'arbor-leaf-at' : 'arbor-leaf-at dim'} transform={`translate(${leaf.x.toFixed(1)} ${leaf.y.toFixed(1)}) rotate(${((leaf.rot * 180) / Math.PI).toFixed(0)})`}>
          {leaf.hash === selected && <circle className="arbor-halo" r={leaf.size * 0.95} cx={leaf.size / 2} />}
          <path className="arbor-leaf" d={leafPath(leaf.size)} data-hash={leaf.hash} role="button" aria-label={c?.subject ?? leaf.hash} />
        </g>
      )
    })}
  </g>
)

const LimbSvg = ({ limb, order, active, selected, query, byHash }: { limb: Limb; order: number; active: Limb | null; selected: string | null; query: string; byHash: Map<string, LogCommit> }) => {
  const off = active && active !== limb
  const origin = `${limb.origin[0]}px ${limb.origin[1]}px`
  const style = { '--d': `${(0.5 + limb.t * 0.9 + (order % 3) * 0.04).toFixed(2)}s`, transformOrigin: origin } as CSSProperties
  const { fruit } = limb
  return (
    <g className={`arbor-limb${limb.live ? ' live' : ''}${limb.front ? '' : ' back'}${off ? ' dim' : ''}${active === limb ? ' on' : ''}`} style={style} data-limb={limb.id}>
      <g className="arbor-sway" style={{ transformOrigin: origin }}>
        <path className="arbor-wood" d={limb.wood} />
        <path className="arbor-wood-shade" d={limb.shade} />
        <path className="arbor-hit" d={limb.center} />
        <Crop limb={limb} selected={selected} query={query} byHash={byHash} />
        {fruit && (
          <g className="arbor-fruit" data-wt={fruit.path} role="button" aria-label={t('tree.worktreeLabel', { name: fruit.path.replaceAll('\\', '/').split('/').pop() ?? '' })}>
            <path className="arbor-stalk" d={fruit.stalk} />
            <path className="f0" d={`M${fruit.x} ${fruit.y - 8} C${fruit.x + 6} ${fruit.y - 13} ${fruit.x + 13} ${fruit.y - 8} ${fruit.x + 12} ${fruit.y} C${fruit.x + 11} ${fruit.y + 9} ${fruit.x + 5} ${fruit.y + 13} ${fruit.x} ${fruit.y + 11} C${fruit.x - 5} ${fruit.y + 13} ${fruit.x - 11} ${fruit.y + 9} ${fruit.x - 12} ${fruit.y} C${fruit.x - 13} ${fruit.y - 8} ${fruit.x - 6} ${fruit.y - 13} ${fruit.x} ${fruit.y - 8} Z`} />
            <ellipse className="f2" cx={fruit.x - 5} cy={fruit.y - 3} rx={2} ry={3.4} />
          </g>
        )}
      </g>
    </g>
  )
}

const Label = ({ limb, active }: { limb: Limb; active: Limb | null }) => {
  const tag = limb.tag!
  const anchor = tag.side > 0 ? 'start' : 'end'
  const off = active && active !== limb
  return (
    <g className={`arbor-label${off ? ' dim' : ''}${active === limb ? ' on' : ''}${limb.live ? ' live' : ''}`} style={{ '--d': `${(1 + limb.t * 0.9).toFixed(2)}s` } as CSSProperties}>
      <path className="arbor-leader" d={tag.leader} />
      <circle className="arbor-knot" cx={tag.x - tag.side * 8} cy={tag.y + 11} r={2.4} />
      <text className="arbor-name" x={tag.x} y={tag.y + 16} textAnchor={anchor} data-branch={tag.intero} role="button" aria-label={t('tree.branchLabel', { name: tag.intero })}>{tag.nome}<title>{tag.intero}</title></text>
      {tag.wt && <text className="arbor-where" x={tag.x} y={tag.y + 37} textAnchor={anchor} data-wt={tag.wt}>{tag.sotto}</text>}
    </g>
  )
}

const Scene = memo(function Scene({ tree, repoName, byHash, active, selected, query }: { tree: Tree; repoName: string; byHash: Map<string, LogCommit>; active: Limb | null; selected: string | null; query: string }) {
  const props = { active, selected, query, byHash }
  const back = tree.limbs.filter((l) => !l.front)
  const front = tree.limbs.filter((l) => l.front)
  const { ground, trunk } = tree
  const [sx, sy] = ground.sign
  return (
    <>
      <g className="arbor-ground">
        <path className="arbor-shadow" d={ground.shadow} />
        <path className="arbor-earth" d={ground.mound} />
        <path className="arbor-tufts" d={ground.tufts} />
        <path className="arbor-fallen" d={ground.fallen} />
      </g>
      {back.map((l, i) => <LimbSvg key={l.id} limb={l} order={i} {...props} />)}
      <g className="arbor-trunk">
        <path className="arbor-wood" d={trunk.wood} />
        <path className="arbor-wood-shade" d={trunk.shade} />
        <path className="arbor-wood-light" d={trunk.light} />
        <path className="arbor-bark" d={trunk.bark} />
      </g>
      {front.map((l, i) => <LimbSvg key={l.id} limb={l} order={i + back.length} {...props} />)}
      {active && <path key={active.id} className="arbor-sap" d={active.sap} pathLength={1} />}
      <g className="arbor-sign">
        <path className="arbor-post" d={`M${sx - 2} ${sy - 26} h4 v28 h-4 Z`} />
        <rect x={sx - 62} y={sy - 44} width={124} height={22} rx={3} />
        <text x={sx} y={sy - 29} textAnchor="middle">{repoName.replace(/[<&]/g, '').slice(0, 14)}</text>
      </g>
      {tree.limbs.filter((l) => l.tag).map((l) => <Label key={l.id} limb={l} active={active} />)}
    </>
  )
})

export function BranchTree({ repoName, commits, base, branches, worktrees, selected, activeBranch, panelOpen, search, hasMore, onSelect, onBranch, onWorktree, onMore }: {
  repoName: string
  commits: LogCommit[]
  base: string | null
  branches: string[]
  worktrees: Worktree[]
  selected: string | null
  activeBranch: string | null
  panelOpen: boolean
  search: string
  hasMore: boolean
  onSelect: (hash: string) => void
  onBranch: (name: string) => void
  onWorktree: (path: string) => void
  onMore: () => void
}) {
  const branchKey = branches.join('\n')
  const wtKey = JSON.stringify(worktrees.map((w) => [w.path, w.branch, w.head, w.modificati, w.nuovi]))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tree = useMemo(() => buildTree(commits, base, branches, worktrees), [commits, base, branchKey, wtKey])
  const byHash = useMemo(() => new Map(commits.map((c) => [c.hash, c])), [commits])
  const [hover, setHover] = useState<string | null>(null)
  const [light, setLight] = useState(() => window.matchMedia('(prefers-color-scheme: light)').matches)
  const box = useRef<HTMLDivElement>(null)
  const world = useRef<SVGGElement>(null)
  const cam = useRef<Camera>({ x: 0, y: 0, z: 1 })
  const frame = useRef(0)
  const dragged = useRef(false)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; time: number } | null>(null)
  const wheel = useRef<{ z: number; px: number; py: number } | null>(null)
  const started = useRef(false)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (): void => setLight(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const activeLimb = useMemo(() => {
    if (activeBranch) return tree.limbs.find((l) => l.tag?.intero === activeBranch) ?? null
    return selected ? tree.owner.get(selected) ?? null : null
  }, [tree, activeBranch, selected])

  const apply = useCallback(() => {
    const { x, y, z } = cam.current
    world.current?.setAttribute('transform', `translate(${x} ${y}) scale(${z})`)
  }, [])

  const stop = (): void => {
    cancelAnimationFrame(frame.current)
    wheel.current = null
  }

  // Si vola sul centro della vista: lontano ci si allontana un po' a metà strada, come una camera vera.
  const flyTo = useCallback((cx: number, cy: number, z: number) => {
    const el = box.current
    if (!el) return
    stop()
    const from = cam.current
    const [fromX, fromY] = [(el.clientWidth / 2 - from.x) / from.z, (el.clientHeight / 2 - from.y) / from.z]
    const distance = Math.hypot(cx - fromX, cy - fromY) * Math.min(from.z, z)
    const place = (e: number): void => {
      // Le misure si rileggono a ogni fotogramma: nel frattempo il pannello può aprirsi o chiudersi.
      const [w, h] = [el.clientWidth, el.clientHeight]
      const dip = 1 - Math.min(0.4, distance / (4 * Math.max(w, 1))) * Math.sin(Math.PI * e)
      const zoom = clampZoom((from.z + (z - from.z) * e) * dip)
      const [mx, my] = [fromX + (cx - fromX) * e, fromY + (cy - fromY) * e]
      cam.current = { x: w / 2 - mx * zoom, y: h / 2 - my * zoom, z: zoom }
      apply()
    }
    if (stillMotion()) return place(1)
    const duration = 700 + Math.min(600, distance * 0.3)
    const start = performance.now()
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / duration)
      place(easeInOut(t))
      if (t < 1) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [apply])

  const fitOf = useCallback((b: Box, limit: number): { x: number; y: number; z: number } | null => {
    const el = box.current
    if (!el) return null
    // La larghezza a pannello aperto o chiuso, non quella di questo istante: il pannello sta ancora scorrendo.
    const shell = el.parentElement?.clientWidth ?? el.clientWidth
    const width = shell - el.offsetLeft - (panelOpen ? Math.max(330, shell * 0.34) : 0)
    const z = clampZoom(Math.min(limit, (width - 70) / Math.max(b.w, 1), (el.clientHeight - 90) / Math.max(b.h, 1)))
    return { x: b.x + b.w / 2, y: b.y + b.h / 2, z }
  }, [panelOpen])

  const whole: Box = tree.bounds

  const showAll = useCallback(() => {
    const f = fitOf(whole, 1.15)
    if (f) flyTo(f.x, f.y, f.z)
  }, [fitOf, flyTo, whole])

  // All'apertura l'albero cresce con la camera vicina, poi ci si allontana per vederlo intero.
  useEffect(() => {
    const el = box.current
    if (started.current || !el || !el.clientWidth) return
    started.current = true
    const f = fitOf(whole, 1.15)
    if (!f) return
    const z = f.z * 1.12
    cam.current = { x: el.clientWidth / 2 - f.x * z, y: el.clientHeight / 2 - (f.y + 40) * z, z }
    apply()
    setTimeout(() => flyTo(f.x, f.y, f.z), stillMotion() ? 0 : INTRO_MS)
  })

  // Seguire la scelta fatta altrove: elenco, pannello, frecce.
  useEffect(() => {
    if (!started.current) return
    if (activeBranch) {
      const limb = tree.limbs.find((l) => l.tag?.intero === activeBranch)
      const f = limb && fitOf(limb.box, BRANCH_ZOOM)
      if (f) flyTo(f.x, f.y, f.z)
      return
    }
    if (selected) {
      const leaf = tree.owner.get(selected)?.leaves.find((l) => l.hash === selected)
      if (leaf) flyTo(leaf.x, leaf.y, Math.max(cam.current.z, LEAF_ZOOM))
      return
    }
    showAll()
    // Solo quando cambia la scelta: un aggiornamento dei dati non deve muovere la vista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, activeBranch])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // Quando il pannello si apre o si chiude la vista cambia misura: ciò che era al centro resta al centro.
  useEffect(() => {
    const el = box.current
    if (!el) return
    let [w, h] = [el.clientWidth, el.clientHeight]
    const watcher = new ResizeObserver(() => {
      cam.current = { ...cam.current, x: cam.current.x + (el.clientWidth - w) / 2, y: cam.current.y + (el.clientHeight - h) / 2 }
      w = el.clientWidth
      h = el.clientHeight
      apply()
    })
    watcher.observe(el)
    return () => watcher.disconnect()
  }, [apply])

  // La rotella deve restare ferma sotto il cursore; React registra onWheel come passivo.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const running = wheel.current
      wheel.current = { z: clampZoom((running?.z ?? cam.current.z) * Math.exp(-e.deltaY * 0.0014)), px: e.clientX - rect.left, py: e.clientY - rect.top }
      if (running) return
      cancelAnimationFrame(frame.current)
      const tick = (): void => {
        const target = wheel.current
        if (!target) return
        const { x, y, z } = cam.current
        const next = z + (target.z - z) * 0.2
        const scale = next / z
        cam.current = { x: target.px - (target.px - x) * scale, y: target.py - (target.py - y) * scale, z: next }
        apply()
        if (Math.abs(target.z - next) / target.z < 0.002) wheel.current = null
        else frame.current = requestAnimationFrame(tick)
      }
      frame.current = requestAnimationFrame(tick)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [apply])

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || (e.target as Element).closest('.tree-hud')) return
    stop()
    dragged.current = false
    drag.current = { x: e.clientX, y: e.clientY, vx: 0, vy: 0, time: performance.now() }
  }

  const onPointerMove = (e: PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const [dx, dy] = [e.clientX - d.x, e.clientY - d.y]
    if (!dragged.current && Math.hypot(dx, dy) < 4) return
    if (!dragged.current) box.current?.setPointerCapture(e.pointerId)
    dragged.current = true
    const now = performance.now()
    const dt = Math.max(1, now - d.time)
    drag.current = { x: e.clientX, y: e.clientY, vx: dx / dt, vy: dy / dt, time: now }
    cam.current = { ...cam.current, x: cam.current.x + dx, y: cam.current.y + dy }
    apply()
  }

  // Lasciando il trascinamento la vista scivola ancora un po' e rallenta.
  const onPointerUp = (): void => {
    const d = drag.current
    drag.current = null
    if (!d || !dragged.current || stillMotion() || performance.now() - d.time > 80) return
    let [vx, vy] = [d.vx * 16, d.vy * 16]
    const tick = (): void => {
      vx *= 0.92
      vy *= 0.92
      cam.current = { ...cam.current, x: cam.current.x + vx, y: cam.current.y + vy }
      apply()
      if (Math.hypot(vx, vy) > 0.3) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }

  const onClick = (e: MouseEvent): void => {
    if (dragged.current) return
    const target = e.target as Element
    const wt = target.closest('[data-wt]')?.getAttribute('data-wt')
    if (wt) return onWorktree(wt)
    const branch = target.closest('[data-branch]')?.getAttribute('data-branch')
    if (branch) return onBranch(branch)
    const hash = target.closest('[data-hash]')?.getAttribute('data-hash')
    if (hash) return onSelect(hash)
    const id = target.closest('[data-limb]')?.getAttribute('data-limb')
    const limb = id ? tree.limbs.find((l) => l.id === id) : null
    if (!limb) return
    if (limb.live && limb.tag) onBranch(limb.tag.intero)
    else if (limb.commits.length) onSelect(limb.commits[limb.commits.length - 1])
  }

  const onOver = (e: PointerEvent): void => setHover((e.target as Element).closest('[data-hash]')?.getAttribute('data-hash') ?? null)

  const onKey = (e: KeyboardEvent): void => {
    const keys: Record<string, 'su' | 'giu' | 'sinistra' | 'destra'> = { ArrowUp: 'su', ArrowDown: 'giu', ArrowLeft: 'sinistra', ArrowRight: 'destra' }
    const key = keys[e.key]
    if (!key) return
    e.preventDefault()
    if (!selected || !tree.owner.has(selected)) {
      const first = activeLimb?.commits.at(-1) ?? commits[0]?.hash
      if (first) onSelect(first)
      return
    }
    const next = stepFrom(tree, selected, key)
    if (next) onSelect(next)
  }

  const zoomBy = (factor: number): void => {
    const el = box.current
    if (!el) return
    const { x, y, z } = cam.current
    flyTo((el.clientWidth / 2 - x) / z, (el.clientHeight / 2 - y) / z, clampZoom(z * factor))
  }

  const shown = hover ?? selected
  const info = shown ? byHash.get(shown) : null

  return (
    <div className="tree" data-theme={light ? 'light' : 'dark'} ref={box} tabIndex={0} role="group" aria-label={t('tree.aria')} onKeyDown={onKey} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerOver={onOver} onClick={onClick}>
      <svg className="arbor-svg"><g ref={world}><Scene tree={tree} repoName={repoName} byHash={byHash} active={activeLimb} selected={selected} query={search.trim().toLowerCase()} /></g></svg>
      <div className="tree-hud tree-tools">
        <button className="ghost" aria-label={t('tree.zoomIn')} onClick={() => zoomBy(1.5)}>+</button>
        <button className="ghost" aria-label={t('tree.zoomOut')} onClick={() => zoomBy(1 / 1.5)}>−</button>
        <button className="ghost" onClick={showAll}>{t('tree.showAll')}</button>
        {hasMore && <button className="ghost" onClick={onMore}>{t('tree.loadMore')}</button>}
      </div>
      <ul className="tree-hud arbor-legend" aria-label={t('tree.legend')}>
        <li><svg viewBox="-1 -6 14 12"><path className="arbor-leaf" d={leafPath(12)} /></svg>{t('tree.legendLeaf')}</li>
        <li className="live"><svg viewBox="-1 -6 14 12"><path className="arbor-leaf" d={leafPath(12)} /></svg>{t('tree.legendLimb')}</li>
        <li><svg viewBox="0 0 14 14"><circle className="f0" cx="7" cy="7" r="6" /></svg>{t('tree.legendApple')}</li>
        <li>{t('tree.legendUp')}</li>
      </ul>
      {info && (
        <div className="tree-hud tree-info" aria-live="polite">
          <span className="tree-info-hash">{info.hash.slice(0, 8)}</span>
          <span className="truncate">{info.subject}</span>
          <span className="commit-when">{ago(info.time)}</span>
        </div>
      )}
    </div>
  )
}
