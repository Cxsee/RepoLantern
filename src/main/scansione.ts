import { execFile } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseStatus } from './gitnav.ts'

const exec = promisify(execFile)
const MAX_DOC_BYTES = 2 * 1024 * 1024
// Gli stessi nomi vietati a Claude: Hub non li apre nemmeno per controllare una citazione.
export const SEGRETO = /^\.env(\..*)?$|\.(pem|key|jks|keystore)$/i
const MAX_VOCI_CODICE = 2000
const MAX_RIGA_VOCE = 500

export const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec('git', ['--no-optional-locks', ...args], { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout

export type Tipo = 'mobile' | 'desktop' | 'web' | 'altro'
export type VoceCodice = { file: string; riga: number; testo: string }

const LINGUAGGI: Record<string, string> = {
  dart: 'Dart', ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift', cs: 'C#', cpp: 'C++', cc: 'C++', c: 'C', h: 'C', rb: 'Ruby', php: 'PHP', sql: 'SQL', vue: 'Vue', svelte: 'Svelte', html: 'HTML', css: 'CSS', scss: 'CSS', sh: 'Shell', ps1: 'PowerShell', md: 'Markdown'
}
const DIPENDENZE: Record<string, string> = { react: 'React', next: 'Next.js', vue: 'Vue', svelte: 'Svelte', astro: 'Astro', electron: 'Electron', expo: 'Expo', 'react-native': 'React Native', vite: 'Vite', express: 'Express', fastapi: 'FastAPI', django: 'Django', flask: 'Flask' }
const FILE_NOTI: Record<string, string> = { 'pubspec.yaml': 'Flutter', 'cargo.toml': 'Rust', 'go.mod': 'Go', dockerfile: 'Docker' }
const MANIFESTI = /(^|\/)(package\.json|requirements\.txt|pyproject\.toml)$/i

export const linguaggioDi = (file: string): string | null => LINGUAGGI[file.split('.').pop()!.toLowerCase()] ?? null
export const isDocumento = (file: string): boolean => /\.md$/i.test(file)

export function kindOf(files: string[], packageJson: string): Tipo {
  const names = files.map((f) => f.split('/').pop()!.toLowerCase())
  const has = (name: string): boolean => names.includes(name)
  if (has('pubspec.yaml') || has('androidmanifest.xml') || has('info.plist') || /"(expo|react-native)"/.test(packageJson)) return 'mobile'
  if (/"electron"/.test(packageJson)) return 'desktop'
  if (has('index.html') || /"(next|vite|react|vue|svelte|astro)"/.test(packageJson)) return 'web'
  return 'altro'
}

export function frameworkDi(files: string[], manifesti: string): string[] {
  const trovati = new Set<string>()
  for (const f of files) {
    const nome = FILE_NOTI[f.split('/').pop()!.toLowerCase()]
    if (nome) trovati.add(nome)
    if (/(^|\/)supabase\/config\.toml$/i.test(f)) trovati.add('Supabase')
  }
  for (const [dip, nome] of Object.entries(DIPENDENZE)) {
    if (new RegExp(`(^|["'\\s])${dip}(["'\\s=<>~\\[]|$)`, 'im').test(manifesti)) trovati.add(nome)
  }
  return [...trovati].sort()
}

export function titoloDi(testo: string): string | null {
  let fence = false
  for (const riga of testo.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(riga)) fence = !fence
    const m = !fence && /^#\s+(.+?)\s*#*$/.exec(riga)
    if (m) return m[1]
  }
  return null
}

// La firma cambia solo se il contenuto può essere cambiato: per i file puliti è il blob di git, per gli altri dimensione e data.
export async function leggiAlbero(repo: string): Promise<Map<string, string>> {
  const albero = new Map<string, string>()
  for (const voce of (await git(repo, 'ls-files', '-z', '-s')).split('\0').filter(Boolean)) {
    const tab = voce.indexOf('\t')
    const [modo, sha] = voce.slice(0, tab).split(' ')
    if (modo !== '160000') albero.set(voce.slice(tab + 1), sha)
  }
  const cambiati = parseStatus(await git(repo, 'status', '--porcelain', '-z', '-uall'))
  const radice = await realpath(repo)
  await Promise.all(cambiati.map(async ({ path }) => {
    const info = await lstat(join(repo, path)).catch(() => null)
    // Su Windows git attraversa le giunzioni: quei file non sono della repo.
    if (info?.isFile() && (await dentroLaRepo(radice, path))) albero.set(path, `disco:${info.size}:${info.mtimeMs}`)
    else albero.delete(path)
  }))
  return albero
}

// Il percorso vero, dopo aver seguito i collegamenti, solo se resta nella repo.
export async function dentroLaRepo(radice: string, file: string): Promise<string | null> {
  if (isAbsolute(file)) return null
  const vero = await realpath(resolve(radice, file)).catch(() => null)
  if (!vero) return null
  const dentro = relative(radice, vero)
  return !dentro || dentro.startsWith('..') || isAbsolute(dentro) ? null : vero
}

export async function leggiTesto(repo: string, file: string): Promise<string | null> {
  const dove = await dentroLaRepo(await realpath(repo), file)
  if (!dove) return null
  const info = await lstat(dove).catch(() => null)
  if (!info?.isFile() || info.size > MAX_DOC_BYTES) return null
  return readFile(dove, 'utf8').catch(() => null)
}

export async function leggiManifesti(repo: string, files: string[]): Promise<{ packageJson: string; tutti: string }> {
  const scelti = files.filter((f) => MANIFESTI.test(f)).sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 20)
  const testi = await Promise.all(scelti.map(async (f) => [f, (await leggiTesto(repo, f)) ?? ''] as const))
  return { packageJson: testi.filter(([f]) => /package\.json$/i.test(f)).map(([, t]) => t).join('\n'), tutti: testi.map(([, t]) => t).join('\n') }
}

export function parseVociCodice(testo: string): VoceCodice[] {
  const voci: VoceCodice[] = []
  for (const riga of testo.split('\n')) {
    const m = /^([^\0]+)\0(\d+)[:\0](.*)$/.exec(riga.replace(/\r$/, ''))
    if (m && m[3].length <= MAX_RIGA_VOCE) voci.push({ file: m[1], riga: Number(m[2]), testo: m[3].trim() })
    if (voci.length >= MAX_VOCI_CODICE) break
  }
  return voci
}

export async function leggiVociCodice(repo: string): Promise<VoceCodice[]> {
  const uscita = await git(repo, 'grep', '-n', '-I', '-z', '--untracked', '-E', '\\b(TODO|FIXME)\\b', '--', '.', ':(exclude)*.md').catch((e) => {
    // git grep esce con 1 quando non trova nulla.
    if (e.code === 1) return ''
    throw e
  })
  return parseVociCodice(uscita)
}

const DA_SORVEGLIARE = /^(HEAD|index|packed-refs|FETCH_HEAD|ORIG_HEAD)$|^refs[\\/]|^worktrees[\\/][^\\/]+[\\/](HEAD|index)$/

export async function sorvegliaGit(repo: string, avvisa: () => void): Promise<() => void> {
  const cartella = resolve(repo, (await git(repo, 'rev-parse', '--git-common-dir')).trim())
  let timer: NodeJS.Timeout | undefined
  const watcher: FSWatcher = watch(cartella, { recursive: true }, (_evento, nome) => {
    if (!nome || !DA_SORVEGLIARE.test(nome)) return
    clearTimeout(timer)
    timer = setTimeout(avvisa, 200)
  })
  watcher.on('error', () => watcher.close())
  return () => {
    clearTimeout(timer)
    watcher.close()
  }
}
