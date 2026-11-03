import { lingua, t } from '../../shared/i18n.ts'

export type GraphCommit = { hash: string; parents: string[] }
export type GraphLine = { from: number; to: number; color: number; hash: string; child: string }
export type GraphRow = { lane: number; color: number; lines: GraphLine[] }

export function ago(when: number): string {
  const relative = new Intl.RelativeTimeFormat(lingua(), { numeric: 'auto' })
  const seconds = Math.round((when - Date.now()) / 1000)
  if (Math.abs(seconds) < 60) return t('time.now')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour')
  const days = Math.round(hours / 24)
  return Math.abs(days) < 45 ? relative.format(days, 'day') : relative.format(Math.round(days / 30), 'month')
}

const COLORS = 6

// Ogni corsia aspetta un commit preciso: quando arriva, le sue linee proseguono verso i genitori.
export function computeGraph(commits: GraphCommit[]): { rows: GraphRow[]; lanes: number } {
  const lanes: ({ hash: string; color: number; child: string } | null)[] = []
  let nextColor = 0
  let widest = 0

  const freeSlot = (): number => {
    const free = lanes.findIndex((l) => l === null)
    return free >= 0 ? free : lanes.length
  }

  const rows = commits.map((commit): GraphRow => {
    let lane = lanes.findIndex((l) => l?.hash === commit.hash)
    if (lane < 0) {
      lane = freeSlot()
      lanes[lane] = { hash: commit.hash, color: nextColor++ % COLORS, child: commit.hash }
    }
    const color = lanes[lane]!.color
    lanes[lane] = null

    const lines: GraphLine[] = []
    for (let i = 0; i < lanes.length; i++) {
      const passing = lanes[i]
      if (passing) lines.push({ from: i, to: i, color: passing.color, hash: passing.hash, child: passing.child })
    }

    commit.parents.forEach((parent, index) => {
      const existing = lanes.findIndex((l) => l?.hash === parent)
      if (existing > lane && index === 0) {
        // Il genitore comune scivola nella corsia più a sinistra, così la linea principale resta dritta.
        const moving = lines.find((l) => l.from === existing && l.to === existing)
        if (moving) moving.to = lane
        lines.push({ from: lane, to: lane, color: lanes[existing]!.color, hash: parent, child: commit.hash })
        lanes[lane] = lanes[existing]
        lanes[existing] = null
        return
      }
      if (existing >= 0) {
        lines.push({ from: lane, to: existing, color: lanes[existing]!.color, hash: parent, child: commit.hash })
        return
      }
      // Il primo genitore continua nella stessa corsia; gli altri aprono un ramo.
      const slot = index === 0 ? lane : freeSlot()
      const laneColor = index === 0 ? color : nextColor++ % COLORS
      lanes[slot] = { hash: parent, color: laneColor, child: commit.hash }
      lines.push({ from: lane, to: slot, color: laneColor, hash: parent, child: commit.hash })
    })

    widest = Math.max(widest, lanes.length, lane + 1)
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    return { lane, color, lines }
  })
  return { rows, lanes: widest }
}

export type RigaGrafo<T> = { tipo: 'commit'; commit: T } | { tipo: 'gruppo'; id: string; commits: T[] }

// Si raggruppa solo un tratto dritto: ogni partenza, unione, testa, ref e radice resta visibile. L'ordine non cambia mai.
export function raggruppaCommit<T extends GraphCommit & { refs?: unknown[] }>(commits: T[], minimo = 3): RigaGrafo<T>[] {
  const noti = new Set(commits.map((c) => c.hash))
  const figli = new Map<string, number>()
  for (const c of commits) for (const p of c.parents) figli.set(p, (figli.get(p) ?? 0) + 1)
  const dritto = (c: T): boolean => !c.refs?.length && c.parents.length === 1 && noti.has(c.parents[0]) && figli.get(c.hash) === 1

  const righe: RigaGrafo<T>[] = []
  let tratto: T[] = []
  const chiudi = (): void => {
    if (tratto.length >= minimo) righe.push({ tipo: 'gruppo', id: tratto[0].hash, commits: tratto })
    else for (const commit of tratto) righe.push({ tipo: 'commit', commit })
    tratto = []
  }
  for (const c of commits) {
    if (!dritto(c)) {
      chiudi()
      righe.push({ tipo: 'commit', commit: c })
      continue
    }
    if (tratto.length && tratto[tratto.length - 1].parents[0] !== c.hash) chiudi()
    tratto.push(c)
  }
  chiudi()
  return righe
}

export function righeVisibili<T extends GraphCommit>(righe: RigaGrafo<T>[], aperti: ReadonlySet<string>): RigaGrafo<T>[] {
  return righe.flatMap((r) => (r.tipo === 'gruppo' && aperti.has(r.id) ? r.commits.map((commit) => ({ tipo: 'commit' as const, commit })) : [r]))
}

export type RigaStoria<T> = { commit: T; gruppo: T[] | null; apreGruppo: string | null }

// Cosa disegnare: un gruppo chiuso è una riga sola che porta dal suo primo commit ai genitori dell'ultimo, così le linee restano giuste.
export function storia<T extends GraphCommit & { refs?: unknown[] }>(commits: T[], aperti: ReadonlySet<string>, minimo = 3): RigaStoria<T>[] {
  return raggruppaCommit(commits, minimo).flatMap((r): RigaStoria<T>[] => {
    if (r.tipo === 'commit') return [{ commit: r.commit, gruppo: null, apreGruppo: null }]
    if (aperti.has(r.id)) return r.commits.map((commit, i) => ({ commit, gruppo: null, apreGruppo: i === 0 ? r.id : null }))
    return [{ commit: { ...r.commits[0], parents: r.commits[r.commits.length - 1].parents }, gruppo: r.commits, apreGruppo: null }]
  })
}

// Le frecce partono dalla riga dove sta la tastiera, anche se è un gruppo; altrimenti dal commit scelto.
export function rigaVicina(righe: { hash: string }[], daRiga: string | null, scelto: string | null, avanti: boolean): string | null {
  const dove = righe.findIndex((r) => r.hash === (daRiga ?? scelto))
  return righe[Math.min(righe.length - 1, Math.max(0, dove + (avanti ? 1 : -1)))]?.hash ?? null
}

export function ancestorsOf(tip: string, commits: GraphCommit[]): Set<string> {
  const parents = new Map(commits.map((c) => [c.hash, c.parents]))
  const seen = new Set<string>()
  const stack = [tip]
  while (stack.length) {
    const hash = stack.pop()!
    if (seen.has(hash)) continue
    seen.add(hash)
    stack.push(...(parents.get(hash) ?? []))
  }
  return seen
}

export type DiffRow =
  | { tipo: 'hunk'; testo: string }
  | { tipo: 'uguale' | 'tolta' | 'aggiunta'; testo: string; vecchia: number | null; nuova: number | null }
  | { tipo: 'nota'; testo: string }

export function parseUnifiedDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = []
  let [before, after, inHunk] = [0, 0, false]
  for (const line of text.split(/\r?\n/)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (hunk) {
      before = Number(hunk[1])
      after = Number(hunk[2])
      inHunk = true
      rows.push({ tipo: 'hunk', testo: hunk[3].trim() ? `… ${hunk[3].trim()}` : '…' })
    } else if (!inHunk) {
      continue
    } else if (line.startsWith('+')) {
      rows.push({ tipo: 'aggiunta', testo: line.slice(1), vecchia: null, nuova: after++ })
    } else if (line.startsWith('-')) {
      rows.push({ tipo: 'tolta', testo: line.slice(1), vecchia: before++, nuova: null })
    } else if (line.startsWith('\\')) {
      rows.push({ tipo: 'nota', testo: t('git.noNewline') })
    } else if (line.startsWith(' ')) {
      rows.push({ tipo: 'uguale', testo: line.slice(1), vecchia: before++, nuova: after++ })
    } else if (line.startsWith('diff --git')) {
      inHunk = false
    }
  }
  return rows
}
