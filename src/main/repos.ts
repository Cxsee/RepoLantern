import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import { t } from '../shared/i18n.ts'

const run = promisify(execFile)

export type Repo = { path: string; nome: string; manca: boolean }
type Saved = { repos: string[]; attiva: string | null }

async function load(file: string): Promise<Saved> {
  const testo = await readFile(file, 'utf8').catch(() => null)
  if (testo === null) return { repos: [], attiva: null }
  try {
    return JSON.parse(testo)
  } catch {
    // La prossima aggiunta riscrive il file: l'elenco rovinato si tiene da parte per poterlo recuperare a mano.
    await copyFile(file, `${file}.rovinato`).catch(() => {})
    return { repos: [], attiva: null }
  }
}

async function save(file: string, data: Saved): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2))
  await rename(`${file}.tmp`, file)
}

// Da qualsiasi worktree risale al checkout principale, così ogni repo compare una volta sola.
export async function mainCheckout(folder: string): Promise<string> {
  const { stdout } = await run('git', ['worktree', 'list', '--porcelain'], { cwd: folder })
  const first = /^worktree (.+)$/m.exec(stdout)?.[1]
  if (!first) throw new Error(t('ipc.notGitRepo'))
  return normalize(first.trim())
}

export async function listRepos(file: string): Promise<{ repos: Repo[]; attiva: string | null }> {
  const { repos, attiva } = await load(file)
  const items = await Promise.all(
    repos.map(async (path) => ({
      path,
      nome: basename(path),
      manca: !(await stat(join(path, '.git')).catch(() => null))
    }))
  )
  return { repos: items, attiva }
}

export async function addRepo(file: string, folder: string): Promise<void> {
  const path = await mainCheckout(folder)
  const saved = await load(file)
  await save(file, { repos: saved.repos.includes(path) ? saved.repos : [...saved.repos, path], attiva: path })
}

export async function setActive(file: string, path: string): Promise<void> {
  const saved = await load(file)
  if (saved.repos.includes(path)) await save(file, { ...saved, attiva: path })
}

export async function removeRepo(file: string, path: string): Promise<void> {
  const saved = await load(file)
  const repos = saved.repos.filter((r) => r !== path)
  await save(file, { repos, attiva: saved.attiva === path ? (repos[0] ?? null) : saved.attiva })
}

export async function isKnown(file: string, path: string): Promise<boolean> {
  return (await load(file)).repos.includes(path)
}
