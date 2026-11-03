import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTree, spreadTags, stepFrom, trunkAt, type Tag, type TreeCommit } from './tree.ts'

const c = (hash: string, parents: string[] = [], ...refs: string[]): TreeCommit => ({ hash, parents, refs: refs.map((nome) => ({ nome, tipo: 'locale' })), time: 0 })
const worktree = (path: string, branch: string | null, head = '') => ({ path, branch, head, modificati: 2, nuovi: 1 })

const history = [
  c('m', ['b', 'x'], 'master'),
  c('l2', ['l1'], 'lavoro'),
  c('l1', ['b']),
  c('x', ['a']),
  c('b', ['a'], 'finito'),
  c('a')
]
const tree = () => buildTree(history, 'master', ['master', 'lavoro', 'finito'], [worktree('C:/repo/qui', 'lavoro'), worktree('C:/repo', 'master')])
const limbOf = (nome: string) => tree().limbs.find((l) => l.nome === nome)!

test('il tronco è più stretto in cima e sale', () => {
  assert.ok(trunkAt(1).r < trunkAt(0.2).r)
  assert.ok(trunkAt(1).p[1] < trunkAt(0).p[1])
})

test('ogni commit proprio di un branch è una foglia del suo ramo', () => {
  assert.deepEqual(limbOf('lavoro').commits, ['l1', 'l2'])
  assert.deepEqual(limbOf('lavoro').leaves.map((l) => l.hash).sort(), ['l1', 'l2'])
  assert.ok(limbOf('lavoro').live)
})

test('il tronco porta i commit della base, senza quelli entrati con le unioni', () => {
  const base = tree().limbs.filter((l) => !l.live).flatMap((l) => l.commits)
  assert.deepEqual(base, ['a', 'b', 'm'])
})

test('un branch già unito resta un rametto spoglio col suo cartellino', () => {
  const finito = limbOf('finito')
  assert.deepEqual(finito.commits, [])
  assert.equal(finito.tag?.intero, 'finito')
})

test('i worktree sono frutti, anche sulla base, con cartella e file da salvare', () => {
  const lavoro = limbOf('lavoro')
  assert.equal(lavoro.fruit?.path, 'C:/repo/qui')
  assert.equal(lavoro.tag?.wt, 'C:/repo/qui')
  assert.equal(lavoro.tag?.sotto, 'qui · 3 to save')
  const crown = tree().limbs.find((l) => l.tag?.intero === 'master')!
  assert.equal(crown.fruit?.path, 'C:/repo')
})

test('un worktree senza branch ha comunque il suo ramo', () => {
  const t = buildTree(history, 'master', ['master'], [worktree('C:/repo/s', null, 'b')])
  assert.equal(t.limbs.find((l) => l.fruit)?.fruit?.path, 'C:/repo/s')
})

test('un branch staccato più di recente parte più in alto', () => {
  const commits = [
    c('t3', ['t2'], 'master'), c('n1', ['t2'], 'nuovo'), c('t2', ['t1']), c('v1', ['t0'], 'vecchio'), c('t1', ['t0']), c('t0')
  ]
  const t = buildTree(commits, 'master', ['master', 'nuovo', 'vecchio'], [])
  const [nuovo, vecchio] = ['nuovo', 'vecchio'].map((n) => t.limbs.find((l) => l.nome === n)!)
  assert.ok(nuovo.t > vecchio.t)
  assert.ok(nuovo.origin[1] < vecchio.origin[1])
})

test('la storia lunga si divide in rami, che si dividono ancora, e in alto sono più corti', () => {
  const commits = Array.from({ length: 240 }, (_, i) => c(`h${i}`, i < 239 ? [`h${i + 1}`] : [], ...(i === 0 ? ['master'] : [])))
  const t = buildTree(commits, 'master', ['master'], [])
  const palchi = t.limbs.filter((l) => !l.live)
  assert.equal(palchi.length, 12)
  const reach = (l: (typeof palchi)[number]): number => Math.abs(l.tip[0] - l.origin[0])
  assert.ok(reach(palchi[5]) > reach(palchi[palchi.length - 2]))
  assert.ok(palchi.every((l) => l.clumps.length >= 3))
  assert.equal(new Set(palchi.flatMap((l) => l.leaves.map((f) => f.hash))).size, 240)
})

test('i cartellini dello stesso lato non si coprono', () => {
  const tags = [10, 12, 14, 200].map((y): Tag => ({ x: 0, y, w: 50, h: 23, leader: '', side: 1, nome: '', intero: '', sotto: '', wt: null }))
  spreadTags(tags)
  tags.sort((a, b) => a.y - b.y).reduce((a, b) => {
    assert.ok(b.y >= a.y + a.h)
    return b
  })
})

test('i nomi stanno in colonna fuori dai rami del loro lato', () => {
  const commits = Array.from({ length: 240 }, (_, i) => c(`h${i}`, i < 239 ? [`h${i + 1}`] : [], ...(i === 0 ? ['master'] : [])))
  const t = buildTree([c('z', ['h100'], 'lavoro'), c('y', ['h60'], 'altro'), ...commits], 'master', ['master', 'lavoro', 'altro'], [])
  const palchi = t.limbs.filter((l) => !l.live)
  const reach = Math.max(...palchi.flatMap((l) => [Math.abs(l.tip[0])]))
  for (const nome of ['lavoro', 'altro']) {
    const limb = t.limbs.find((l) => l.nome === nome)!
    assert.ok(Math.abs(limb.tag!.x) > reach)
    assert.ok(Math.abs(limb.tag!.x) > Math.abs(limb.tip[0]))
  }
})

test('una repo vuota non rompe nulla', () => {
  assert.deepEqual(buildTree([], null, [], []).limbs, [])
})

test('le frecce percorrono le foglie e saltano tra i rami', () => {
  const t = tree()
  assert.equal(stepFrom(t, 'b', 'su'), 'm')
  assert.equal(stepFrom(t, 'b', 'giu'), 'a')
  assert.equal(stepFrom(t, 'a', 'giu'), null)
  const lavoro = t.limbs.find((l) => l.nome === 'lavoro')!
  const towards = lavoro.tip[0] > t.owner.get('m')!.tip[0] ? 'destra' : 'sinistra'
  assert.equal(stepFrom(t, 'm', towards), 'l2')
})
