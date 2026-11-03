import assert from 'node:assert/strict'
import test from 'node:test'
import { ancestorsOf, computeGraph, parseUnifiedDiff, raggruppaCommit, rigaVicina, righeVisibili, storia, type GraphCommit, type RigaGrafo } from './gitGraph.ts'

const c = (hash: string, ...parents: string[]) => ({ hash, parents })

type Nodo = GraphCommit & { refs?: string[] }
const appiattisci = (righe: RigaGrafo<Nodo>[]): string[] => righe.flatMap((r) => (r.tipo === 'commit' ? [r.commit.hash] : r.commits.map((x) => x.hash)))

// Le regole del grafo: valgono per qualsiasi storia, comprese quelle vere nella prova manuale.
function controllaInvarianti(storia: Nodo[]): void {
  const righe = raggruppaCommit(storia)
  assert.deepEqual(appiattisci(righe), storia.map((x) => x.hash), "l'ordine non cambia")
  const figli = new Map<string, number>()
  for (const x of storia) for (const p of x.parents) figli.set(p, (figli.get(p) ?? 0) + 1)
  const visibili = new Set(righe.flatMap((r) => (r.tipo === 'commit' ? [r.commit.hash] : [])))
  for (const x of storia) {
    if (x.refs?.length || x.parents.length !== 1 || figli.get(x.hash) !== 1) assert.ok(visibili.has(x.hash), `${x.hash} deve restare visibile`)
  }
  for (const r of righe) {
    if (r.tipo !== 'gruppo') continue
    r.commits.forEach((x, i) => {
      if (i) assert.equal(r.commits[i - 1].parents[0], x.hash, 'un gruppo è un tratto dritto')
    })
  }
  const gruppi = righe.filter((r) => r.tipo === 'gruppo') as { id: string }[]
  const chiave = (x: RigaGrafo<Nodo>): string => (x.tipo === 'commit' ? x.commit.hash : x.id)
  for (const g of gruppi) {
    const dopo = righeVisibili(righe, new Set([g.id]))
    assert.deepEqual(appiattisci(dopo), storia.map((x) => x.hash), "aprire un gruppo non cambia l'ordine")
    const resto = (l: RigaGrafo<Nodo>[], via: Set<string>): string[] => l.map(chiave).filter((k) => !via.has(k))
    const dentro = new Set([g.id, ...(righe.find((r) => r.tipo === 'gruppo' && r.id === g.id) as { commits: Nodo[] }).commits.map((x) => x.hash)])
    assert.deepEqual(resto(dopo, dentro), resto(righe, dentro), 'aprire un gruppo non sposta il resto')
  }
}

test('un tratto dritto si raggruppa, tutto il resto resta visibile', () => {
  const storia: Nodo[] = [{ ...c('h', 'g'), refs: ['main'] }, c('g', 'f'), c('f', 'e'), c('e', 'd'), { ...c('d', 'c'), refs: ['v1'] }, c('c', 'b'), c('b', 'a'), c('a')]
  const righe = raggruppaCommit(storia)
  assert.deepEqual(righe.map((r) => (r.tipo === 'commit' ? r.commit.hash : `[${r.commits.map((x) => x.hash).join('')}]`)), ['h', '[gfe]', 'd', 'c', 'b', 'a'])
  assert.deepEqual(appiattisci(righeVisibili(righe, new Set(['g']))), storia.map((x) => x.hash))
  assert.equal(righeVisibili(righe, new Set(['g'])).length, 8)
  assert.deepEqual(raggruppaCommit([]), [])
})

test('unioni e partenze interrompono il gruppo, e due linee parallele non si mischiano', () => {
  const storia: Nodo[] = [c('m', 'x3', 'y2'), c('x3', 'x2'), c('y2', 'y1'), c('x2', 'x1'), c('y1', 'b'), c('x1', 'b'), c('b', 'a'), c('a')]
  controllaInvarianti(storia)
  assert.ok(raggruppaCommit(storia).every((r) => r.tipo === 'commit'))
})

test('un commit con il genitore tagliato dalla lista resta visibile', () => {
  const righe = raggruppaCommit([c('e', 'd'), c('d', 'c'), c('c', 'b'), c('b', 'a'), c('a', 'fuori')])
  assert.deepEqual(righe.map((r) => r.tipo), ['commit', 'gruppo', 'commit'])
})

test('gli invarianti reggono su storie casuali', () => {
  let seme = 12345
  const caso = (n: number): number => {
    seme = (seme * 1103515245 + 12345) & 0x7fffffff
    return seme % n
  }
  for (let giro = 0; giro < 200; giro++) {
    const n = 2 + caso(60)
    const storia: Nodo[] = []
    // Si parte dal fondo così ogni genitore viene dopo i suoi figli, come nell'ordine topologico.
    for (let i = 0; i < n; i++) {
      const dopo = n - 1 - i
      const genitori = dopo === 0 ? [] : [`c${i + 1 + caso(Math.min(dopo, 3))}`]
      if (dopo > 1 && caso(6) === 0) genitori.push(`c${i + 1 + caso(dopo)}`)
      storia.push({ hash: `c${i}`, parents: [...new Set(genitori)], refs: caso(8) === 0 ? ['r'] : [] })
    }
    controllaInvarianti(storia)
  }
})

test('una storia lineare resta su una corsia', () => {
  const { rows, lanes } = computeGraph([c('c', 'b'), c('b', 'a'), c('a')])
  assert.equal(lanes, 1)
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0])
  assert.deepEqual(rows[0].lines.map((l) => [l.from, l.to, l.hash]), [[0, 0, 'b']])
  assert.deepEqual(rows[2].lines, [])
})

test('due branch partono dallo stesso genitore e si ricongiungono', () => {
  //  b  (corsia 0)
  //  | x (corsia 1)
  //  |/
  //  a
  const { rows, lanes } = computeGraph([c('b', 'a'), c('x', 'a'), c('a')])
  assert.equal(lanes, 2)
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0])
  assert.deepEqual(rows[1].lines.map((l) => [l.from, l.to]).sort(), [[0, 0], [1, 0]])
})

test('un merge apre una corsia per il secondo genitore', () => {
  const { rows, lanes } = computeGraph([c('m', 'b', 'x'), c('x', 'a'), c('b', 'a'), c('a')])
  assert.equal(lanes, 2)
  assert.deepEqual(rows[0].lines.map((l) => [l.from, l.to, l.hash]), [[0, 0, 'b'], [0, 1, 'x']])
  assert.equal(rows[1].lane, 1)
  assert.equal(rows[2].lane, 0)
  assert.equal(rows[3].lane, 0)
})

test('ogni linea sa da quale commit parte, anche lungo le corsie che proseguono', () => {
  const { rows } = computeGraph([c('x', 'a'), c('b', 'a'), c('a')])
  assert.deepEqual(rows[1].lines.map((l) => [l.hash, l.child]).sort(), [['a', 'b'], ['a', 'x']])
})

test('una corsia libera viene riusata', () => {
  const { rows } = computeGraph([c('x1', 'r'), c('r'), c('y', 'z'), c('z')])
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0, 0])
})

test('i colori di ramo differiscono e restano coerenti lungo la corsia', () => {
  const { rows } = computeGraph([c('m', 'b', 'x'), c('x', 'a'), c('b', 'a'), c('a')])
  assert.notEqual(rows[1].color, rows[2].color)
  assert.equal(rows[0].color, rows[2].color)
})

test('commit con genitori fuori dal caricato non rompono il grafo', () => {
  const { rows } = computeGraph([c('b', 'mancante'), c('altro', 'mancante2')])
  assert.deepEqual(rows.map((r) => r.lane), [0, 1])
})

test('trova tutti gli antenati di un branch e nessun altro', () => {
  const commits = [c('m', 'b', 'x'), c('z', 'a'), c('x', 'a'), c('b', 'a'), c('a')]
  assert.deepEqual([...ancestorsOf('m', commits)].sort(), ['a', 'b', 'm', 'x'])
  assert.deepEqual([...ancestorsOf('z', commits)].sort(), ['a', 'z'])
})

test('numera le righe del confronto', () => {
  const text = ['diff --git a/x b/x', 'index 1..2', '--- a/x', '+++ b/x', '@@ -3,2 +3,2 @@ funzione', ' uguale', '-tolta', '+aggiunta', '\\ No newline at end of file'].join('\n')
  assert.deepEqual(parseUnifiedDiff(text), [
    { tipo: 'hunk', testo: '… funzione' },
    { tipo: 'uguale', testo: 'uguale', vecchia: 3, nuova: 3 },
    { tipo: 'tolta', testo: 'tolta', vecchia: 4, nuova: null },
    { tipo: 'aggiunta', testo: 'aggiunta', vecchia: null, nuova: 4 },
    { tipo: 'nota', testo: 'No newline at end of file' }
  ])
})

test('le intestazioni non sembrano righe tolte o aggiunte', () => {
  assert.deepEqual(parseUnifiedDiff('--- a/x\n+++ b/x'), [])
})

test('la storia chiude un tratto in una riga, con le linee ancora giuste, e si apre', () => {
  const commits: Nodo[] = [{ ...c('h', 'g'), refs: ['main'] }, c('g', 'f'), c('f', 'e'), c('e', 'd'), { ...c('d', 'c'), refs: ['v1'] }, c('c')]
  const chiusa = storia(commits, new Set())
  assert.deepEqual(chiusa.map((r) => r.commit.hash), ['h', 'g', 'd', 'c'])
  assert.equal(chiusa[1].gruppo?.length, 3)
  assert.deepEqual(chiusa[1].commit.parents, ['d'], 'la riga arriva ai genitori dell\'ultimo del gruppo')
  // Una sola corsia: nessuna linea persa e nessun ramo inventato.
  const { rows, lanes } = computeGraph(chiusa.map((r) => r.commit))
  assert.equal(lanes, 1)
  assert.ok(rows.every((r) => r.lane === 0))

  const aperta = storia(commits, new Set(['g']))
  assert.deepEqual(aperta.map((r) => r.commit.hash), commits.map((x) => x.hash))
  assert.deepEqual(aperta.map((r) => r.apreGruppo), [null, 'g', null, null, null, null])
  assert.deepEqual(computeGraph(aperta.map((r) => r.commit)), computeGraph(commits))
})

test('chiudere i gruppi non cambia le corsie di partenze e unioni', () => {
  const commits: Nodo[] = [c('m', 'x3', 'y2'), c('x3', 'x2'), c('y2', 'y1'), c('x2', 'x1'), c('y1', 'b'), c('x1', 'b'), c('b', 'a3'), c('a3', 'a2'), c('a2', 'a1'), c('a1', 'a0'), c('a0')]
  const chiusa = storia(commits, new Set())
  assert.ok(chiusa.some((r) => r.gruppo))
  const ore = computeGraph(chiusa.map((r) => r.commit)).lanes
  assert.equal(ore, computeGraph(commits).lanes)
  for (const r of chiusa) for (const p of r.commit.parents) assert.ok(chiusa.some((x) => x.commit.hash === p), `${r.commit.hash} perde il genitore ${p}`)
})

test('le frecce partono dalla riga dove sta la tastiera', () => {
  const r = [{ hash: 'a' }, { hash: 'g' }, { hash: 'b' }]
  assert.equal(rigaVicina(r, 'g', 'a', true), 'b', 'dal gruppo, non dal commit scelto')
  assert.equal(rigaVicina(r, null, 'a', true), 'g')
  assert.equal(rigaVicina(r, 'a', null, false), 'a')
  assert.equal(rigaVicina(r, 'b', null, true), 'b')
  assert.equal(rigaVicina([], null, null, true), null)
})

test('un gruppo con il genitore fuori dalla lista resta aperto al confine e non inventa linee', () => {
  const commits: Nodo[] = [c('e', 'd'), c('d', 'c'), c('c', 'b'), c('b', 'a'), c('a', 'fuori')]
  const r = storia(commits, new Set())
  assert.deepEqual(r.map((x) => x.commit.hash), ['e', 'd', 'a'])
  assert.equal(r[1].gruppo?.length, 3)
  assert.deepEqual(r[2].commit.parents, ['fuori'])
  assert.doesNotThrow(() => computeGraph(r.map((x) => x.commit)))
})
