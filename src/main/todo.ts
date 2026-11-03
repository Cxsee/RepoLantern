import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { t } from '../shared/i18n.ts'

const run = promisify(execFile)
const MAX_MD_BYTES = 2 * 1024 * 1024

export type Todo = { id: string; testo: string; fatta: boolean; creata: string }
export type DocTodo = { file: string; riga: number; testo: string; sezione?: string }

export const todoPath = (repo: string): string => join(repo, '.hub', 'todo.json')

export async function readTodos(repo: string): Promise<Todo[]> {
  let raw: string
  try {
    raw = await readFile(todoPath(repo), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  // Un file illeggibile deve dare errore: trattarlo come vuoto farebbe sovrascrivere le voci al prossimo salvataggio.
  const data = JSON.parse(raw)
  if (!Array.isArray(data)) throw new Error(t('todo.notList'))
  return data
}

export async function excludeFromGit(repo: string): Promise<void> {
  const { stdout } = await run('git', ['rev-parse', '--git-common-dir'], { cwd: repo })
  const file = resolve(repo, stdout.trim(), 'info', 'exclude')
  const current = await readFile(file, 'utf8').catch(() => '')
  if (current.split(/\r?\n/).includes('.hub/')) return
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}.hub/\n`)
}

async function writeTodos(repo: string, todos: Todo[]): Promise<void> {
  const file = todoPath(repo)
  await mkdir(dirname(file), { recursive: true })
  await excludeFromGit(repo)
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(todos, null, 2) + '\n')
  await rename(tmp, file)
}

// Le modifiche sulla stessa repo passano una alla volta, così due clic ravvicinati non si perdono.
const queues = new Map<string, Promise<unknown>>()

function mutate(repo: string, change: (todos: Todo[]) => Todo[]): Promise<Todo[]> {
  const next = (queues.get(repo) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const todos = change(await readTodos(repo))
    await writeTodos(repo, todos)
    return todos
  })
  queues.set(repo, next)
  return next
}

export const addTodo = (repo: string, testo: string): Promise<Todo[]> =>
  mutate(repo, (t) => [...t, { id: randomUUID(), testo, fatta: false, creata: new Date().toISOString() }])

export const updateTodo = (repo: string, id: string, patch: { testo?: string; fatta?: boolean }): Promise<Todo[]> =>
  mutate(repo, (t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)))

export const removeTodo = (repo: string, id: string): Promise<Todo[]> =>
  mutate(repo, (t) => t.filter((x) => x.id !== id))

export const restoreTodo = (repo: string, todo: Todo, index: number): Promise<Todo[]> =>
  mutate(repo, (t) => (t.some((x) => x.id === todo.id) ? t : [...t.slice(0, index), todo, ...t.slice(index)]))

export function parseMarkdownTodos(file: string, text: string): DocTodo[] {
  const found: DocTodo[] = []
  let fence = false
  let sezione = ''
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) return
    sezione = /^#{1,6}\s+(.+)$/.exec(line)?.[1].trim() ?? sezione
    const m = /^\s*[-*+]\s+\[ \]\s+(.+)$/.exec(line)
    if (m) found.push({ file, riga: i + 1, testo: m[1].replaceAll('**', '').trim(), ...(sezione ? { sezione } : {}) })
  })
  return found
}

export async function scanDocs(repo: string): Promise<DocTodo[]> {
  // git rispetta già .gitignore: node_modules, build e simili restano fuori.
  const { stdout } = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md'], {
    cwd: repo,
    maxBuffer: 64 * 1024 * 1024
  })
  const results: DocTodo[] = []
  for (const file of new Set(stdout.split('\0').filter(Boolean))) {
    try {
      const path = join(repo, file)
      if ((await stat(path)).size > MAX_MD_BYTES) continue
      results.push(...parseMarkdownTodos(file, await readFile(path, 'utf8')))
    } catch {
      // File tracciato ma cancellato dal disco: non ha voci da mostrare.
    }
  }
  return results
}

// Il percorso arriva dall'interfaccia: si aprono solo file .md dentro la repo.
export function safeDocPath(repo: string, file: string): string | null {
  const path = resolve(repo, file)
  const rel = relative(repo, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/\.md$/i.test(rel)) return null
  return path
}
