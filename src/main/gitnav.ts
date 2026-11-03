import { execFile } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { t } from '../shared/i18n.ts'

const exec = promisify(execFile)
const MAX_OUTPUT = 8 * 1024 * 1024
const MAX_DIFF_CHARS = 400_000
const MAX_FILE_BYTES = 400_000
const HASH = /^[0-9a-f]{7,40}$/i
const FIELD = '\x00'
const RECORD = '\x1e'
// Gli argomenti di un processo non possono contenere il carattere nullo: lo scrive git con %x00.
const LOG_FORMAT = '--format=%H%x00%P%x00%D%x00%an%x00%ct%x00%s%x1e'

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec('git', ['--no-optional-locks', ...args], { cwd, maxBuffer: MAX_OUTPUT })).stdout

export type Ref = { nome: string; tipo: 'locale' | 'remoto' | 'tag' | 'head' }
export type LogCommit = { hash: string; parents: string[]; refs: Ref[]; author: string; time: number; subject: string }
export type FileStat = { path: string; da: string | null; add: number | null; del: number | null }
export type CommitDetail = LogCommit & { body: string; files: FileStat[] }
export type BranchDetail = { commits: LogCommit[]; files: FileStat[] }
export type ChangedFile = { path: string; stato: string; da: string | null }
export type DiffResult = { testo: string; tagliato: boolean; binario: boolean; nuovo: boolean; cartella: boolean }

export function parseRefs(decoration: string): Ref[] {
  const refs: Ref[] = decoration.split(', ').filter(Boolean).flatMap((part): Ref[] => {
    const name = part.replace(/^HEAD -> /, '')
    if (name === 'HEAD') return [{ nome: 'HEAD', tipo: 'head' }]
    if (name.startsWith('tag: ')) return [{ nome: name.slice(5).replace('refs/tags/', ''), tipo: 'tag' }]
    if (name.startsWith('refs/heads/')) return [{ nome: name.slice(11), tipo: 'locale' }]
    if (name.startsWith('refs/remotes/')) return name.endsWith('/HEAD') ? [] : [{ nome: name.slice(13), tipo: 'remoto' }]
    return []
  })
  // Un remoto fermo sullo stesso commit del branch locale non aggiunge informazioni.
  const locals = new Set(refs.filter((r) => r.tipo === 'locale').map((r) => r.nome))
  return refs.filter((r) => r.tipo !== 'remoto' || !locals.has(r.nome.replace(/^[^/]+\//, '')))
}

export function parseLog(text: string): LogCommit[] {
  return text.split(RECORD).map((r) => r.replace(/^\s+/, '')).filter(Boolean).map((record) => {
    const [hash, parents, decoration, author, time, subject] = record.split(FIELD)
    return { hash, parents: parents ? parents.split(' ') : [], refs: parseRefs(decoration ?? ''), author: author ?? '', time: Number(time) * 1000, subject: subject ?? '' }
  })
}

// Formato di --numstat -z: "aggiunte\ttolte\tpercorso\0", oppure "aggiunte\ttolte\t\0vecchio\0nuovo\0" per i file rinominati.
export function parseNumstat(text: string): FileStat[] {
  const parts = text.split('\0')
  const files: FileStat[] = []
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i].replace(/^\s+/, ''))
    if (!m) continue
    const [add, del] = [m[1] === '-' ? null : Number(m[1]), m[2] === '-' ? null : Number(m[2])]
    if (m[3]) files.push({ path: m[3], da: null, add, del })
    else {
      files.push({ path: parts[i + 2] ?? '', da: parts[i + 1] ?? null, add, del })
      i += 2
    }
  }
  return files
}

// Formato di status --porcelain -z: "XY percorso\0"; le rinomine aggiungono il vecchio percorso subito dopo.
export function parseStatus(text: string): ChangedFile[] {
  const parts = text.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length < 4) continue
    const stato = parts[i].slice(0, 2)
    const rename = stato.includes('R') || stato.includes('C')
    files.push({ path: parts[i].slice(3), stato, da: rename ? (parts[i + 1] ?? null) : null })
    if (rename) i++
  }
  return files
}

const assertHash = (hash: unknown): string => {
  if (typeof hash !== 'string' || !HASH.test(hash)) throw new Error(t('git.badCommit'))
  return hash
}

const assertFile = (root: string, file: unknown): string => {
  if (typeof file !== 'string' || !file) throw new Error(t('ipc.badFile'))
  const rel = relative(root, resolve(root, file))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(t('git.outsideRepo'))
  return file
}

async function assertBranch(repo: string, name: unknown): Promise<string> {
  const names = (await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).split(/\r?\n/)
  if (typeof name !== 'string' || !name || !names.includes(name)) throw new Error(t('git.branchNotFound'))
  return name
}

const toDiff = (text: string): DiffResult => ({
  testo: text.slice(0, MAX_DIFF_CHARS),
  tagliato: text.length > MAX_DIFF_CHARS,
  binario: /^Binary files |^GIT binary patch/m.test(text),
  nuovo: false,
  cartella: false
})

async function diffOf(run: Promise<string>): Promise<DiffResult> {
  try {
    return toDiff(await run)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { testo: '', tagliato: true, binario: false, nuovo: false, cartella: false }
    throw e
  }
}

export async function readGraph(repo: string, limit: number): Promise<LogCommit[]> {
  const n = Math.min(Math.max(Math.floor(limit) || 300, 1), 5000)
  // Una repo senza commit non è un errore: il grafo è solo vuoto.
  const hasHead = await git(repo, 'rev-parse', '--verify', '--quiet', 'HEAD').then(() => true, () => false)
  const hasRefs = hasHead || (await git(repo, 'for-each-ref', '--count=1', 'refs/heads')).trim() !== ''
  if (!hasRefs) return []
  return parseLog(await git(repo, 'log', '--branches', '--remotes', '--tags', ...(hasHead ? ['HEAD'] : []), '--topo-order', '--decorate=full', `-n${n}`, LOG_FORMAT))
}

export async function readCommit(repo: string, hash: unknown): Promise<CommitDetail> {
  const id = assertHash(hash)
  const [log, body, numstat] = await Promise.all([
    git(repo, 'log', '-1', '--decorate=full', LOG_FORMAT, id),
    git(repo, 'log', '-1', '--format=%b', id),
    git(repo, 'show', '--format=', '--numstat', '-z', '-M', '--diff-merges=first-parent', id)
  ])
  return { ...parseLog(log)[0], body: body.trim(), files: parseNumstat(numstat) }
}

export async function readCommitDiff(repo: string, hash: unknown, file: unknown): Promise<DiffResult> {
  return diffOf(git(repo, 'show', '--format=', '-M', '--diff-merges=first-parent', assertHash(hash), '--', assertFile(repo, file)))
}

export async function readBranch(repo: string, name: unknown, base: unknown): Promise<BranchDetail> {
  const branch = await assertBranch(repo, name)
  const target = await assertBranch(repo, base)
  if (branch === target) return { commits: [], files: [] }
  const [log, numstat] = await Promise.all([
    git(repo, 'log', '--decorate=full', '-n200', LOG_FORMAT, `refs/heads/${target}..refs/heads/${branch}`),
    git(repo, 'diff', '--numstat', '-z', '-M', `refs/heads/${target}...refs/heads/${branch}`)
  ])
  return { commits: parseLog(log), files: parseNumstat(numstat) }
}

export async function readBranchDiff(repo: string, name: unknown, base: unknown, file: unknown): Promise<DiffResult> {
  const [branch, target] = await Promise.all([assertBranch(repo, name), assertBranch(repo, base)])
  return diffOf(git(repo, 'diff', '-M', `refs/heads/${target}...refs/heads/${branch}`, '--', assertFile(repo, file)))
}

export async function readWorktreeChanges(path: string): Promise<ChangedFile[]> {
  return parseStatus(await git(path, 'status', '--porcelain', '-z'))
}

export async function readWorktreeDiff(path: string, file: unknown): Promise<DiffResult> {
  const name = assertFile(path, file)
  const tracked = await git(path, 'ls-files', '--error-unmatch', '--', name).then(() => true, () => false)
  const head = await git(path, 'rev-parse', '--verify', '--quiet', 'HEAD').then(() => true, () => false)
  if (tracked && head) return diffOf(git(path, 'diff', 'HEAD', '-M', '--', name))

  // File nuovo: git non ha un confronto da dare, si mostra il contenuto.
  const full = join(path, name)
  const info = await stat(full).catch(() => null)
  if (!info) return { testo: '', tagliato: false, binario: false, nuovo: true, cartella: false }
  if (info.isDirectory()) return { testo: '', tagliato: false, binario: false, nuovo: true, cartella: true }
  const handle = await open(full, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(info.size, MAX_FILE_BYTES))
    await handle.read(buffer, 0, buffer.length, 0)
    const binary = buffer.includes(0)
    return { testo: binary ? '' : buffer.toString('utf8'), tagliato: info.size > MAX_FILE_BYTES, binario: binary, nuovo: true, cartella: false }
  } finally {
    await handle.close()
  }
}
