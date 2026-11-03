import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isActive, projectSlug, readAgents } from './agents.ts'
import { countChanges, githubUrl, parseBranches, parseWorktrees, readStatus } from './status.ts'

const temp = (): string => mkdtempSync(join(tmpdir(), 'hub-'))

test('legge i worktree, anche quelli senza branch o spariti', () => {
  const text = 'worktree C:/a\nHEAD aaaaaaaaaaaa\nbranch refs/heads/feature/x\n\nworktree C:/b\nHEAD bbbbbbbbbbbb\ndetached\n\nworktree C:/c\nHEAD cccccccccccc\nbranch refs/heads/y\nprunable gitdir file points to non-existent location\n\n'
  assert.deepEqual(parseWorktrees(text), [
    { path: 'C:/a', branch: 'feature/x', head: 'aaaaaaaa', prunable: false },
    { path: 'C:/b', branch: null, head: 'bbbbbbbb', prunable: false },
    { path: 'C:/c', branch: 'y', head: 'cccccccc', prunable: true }
  ])
})

test('conta modifiche e file nuovi', () => {
  assert.deepEqual(countChanges(' M a\n?? b\nA  c\n?? d\n'), { modificati: 2, nuovi: 2 })
  assert.deepEqual(countChanges(''), { modificati: 0, nuovi: 0 })
})

test('legge avanti e indietro su base e upstream', () => {
  const line = ['video/x', 'origin/video/x', '[ahead 2, behind 1]', '2026-11-01T20:00:00+01:00', '5 3'].join('\0')
  const [b] = parseBranches(line + '\n')
  assert.deepEqual(
    [b.avanti, b.indietro, b.upstream, b.upstreamAvanti, b.upstreamIndietro, b.upstreamSparito],
    [5, 3, 'origin/video/x', 2, 1, false]
  )
  const [gone] = parseBranches(['y', 'origin/y', '[gone]', '2026-11-01T20:00:00+01:00'].join('\0'))
  assert.equal(gone.upstreamSparito, true)
})

test('crea il link GitHub solo per github.com e senza credenziali', () => {
  const expected = 'https://github.com/example/project'
  assert.equal(githubUrl('https://github.com/example/project.git\n'), expected)
  assert.equal(githubUrl('git@github.com:example/project.git'), expected)
  assert.equal(githubUrl('https://token@github.com/example/project.git'), expected)
  assert.equal(githubUrl('https://github.com.evil.it/a/b'), null)
  assert.equal(githubUrl('https://gitlab.com/a/b.git'), null)
})

test('riassume una repo vera con un branch avanti su master', async () => {
  const r = temp()
  const git = (...a: string[]): void => void execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: r, stdio: 'ignore' })
  git('init', '-q', '-b', 'master')
  git('commit', '-q', '--allow-empty', '-m', 'uno')
  git('checkout', '-q', '-b', 'lavoro')
  git('commit', '-q', '--allow-empty', '-m', 'due')
  writeFileSync(join(r, 'nuovo.txt'), 'x')
  const s = await readStatus(r)
  assert.equal(s.base, 'master')
  assert.equal(s.github, null)
  assert.equal(s.branch.find((b) => b.nome === 'lavoro')?.avanti, 1)
  assert.deepEqual([s.worktree.length, s.worktree[0].branch, s.worktree[0].nuovi], [1, 'lavoro', 1])
})

function fakeClaude(session: object | string, name = '1.json'): string {
  const dir = temp()
  mkdirSync(join(dir, 'sessions'))
  writeFileSync(join(dir, 'sessions', name), typeof session === 'string' ? session : JSON.stringify(session))
  // Un file .key rotto dimostra che non viene neppure aperto.
  writeFileSync(join(dir, 'sessions', '1.abc.key'), 'segreto')
  return dir
}

const session = { pid: 1, sessionId: 's1', cwd: 'C:\\repo\\wt', name: 'Prova', status: 'busy', entrypoint: 'cli', updatedAt: 5 }

test('mostra le sessioni vive della repo con i loro subagenti', async () => {
  const dir = fakeClaude(session)
  const sub = join(dir, 'projects', projectSlug(session.cwd), 's1', 'subagents')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ description: 'Cerca', agentType: 'Explore' }))
  writeFileSync(join(sub, 'agent-a2.meta.json'), JSON.stringify({ description: 'Fatto', finished: true }))
  const { sessioni, illeggibili } = await readAgents(dir, ['C:\\repo'], () => true)
  assert.equal(illeggibili, 0)
  assert.equal(sessioni[0].nome, 'Prova')
  assert.deepEqual(sessioni[0].subagenti.map((s) => s.descrizione).sort(), ['Cerca', 'Fatto'])
})

test("un subagente è attivo se non ha finito o ha lavorato nell'ultimo minuto", () => {
  assert.equal(isActive(undefined, 0, 999_999), true)
  assert.equal(isActive(true, 950_000, 1_000_000), true)
  assert.equal(isActive(true, 900_000, 1_000_000), false)
})

test('nasconde sessioni chiuse, di altre repo e di cartelle col nome simile', async () => {
  const dir = fakeClaude(session)
  assert.equal((await readAgents(dir, ['C:\\repo'], () => false)).sessioni.length, 0)
  assert.equal((await readAgents(dir, ['C:\\altra'], () => true)).sessioni.length, 0)
  assert.equal((await readAgents(dir, ['C:\\repo\\w'], () => true)).sessioni.length, 0)
  assert.equal((await readAgents(dir, ['c:\\REPO'], () => true)).sessioni.length, 1)
})

test('un formato inatteso si conta come illeggibile e non blocca', async () => {
  assert.deepEqual(await readAgents(fakeClaude({ nuovo: 'formato' }), ['C:\\repo'], () => true), { sessioni: [], illeggibili: 1 })
  assert.deepEqual(await readAgents(fakeClaude('{rotto'), ['C:\\repo'], () => true), { sessioni: [], illeggibili: 1 })
  assert.deepEqual(await readAgents(temp(), ['C:\\repo'], () => true), { sessioni: [], illeggibili: 0 })
})
