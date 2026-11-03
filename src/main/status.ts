import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const MAX_OUTPUT = 64 * 1024 * 1024

// --no-optional-locks: leggere lo stato non deve toccare l'indice né intralciare git o Claude al lavoro.
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec('git', ['--no-optional-locks', ...args], { cwd, maxBuffer: MAX_OUTPUT })).stdout

export type Worktree = { path: string; branch: string | null; head: string; modificati: number; nuovi: number; manca: boolean; errore: boolean }
export type Branch = {
  nome: string
  avanti: number
  indietro: number
  upstream: string | null
  upstreamAvanti: number
  upstreamIndietro: number
  upstreamSparito: boolean
  data: string
}
export type RepoStatus = { base: string | null; worktree: Worktree[]; branch: Branch[]; github: string | null }

export function parseWorktrees(text: string): { path: string; branch: string | null; head: string; prunable: boolean }[] {
  return text
    .split(/\r?\n\r?\n/)
    .filter((block) => block.startsWith('worktree '))
    .map((block) => {
      const field = (name: string): string | undefined => block.split(/\r?\n/).find((l) => l === name || l.startsWith(`${name} `))?.slice(name.length + 1)
      return {
        path: field('worktree') ?? '',
        branch: field('branch')?.replace('refs/heads/', '') ?? null,
        head: (field('HEAD') ?? '').slice(0, 8),
        prunable: block.split(/\r?\n/).some((l) => l.startsWith('prunable'))
      }
    })
}

export function countChanges(porcelain: string): { modificati: number; nuovi: number } {
  const lines = porcelain.split(/\r?\n/).filter(Boolean)
  const nuovi = lines.filter((l) => l.startsWith('??')).length
  return { modificati: lines.length - nuovi, nuovi }
}

export function parseBranches(text: string): Branch[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [nome, upstream, track, data, aheadBehind] = line.split('\0')
      const [avanti = 0, indietro = 0] = (aheadBehind ?? '').split(' ').map(Number)
      const count = (word: string): number => Number(new RegExp(`${word} (\\d+)`).exec(track)?.[1] ?? 0)
      return {
        nome,
        avanti: avanti || 0,
        indietro: indietro || 0,
        upstream: upstream || null,
        upstreamAvanti: count('ahead'),
        upstreamIndietro: count('behind'),
        upstreamSparito: track.includes('gone'),
        data
      }
    })
}

// Accetta solo github.com: l'indirizzo finisce in un pulsante che apre il browser.
export function githubUrl(remote: string): string | null {
  const m = /^(?:https:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return m ? `https://github.com/${m[1]}/${m[2]}` : null
}

async function findBase(repo: string, names: string[]): Promise<string | null> {
  const head = await git(repo, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD').catch(() => '')
  const remoteDefault = head.trim().replace(/^origin\//, '')
  return [remoteDefault, 'master', 'main'].find((n) => n && names.includes(n)) ?? null
}

export async function listWorktreePaths(repo: string): Promise<string[]> {
  return parseWorktrees(await git(repo, 'worktree', 'list', '--porcelain')).map((w) => w.path)
}

export async function readStatus(repo: string): Promise<RepoStatus> {
  const names = (await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).split(/\r?\n/).filter(Boolean)
  const base = await findBase(repo, names)
  const aheadBehind = base ? `%00%(ahead-behind:refs/heads/${base})` : ''
  const format = `--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:iso-strict)${aheadBehind}`
  const branch = parseBranches(await git(repo, 'for-each-ref', '--sort=-committerdate', format, 'refs/heads'))

  const worktree = await Promise.all(
    parseWorktrees(await git(repo, 'worktree', 'list', '--porcelain')).map(async ({ path, branch: name, head, prunable }): Promise<Worktree> => {
      const empty = { path, branch: name, head, modificati: 0, nuovi: 0 }
      if (prunable) return { ...empty, manca: true, errore: false }
      try {
        return { ...empty, ...countChanges(await git(path, 'status', '--porcelain')), manca: false, errore: false }
      } catch {
        return { ...empty, manca: false, errore: true }
      }
    })
  )

  const remote = await git(repo, 'remote', 'get-url', 'origin').catch(() => '')
  return { base, worktree, branch, github: githubUrl(remote) }
}
