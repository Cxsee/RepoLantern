// L'albero è la spiegazione: tronco = branch base, rami col nome = branch, foglie chiare = commit, mele = worktree.
// Più in alto sul tronco vuol dire più recente: un ramo parte dall'altezza del commit da cui si è staccato.
import { t } from '../../shared/i18n.ts'

type Ref = { nome: string; tipo: string }
export type TreeCommit = { hash: string; parents: string[]; refs: Ref[]; time: number }
export type TreeWorktree = { path: string; branch: string | null; head: string; modificati: number; nuovi: number }
type Flat = [number, number]

export type Leaf = { hash: string; x: number; y: number; rot: number; size: number }
export type Clump = { back: string; tones: [string, string, string] }
export type Fruit = { path: string; x: number; y: number; stalk: string }
export type Tag = { x: number; y: number; w: number; h: number; leader: string; side: number; nome: string; intero: string; sotto: string; wt: string | null }
export type Limb = {
  id: string
  live: boolean
  nome: string | null
  commits: string[]
  front: boolean
  t: number
  origin: Flat
  tip: Flat
  wood: string
  shade: string
  center: string
  sap: string
  clumps: Clump[]
  leaves: Leaf[]
  tag: Tag | null
  fruit: Fruit | null
  box: { x: number; y: number; w: number; h: number }
}
export type Ground = { shadow: string; mound: string; tufts: string; fallen: string; sign: Flat }
export type Tree = { trunk: { wood: string; shade: string; light: string; bark: string }; ground: Ground; limbs: Limb[]; owner: Map<string, Limb>; bounds: { x: number; y: number; w: number; h: number } }

const HEIGHT = 640
const LIMBS = 12
const MIN_PER_LIMB = 6
const MAX_LEAVES = 150
const LOW = 0.27
const SPAN = 0.7
const SPREAD = 330
const TAG_H = 24
const TAG_H_DOUBLE = 44
const TAG_GAP = 12
const TIP_GAP = 62
const MAX_NAME = 30
const LEAVES_ON_BRANCH = 24

export const trunkAt = (t: number, height = HEIGHT): { p: Flat; r: number } => {
  const k = height / HEIGHT
  return {
    p: [(Math.sin(t * Math.PI * 1.7 + 0.4) * (1 - t * 0.35) - Math.sin(0.4)) * 40 * k, -t * height],
    r: (7 + 36 * (1 - t) ** 1.5 + 30 * Math.exp(-t * 20)) * Math.sqrt(k)
  }
}

// Stessa repo, stesso disegno: il caso dipende dagli hash, così un aggiornamento non fa saltare i rami.
const seeded = (text: string): (() => number) => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

const fmt = (n: number): string => n.toFixed(1)

function smooth(points: Flat[]): string {
  if (!points.length) return ''
  let d = `M${fmt(points[0][0])} ${fmt(points[0][1])}`
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b, c, e] = [points[i - 1] ?? points[i], points[i], points[i + 1], points[i + 2] ?? points[i + 1]]
    d += ` C${fmt(b[0] + (c[0] - a[0]) / 6)} ${fmt(b[1] + (c[1] - a[1]) / 6)} ${fmt(c[0] - (e[0] - b[0]) / 6)} ${fmt(c[1] - (e[1] - b[1]) / 6)} ${fmt(c[0])} ${fmt(c[1])}`
  }
  return d
}

const normalAt = (points: Flat[], i: number): Flat => {
  const [a, b] = [points[i - 1] ?? points[i], points[i + 1] ?? points[i]]
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  return [-(b[1] - a[1]) / len, (b[0] - a[0]) / len]
}

const offset = (points: Flat[], radii: number[], f: number): Flat[] => points.map((p, i) => {
  const n = normalAt(points, i)
  return [p[0] + n[0] * radii[i] * f, p[1] + n[1] * radii[i] * f]
})

// Una fascia lungo il ramo, tra due frazioni del suo spessore: -1 e 1 sono i bordi.
const band = (points: Flat[], radii: number[], from: number, to: number): string => `${smooth(offset(points, radii, from))} L${smooth(offset(points, radii, to).reverse()).slice(1)} Z`

// Un arco che esce dal punto di partenza e si alza verso la punta, con una leggera incertezza da legno vero.
function curve(from: Flat, control: Flat, to: Flat, wander: number, rnd: () => number, count = 14): Flat[] {
  const [phase, last] = [rnd() * 6.28, count - 1]
  return Array.from({ length: count }, (_, i): Flat => {
    const u = i / last
    const [x, y] = [(1 - u) ** 2 * from[0] + 2 * u * (1 - u) * control[0] + u * u * to[0], (1 - u) ** 2 * from[1] + 2 * u * (1 - u) * control[1] + u * u * to[1]]
    return [x, y + Math.sin(u * 6.28 + phase) * wander * 4 * u * (1 - u)]
  })
}

const taper = (count: number, start: number, end: number, power = 0.8): number[] => Array.from({ length: count }, (_, i) => start + (end - start) * (i / (count - 1)) ** power)

const leafShape = (x: number, y: number, rot: number, size: number): string => {
  const [cos, sin] = [Math.cos(rot), Math.sin(rot)]
  const [tx, ty, mx, my] = [x + cos * size, y + sin * size, x + (cos * size) / 2, y + (sin * size) / 2]
  const [px, py] = [-sin * size * 0.36, cos * size * 0.36]
  return `M${fmt(x)} ${fmt(y)}Q${fmt(mx + px)} ${fmt(my + py)} ${fmt(tx)} ${fmt(ty)}Q${fmt(mx - px)} ${fmt(my - py)} ${fmt(x)} ${fmt(y)}Z`
}

// Una massa di foglie: la luce viene da sinistra in alto, quindi lì le foglie sono più chiare.
function foliage(cx: number, cy: number, r: number, rnd: () => number): Clump {
  const outline = Array.from({ length: 10 }, (_, i): Flat => {
    const [a, d] = [(i / 10) * Math.PI * 2, r * (0.72 + rnd() * 0.22)]
    return [cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.84]
  })
  const tones: Clump['tones'] = ['', '', '']
  const count = Math.round((r * r) / 34) + 12
  for (let i = 0; i < count; i++) {
    const [a, d] = [rnd() * Math.PI * 2, Math.sqrt(rnd()) * 1.06]
    const light = -Math.cos(a) * d * 0.6 - Math.sin(a) * d * 0.8 + (rnd() - 0.5) * 0.7
    const tone = light > 0.32 ? 2 : light > -0.28 ? 1 : 0
    tones[tone] += leafShape(cx + Math.cos(a) * d * r, cy + Math.sin(a) * d * r * 0.84, a + (rnd() - 0.5) * 1.5, 11 + rnd() * 6)
  }
  return { back: `${smooth([...outline, outline[0], outline[1]])}Z`, tones }
}

function boxOf(points: Flat[]): Limb['box'] {
  const [xs, ys] = [points.map((p) => p[0]), points.map((p) => p[1])]
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

const around = (cx: number, cy: number, r: number): Flat[] => [[cx - r, cy - r], [cx + r, cy + r]]

// Le foglie dei commit stanno sopra la massa, in ordine sparso e rivolte in fuori.
function commitLeaves(hashes: string[], cx: number, cy: number, r: number, rnd: () => number): Leaf[] {
  return hashes.map((hash, i) => {
    const [a, d] = [rnd() * Math.PI * 2, r * 0.86 * Math.sqrt((i + 0.5) / hashes.length)]
    return { hash, x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d * 0.84, rot: a + (rnd() - 0.5), size: 13 }
  })
}

// Un tratto di storia: un ramo principale che si divide, con una massa di foglie per ogni punta.
function buildHistory(input: { id: string; commits: string[]; t: number; side: number; front: boolean; crown: boolean; reach: number; rise: number; scale: number; height: number; trunkLine: (t: number) => Flat[] }): Limb {
  const { id, commits, t, side, front, crown, reach, rise, scale, height, trunkLine } = input
  const rnd = seeded(id)
  const at = trunkAt(t, height)
  const origin: Flat = crown ? at.p : [at.p[0] + side * at.r * 0.3, at.p[1]]
  const tip: Flat = crown ? [at.p[0] + 4, at.p[1] - 124 * scale] : [origin[0] + side * reach, origin[1] - rise]
  const control: Flat = crown ? [at.p[0] + 2, at.p[1] - 12] : [origin[0] + side * reach * 0.55, origin[1] - rise * 0.08]
  const points = curve(origin, control, tip, crown ? 0 : 7, rnd)
  const radii = taper(points.length, crown ? at.r : Math.max(4, at.r * 0.5), 1.6)
  let wood = band(points, radii, -1, 1)
  let shade = band(points, radii, 0.1, 1)

  // Quante punte: una storia corta non si divide.
  const shown = commits.slice(-MAX_LEAVES).reverse()
  const count = crown && scale > 0.5 ? 3 : shown.length >= 12 ? 3 : shown.length >= 6 ? 2 : 1
  const ends: Flat[] = [tip]
  const span = crown ? 118 * scale : reach * 0.42
  for (let i = 1; i < count; i++) {
    const start = points[Math.round((points.length - 1) * (crown ? 0.5 : i === 1 ? 0.62 : 0.42))]
    const end: Flat = crown ? [start[0] + (i === 1 ? -span : span), start[1] - span * 0.3] : [start[0] + side * span * (0.72 + rnd() * 0.3), start[1] + (i === 1 ? -span * (0.62 + rnd() * 0.3) : span * (0.12 + rnd() * 0.2))]
    const twig = curve(start, [start[0] + (end[0] - start[0]) * 0.55, start[1] + (end[1] - start[1]) * 0.15], end, 3, rnd, 8)
    const r = taper(twig.length, Math.max(2.2, radii[Math.round(points.length * 0.55)] * 0.72), 1.2)
    wood += band(twig, r, -1, 1)
    shade += band(twig, r, 0.1, 1)
    ends.push(end)
  }

  const clumps: Clump[] = []
  const leaves: Leaf[] = []
  const places: Flat[] = [...points]
  const per = Math.ceil(shown.length / count)
  // Una massa senza commit più vicina al tronco: la chioma è piena, non fatta di palle in fondo ai rami.
  if (!crown && scale > 0.5) {
    const [ix, iy] = points[Math.round((points.length - 1) * 0.5)]
    const r = 46 * (0.62 + 0.38 * scale)
    clumps.push(foliage(ix, iy - r * 0.3, r, rnd))
  }
  ends.forEach((end, i) => {
    const part = shown.slice(i * per, (i + 1) * per)
    const r = (crown ? 58 : 44 + Math.sqrt(part.length) * 6 + rnd() * 10) * (0.62 + 0.38 * scale)
    const [cx, cy]: Flat = [end[0] + (crown ? 0 : side * r * 0.24), end[1] - r * 0.18]
    clumps.push(foliage(cx, cy, r, rnd))
    leaves.push(...commitLeaves(part, cx, cy, r, rnd))
    places.push(...around(cx, cy, r * 1.1))
  })
  return { id, live: false, nome: null, commits, front, t, origin, tip, wood, shade, center: smooth(points), sap: smooth([...trunkLine(t), ...points]), clumps, leaves, tag: null, fruit: null, box: boxOf(places) }
}

// Un branch: più sottile del legno vecchio, esce dalla chioma e porta le sue foglie una per una.
function buildBranch(input: { id: string; nome: string; commits: string[]; t: number; side: number; reach: number; tipY: number; height: number; trunkLine: (t: number) => Flat[] }): Limb {
  const { id, nome, commits, t, side, reach, tipY, height, trunkLine } = input
  const rnd = seeded(id)
  const at = trunkAt(t, height)
  const origin: Flat = [at.p[0] + side * at.r * 0.3, at.p[1]]
  const tip: Flat = [origin[0] + side * reach, tipY]
  const points = curve(origin, [origin[0] + side * reach * 0.62, Math.max(origin[1], tipY) + 6], tip, 5, rnd)
  const shown = commits.slice(-MAX_LEAVES).reverse()
  const radii = taper(points.length, Math.min(10, 3.6 + Math.sqrt(shown.length) * 1.1), 1)
  const leaves: Leaf[] = []
  const clumps: Clump[] = []
  const places: Flat[] = [...points]
  if (shown.length <= LEAVES_ON_BRANCH) {
    // Lungo l'ultimo tratto, alternate come sui rametti veri: il commit più recente è in punta.
    shown.forEach((hash, i) => {
      const u = 1 - (i / LEAVES_ON_BRANCH) * 0.55
      const p = points[Math.round(u * (points.length - 1))]
      const rot = i === 0 ? (side > 0 ? -0.5 : Math.PI + 0.5) : (side > 0 ? 0 : Math.PI) + (i % 2 ? 1 : -1) * side * 0.95 + (rnd() - 0.5) * 0.3
      leaves.push({ hash, x: p[0], y: p[1], rot, size: 24 })
      places.push([p[0] + Math.cos(rot) * 24, p[1] + Math.sin(rot) * 24])
    })
  } else {
    const r = 34 + Math.sqrt(shown.length) * 4
    const [cx, cy]: Flat = [tip[0] + side * r * 0.3, tip[1] - r * 0.2]
    clumps.push(foliage(cx, cy, r, rnd))
    leaves.push(...commitLeaves(shown, cx, cy, r, rnd))
    places.push(...around(cx, cy, r * 1.1))
  }
  return { id, live: true, nome, commits, front: true, t, origin, tip, wood: band(points, radii, -1, 1), shade: band(points, radii, 0.1, 1), center: smooth(points), sap: smooth([...trunkLine(t), ...points]), clumps, leaves, tag: null, fruit: null, box: boxOf(places) }
}

function addTag(limb: Limb, side: number, intero: string, wt: TreeWorktree | null, tags: Tag[]): void {
  const nome = intero.length > MAX_NAME ? `${intero.slice(0, MAX_NAME - 1)}…` : intero
  const folder = wt?.path.replaceAll('\\', '/').split('/').pop() ?? ''
  const dirty = wt ? wt.modificati + wt.nuovi : 0
  const sotto = wt ? `${folder}${dirty ? ` · ${t('common.unsaved', { n: dirty })}` : ''}` : ''
  const w = Math.max(nome.length * 11, Math.min(sotto.length, 36) * 8.6) + 12
  limb.tag = { x: 0, y: limb.tip[1] - 12, w, h: wt ? TAG_H_DOUBLE : TAG_H, leader: '', side, nome, intero, sotto, wt: wt?.path ?? null }
  if (wt) {
    const [tx, ty] = limb.tip
    limb.fruit = { path: wt.path, x: tx - side * 9, y: ty + 25, stalk: `M${fmt(tx - side * 3)} ${fmt(ty + 1)} Q${fmt(tx - side * 5)} ${fmt(ty + 7)} ${fmt(tx - side * 9)} ${fmt(ty + 15)}` }
  }
  tags.push(limb.tag)
}

// I nomi di un lato si distanziano dall'alto in basso, così restano leggibili.
export function spreadTags(tags: Tag[], gap = TAG_GAP): void {
  for (const side of [-1, 1]) {
    const row = tags.filter((t) => t.side === side).sort((a, b) => a.y - b.y)
    row.forEach((tag, i) => {
      const previous = row[i - 1]
      if (previous) tag.y = Math.max(tag.y, previous.y + previous.h + gap)
    })
  }
}

function buildGround(width: number): Ground {
  const rnd = seeded('terra')
  const top = (x: number): number => -Math.max(0, 1 - (x / width) ** 2) * 16
  const xs = Array.from({ length: 13 }, (_, i) => -width + (i / 12) * width * 2)
  const mound = `${smooth(xs.map((x): Flat => [x, top(x) + (rnd() - 0.5) * 2]))} Q0 46 ${fmt(-width)} 0 Z`
  let tufts = ''
  for (let i = 0; i < 46; i++) {
    const x = (rnd() * 2 - 1) * width * 0.9
    if (Math.abs(x) < 42) continue
    const y = top(x) + 1 + rnd() * 14
    for (const lean of [-4, 0, 4]) tufts += `M${fmt(x)} ${fmt(y)}q${fmt(lean * 0.2)} -6 ${fmt(lean)} ${fmt(-7 - rnd() * 5)}`
  }
  let fallen = ''
  for (let i = 0; i < 16; i++) {
    const x = (rnd() * 2 - 1) * width * 0.86
    fallen += leafShape(x, top(x) + 4 + rnd() * 14, rnd() * 0.8 - 0.4, 9 + rnd() * 4)
  }
  const wide = width * 1.08
  return { shadow: `M${fmt(-wide)} 18 A${fmt(wide)} 30 0 0 0 ${fmt(wide)} 18 A${fmt(wide)} 30 0 0 0 ${fmt(-wide)} 18 Z`, mound, tufts, fallen, sign: [width * 0.42, top(width * 0.42) + 6] }
}

export function buildTree(commits: TreeCommit[], base: string | null, branches: string[], worktrees: TreeWorktree[]): Tree {
  const byHash = new Map(commits.map((c) => [c.hash, c]))
  const tipOf = (name: string): TreeCommit | undefined => commits.find((c) => c.refs.some((r) => r.tipo === 'locale' && r.nome === name))
  const baseTip = (base && tipOf(base)) || commits[0]

  // La linea del tronco: i primi genitori della base, dal più vecchio al più nuovo.
  const line: string[] = []
  for (let c = baseTip; c; c = byHash.get(c.parents[0])!) line.unshift(c.hash)
  const inTrunk = new Set(line)
  const reachable = new Set<string>()
  const stack = baseTip ? [baseTip.hash] : []
  while (stack.length) {
    const hash = stack.pop()!
    if (reachable.has(hash) || !byHash.has(hash)) continue
    reachable.add(hash)
    stack.push(...byHash.get(hash)!.parents)
  }
  const position = new Map(line.map((h, i) => [h, i]))
  const heightOf = (hash: string | undefined): number => {
    if (!line.length || !hash) return LOW
    let index = position.get(hash)
    if (index === undefined) {
      // Un commit entrato con un'unione: vale il punto del tronco più vicino nel tempo.
      const time = byHash.get(hash)?.time ?? 0
      index = line.findIndex((h) => byHash.get(h)!.time >= time)
      if (index < 0) index = line.length - 1
    }
    return LOW + SPAN * (index / Math.max(1, line.length - 1))
  }

  const per = Math.max(MIN_PER_LIMB, Math.ceil(line.length / LIMBS))
  const chunks: string[][] = []
  for (let i = 0; i < line.length; i += per) chunks.push(line.slice(i, i + per))
  // Poca storia, albero giovane: più basso e con la chioma più stretta.
  const scale = Math.min(1, Math.max(0.5, Math.sqrt(chunks.length / LIMBS)))
  const height = HEIGHT * (0.3 + 0.7 * scale * scale)
  const reachAt = (t: number): number => SPREAD * scale * (0.35 + 0.65 * Math.sin(Math.PI * (0.12 + (0.85 * (t - LOW)) / SPAN)))
  const trunkLine = (t: number): Flat[] => Array.from({ length: 16 }, (_, i) => trunkAt((t * i) / 15, height).p)

  const limbs: Limb[] = []
  const tags: Tag[] = []
  const worktreeOf = (name: string): TreeWorktree | null => worktrees.find((w) => w.branch === name) ?? null

  chunks.forEach((chunk, i) => {
    const crown = i === chunks.length - 1
    const t = crown ? 1 : LOW + SPAN * ((i + 0.5) / Math.max(1, chunks.length - 1))
    const rnd = seeded(chunk[0])
    const side = (i + (rnd() > 0.82 ? 1 : 0)) % 2 ? 1 : -1
    const reach = reachAt(t) * (0.8 + rnd() * 0.32)
    const f = (t - LOW) / SPAN
    limbs.push(buildHistory({ id: `storia-${chunk[0]}`, commits: chunk, t, side, front: crown || i % 3 !== 0, crown, reach, rise: reach * (0.16 + 0.8 * f) * (0.85 + rnd() * 0.3), scale, height, trunkLine }))
  })
  const crown = limbs[limbs.length - 1]
  if (crown && base) addTag(crown, 1, base, worktreeOf(base), tags)

  // I branch veri, ognuno col suo nome: escono oltre la chioma e stanno davanti.
  const names = branches.filter((b) => b !== base)
  const detached = worktrees.filter((w) => !w.branch)
  const live = [...names.map((nome) => ({ nome, wt: worktreeOf(nome), tip: tipOf(nome) })), ...detached.map((wt) => ({ nome: t('tree.noBranchHead', { head: wt.head }), wt, tip: commits.find((c) => c.hash.startsWith(wt.head)) }))]
    .map((item) => {
      const chain: string[] = []
      let c = item.tip
      while (c && !reachable.has(c.hash)) {
        chain.unshift(c.hash)
        c = byHash.get(c.parents[0])
      }
      return { ...item, chain: chain.filter((h) => !inTrunk.has(h)), fork: c?.hash }
    })
    .sort((a, b) => heightOf(a.fork) - heightOf(b.fork))
  const load: Record<number, number> = { [-1]: 0, 1: 0 }
  const lastTip: Record<number, number> = { [-1]: Infinity, 1: Infinity }
  for (const item of live) {
    const t = heightOf(item.fork)
    const side = load[-1] <= load[1] ? -1 : 1
    load[side]++
    const reach = reachAt(t) + 74 + Math.min(70, Math.sqrt(item.chain.length) * 11)
    const tipY = Math.min(trunkAt(t, height).p[1] - reach * 0.28, lastTip[side] - TIP_GAP)
    lastTip[side] = tipY
    const limb = buildBranch({ id: `ramo-${item.nome}`, nome: item.nome, commits: item.chain, t, side, reach, tipY, height, trunkLine })
    addTag(limb, side, item.nome, item.wt, tags)
    limbs.push(limb)
  }

  // Nomi in colonna ai lati dell'albero, ognuno legato alla punta del suo ramo da un filo.
  spreadTags(tags)
  const columnAt = (side: number): number => Math.max(SPREAD * scale + 40, ...limbs.map((l) => (side > 0 ? l.box.x + l.box.w : -l.box.x))) + 36
  const column: Record<number, number> = { [-1]: columnAt(-1), 1: columnAt(1) }
  for (const limb of limbs) {
    const tag = limb.tag
    if (!tag) continue
    const side = tag.side
    tag.x = side * column[side]
    const [ax, ay] = [tag.x - side * 8, tag.y + 11]
    const [tx, ty] = limb.tip
    const middle = (tx + ax) / 2
    tag.leader = `M${fmt(tx)} ${fmt(ty)} C${fmt(middle)} ${fmt(ty)} ${fmt(middle)} ${fmt(ay)} ${fmt(ax)} ${fmt(ay)}`
    const b = limb.box
    const [left, right] = side > 0 ? [tag.x, tag.x + tag.w] : [tag.x - tag.w, tag.x]
    const [x1, y1, x2, y2] = [Math.min(b.x, left), Math.min(b.y, tag.y), Math.max(b.x + b.w, right), Math.max(b.y + b.h, tag.y + tag.h)]
    limb.box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
  }

  const owner = new Map<string, Limb>()
  for (const limb of limbs) for (const leaf of limb.leaves) owner.set(leaf.hash, limb)

  const samples = Array.from({ length: 30 }, (_, i) => i / 29)
  const centerline = samples.map((t) => trunkAt(t, height).p)
  const radii = samples.map((t) => trunkAt(t, height).r)
  let wood = band(centerline, radii, -1, 1)
  let shade = band(centerline, radii, 0.25, 1)
  // Radici che affiorano: il tronco non è piantato come un palo.
  for (const [side, length] of [[-1, 62], [-1, 34], [1, 40], [1, 70], [-1, 92], [1, 98]]) {
    const root = curve([side * 16, -10], [side * length * 0.5, -2], [side * length, 8 + (length % 7)], 2, seeded(`${side}${length}`), 7)
    const r = taper(root.length, 14 * Math.sqrt(scale), 1, 0.7)
    wood += band(root, r, -1, 1)
    shade += band(root, r, 0.1, 1)
  }
  // Corteccia: venature lunghe, che seguono il tronco e si interrompono.
  const rnd = seeded('corteccia')
  let bark = ''
  for (const f of [-0.62, -0.3, 0.02, 0.34, 0.66]) {
    const vein = offset(centerline, radii, f)
    for (let i = 1 + Math.floor(rnd() * 3); i + 5 < vein.length; i += 7 + Math.floor(rnd() * 3)) bark += smooth(vein.slice(i, i + 3 + Math.floor(rnd() * 3)))
  }
  const trunk = { wood, shade, light: band(centerline, radii, -0.86, -0.46), bark }
  const ground = buildGround(Math.max(240, SPREAD * scale * 0.92))

  const floor: Flat[] = [[-SPREAD * scale - 40, -height], [SPREAD * scale + 40, 62]]
  const bounds = boxOf([...limbs.flatMap((l): Flat[] => [[l.box.x, l.box.y], [l.box.x + l.box.w, l.box.y + l.box.h]]), ...floor])
  return { trunk, ground, limbs, owner, bounds }
}

// Su e giù percorrono le foglie del ramo; destra e sinistra saltano al ramo più vicino da quella parte.
export function stepFrom(tree: Tree, hash: string, key: 'su' | 'giu' | 'sinistra' | 'destra'): string | null {
  const limb = tree.owner.get(hash)
  if (!limb) return null
  const index = limb.commits.indexOf(hash)
  if (key === 'su') return limb.commits[index + 1] ?? null
  if (key === 'giu') return limb.commits[index - 1] ?? null
  const sign = key === 'destra' ? 1 : -1
  const next = tree.limbs
    .filter((l) => l !== limb && l.commits.length && Math.sign(l.tip[0] - limb.tip[0]) === sign)
    .sort((a, b) => Math.hypot(a.tip[0] - limb.tip[0], a.tip[1] - limb.tip[1]) - Math.hypot(b.tip[0] - limb.tip[0], b.tip[1] - limb.tip[1]))[0]
  return next ? next.commits[next.commits.length - 1] : null
}
