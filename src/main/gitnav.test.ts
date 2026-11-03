import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseLog, parseNumstat, parseRefs, parseStatus, readBranch, readBranchDiff, readCommit, readCommitDiff, readGraph, readWorktreeChanges, readWorktreeDiff } from './gitnav.ts'

function repo(): { dir: string; git: (...a: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'hub-'))
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'user.name=Prova', '-c', 'user.email=p@p', '-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  git('init', '-q', '-b', 'master')
  writeFileSync(join(dir, 'a.txt'), 'uno\n')
  git('add', '.')
  git('commit', '-q', '-m', 'primo')
  return { dir, git }
}

test('classifica i riferimenti e nasconde il remoto uguale al locale', () => {
  assert.deepEqual(parseRefs('HEAD -> refs/heads/video/x, refs/remotes/origin/video/x, refs/remotes/origin/HEAD, tag: refs/tags/v1, refs/remotes/origin/altro'), [
    { nome: 'video/x', tipo: 'locale' },
    { nome: 'v1', tipo: 'tag' },
    { nome: 'origin/altro', tipo: 'remoto' }
  ])
  assert.deepEqual(parseRefs('HEAD'), [{ nome: 'HEAD', tipo: 'head' }])
  assert.deepEqual(parseRefs(''), [])
})

test('legge il registro, anche con accapo tra un commit e il successivo', () => {
  const log = `a\0p q\0refs/heads/m\0Ada\x0010\0Ciao, mondo\x1e\nb\0\0\0Bo\x0020\0Primo\x1e\n`
  const [first, second] = parseLog(log)
  assert.deepEqual(first.parents, ['p', 'q'])
  assert.equal(first.time, 10_000)
  assert.equal(first.subject, 'Ciao, mondo')
  assert.deepEqual(second.parents, [])
})

test('legge le statistiche, con file binari e rinominati', () => {
  assert.deepEqual(parseNumstat('3\t1\ta.txt\0-\t-\tb.png\0' + '2\t0\t\0vecchio.ts\0nuovo.ts\0' + '1\t1\tc d.txt\0'), [
    { path: 'a.txt', da: null, add: 3, del: 1 },
    { path: 'b.png', da: null, add: null, del: null },
    { path: 'nuovo.ts', da: 'vecchio.ts', add: 2, del: 0 },
    { path: 'c d.txt', da: null, add: 1, del: 1 }
  ])
})

test('legge lo stato, con rinomine e spazi nei nomi', () => {
  assert.deepEqual(parseStatus(' M a b.txt\0R  nuovo.txt\0vecchio.txt\0?? cartella/\0'), [
    { path: 'a b.txt', stato: ' M', da: null },
    { path: 'nuovo.txt', stato: 'R ', da: 'vecchio.txt' },
    { path: 'cartella/', stato: '??', da: null }
  ])
})

test('naviga commit, branch e file di una repo vera', async () => {
  const { dir, git } = repo()
  git('checkout', '-q', '-b', 'lavoro/x')
  writeFileSync(join(dir, 'a.txt'), 'due\n')
  git('commit', '-qam', 'cambio a')
  const hash = git('rev-parse', 'HEAD')

  const graph = await readGraph(dir, 10)
  assert.equal(graph.length, 2)
  assert.deepEqual(graph[0].refs, [{ nome: 'lavoro/x', tipo: 'locale' }])

  const commit = await readCommit(dir, hash)
  assert.equal(commit.subject, 'cambio a')
  assert.deepEqual(commit.files, [{ path: 'a.txt', da: null, add: 1, del: 1 }])
  assert.match((await readCommitDiff(dir, hash, 'a.txt')).testo, /-uno\n\+due/)

  const branch = await readBranch(dir, 'lavoro/x', 'master')
  assert.deepEqual(branch.commits.map((c) => c.subject), ['cambio a'])
  assert.equal(branch.files[0].path, 'a.txt')
  assert.match((await readBranchDiff(dir, 'lavoro/x', 'master', 'a.txt')).testo, /\+due/)
  assert.deepEqual(await readBranch(dir, 'master', 'master'), { commits: [], files: [] })
})

test('mostra le modifiche non salvate, i file nuovi, i binari e le cartelle', async () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'a.txt'), 'modificato\n')
  writeFileSync(join(dir, 'nuovo.txt'), 'testo nuovo\n')
  writeFileSync(join(dir, 'b.bin'), Buffer.from([1, 0, 2]))
  mkdirSync(join(dir, 'cartella'))
  writeFileSync(join(dir, 'cartella', 'x.txt'), 'x')
  assert.deepEqual((await readWorktreeChanges(dir)).map((f) => f.stato + f.path), [' Ma.txt', '??b.bin', '??cartella/', '??nuovo.txt'])
  assert.match((await readWorktreeDiff(dir, 'a.txt')).testo, /\+modificato/)
  const added = await readWorktreeDiff(dir, 'nuovo.txt')
  assert.deepEqual([added.nuovo, added.testo], [true, 'testo nuovo\n'])
  assert.equal((await readWorktreeDiff(dir, 'b.bin')).binario, true)
  assert.equal((await readWorktreeDiff(dir, 'cartella/')).cartella, true)
})

test('rifiuta commit, branch e file fuori posto', async () => {
  const { dir } = repo()
  await assert.rejects(readCommit(dir, '--all'), /Invalid commit/)
  await assert.rejects(readCommit(dir, 'HEAD'), /Invalid commit/)
  await assert.rejects(readBranch(dir, '--output=x', 'master'), /not found/)
  await assert.rejects(readBranch(dir, 'master', '../x'), /not found/)
  await assert.rejects(readWorktreeDiff(dir, '../fuori.txt'), /outside/)
  await assert.rejects(readCommitDiff(dir, 'abcdef1', 'C:/Windows/x'), /outside/)
})

test('una repo vuota dà un grafo vuoto', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  assert.deepEqual(await readGraph(dir, 10), [])
})
