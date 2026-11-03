import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { t } from '../shared/i18n.ts'

// Project Doctor: legge i file del progetto e dice come sembra si avvii. Non esegue mai niente del progetto.
const exec = promisify(execFile)

export type Certezza = 'guida' | 'dichiarato' | 'ipotizzato'
export type Fonte = { file: string; riga: number }
export type Comando = { tipo: 'installa' | 'avvia' | 'test' | 'build' | 'altro'; comando: string; certezza: Certezza; fonte: Fonte; nota?: string }
export type Parte = { cartella: string; stack: string[]; comandi: Comando[]; variabili: { fonte: Fonte; nomi: string[]; citate?: number }[]; servizi: { nome: string; fonte: Fonte }[] }
export type Prerequisito = { nome: string; perche: string; fonte: Fonte; trovato: boolean | null }
export type Referto = { parti: Parte[]; dallaGuida: Comando[]; prerequisiti: Prerequisito[]; ci: Comando[]; guide: { titolo: string; fonte: Fonte }[]; nonEsaminati: number }
export type Lettura = (file: string) => Promise<string | null>

const FUORI = /(^|\/)(node_modules|vendor|dist|build|out|target|\.git|\.github|\.devcontainer|\.dart_tool|__pycache__|\.venv|venv|Pods|third_party|legacy|deprecated|archive)\//
const MAX_PARTI = 12
const MAX_PROFONDITA = 3
const SCRIPT_UTILI: [RegExp, Comando['tipo']][] = [[/^(deps|setup|bootstrap)([:-]|$)/, 'installa'], [/^(dev|start|serve|develop|preview|watch)([:-]|$)/, 'avvia'], [/^(test|e2e)([:-]|$)/, 'test'], [/^(build|dist|compile)([:-]|$)/, 'build'], [/^(lint|typecheck|check|format)([:-]|$)/, 'altro']]
const ESEMPI_ENV = /^\.env(\.[\w-]+)?\.(example|sample|template|dist)$|^example\.env$/i
const CARTELLA = (f: string): string => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')
const NOME = (f: string): string => f.slice(f.lastIndexOf('/') + 1)
const unisci = (c: string, f: string): string => (c ? `${c}/${f}` : f)
const rigaDi = (testo: string, cerca: RegExp): number => Math.max(1, testo.split(/\r?\n/).findIndex((r) => cerca.test(r)) + 1)
// Il programma che il progetto porta con sé: su Windows ha un altro nome.
export const involucro = (nome: string, piattaforma: string = process.platform): string => (piattaforma === 'win32' ? `.\\${nome}${nome === 'mvnw' ? '.cmd' : '.bat'}` : `./${nome}`)
const serveA = (cartella: string): string => (cartella ? t('doctor.why.folder', { folder: cartella }) : t('doctor.why.root'))
const scappa = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const STACK_NODE: [string, string][] = [['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['@angular/core', 'Angular'], ['electron', 'Electron'], ['vite', 'Vite'], ['express', 'Express'], ['fastify', 'Fastify'], ['@nestjs/core', 'NestJS'], ['typescript', 'TypeScript'], ['prisma', 'Prisma'], ['remotion', 'Remotion'], ['pg', 'PostgreSQL'], ['mongoose', 'MongoDB'], ['@supabase/supabase-js', 'Supabase']]
const STACK_PY: [RegExp, string][] = [[/\bdjango\b/i, 'Django'], [/\bfastapi\b/i, 'FastAPI'], [/\bflask\b/i, 'Flask'], [/\bpsycopg|sqlalchemy\b/i, 'SQL'], [/\bpytest\b/i, 'pytest']]
const SERVIZI: [RegExp, string][] = [[/postgres/i, 'PostgreSQL'], [/mysql|mariadb/i, 'MySQL'], [/redis/i, 'Redis'], [/mongo/i, 'MongoDB'], [/rabbitmq/i, 'RabbitMQ'], [/elasticsearch|opensearch/i, 'Elasticsearch'], [/minio/i, 'MinIO'], [/caddy|nginx/i, 'Proxy web']]

// Il lockfile più vicino risalendo: in un monorepo una sottocartella usa il gestore della radice, e si installa da lì.
function lockVicino(cartella: string, elenco: Set<string>, nomi: string[]): { dove: string; nome: string } | null {
  for (let c: string | null = cartella; c !== null; c = c ? CARTELLA(c) : null) {
    const nome = nomi.find((n) => elenco.has(unisci(c!, n)))
    if (nome) return { dove: c, nome }
  }
  return null
}

const TITOLI_GUIDA = /install|setup|set up|getting started|quick ?start|\brun|usage|develop|contribut|test|build|requirement|avvi|inizia|configura|requisit|prerequis/i
const PRIORITA: Record<Comando['tipo'], number> = { installa: 0, avvia: 1, test: 2, build: 3, altro: 4 }
// Prima il comando più essenziale di ogni tipo, così i principali non sono cinque varianti dello stesso. Un'ipotesi va in fondo se il progetto dice già come si fa quella cosa.
export const inOrdine = (c: Comando[], coperti: ReadonlySet<Comando['tipo']> = new Set()): Comando[] => {
  const scritti = new Set([...coperti, ...c.filter((x) => x.certezza !== 'ipotizzato').map((x) => x.tipo)])
  const superata = (x: Comando): boolean => x.certezza === 'ipotizzato' && scritti.has(x.tipo)
  const variante = (x: Comando): boolean => /\b(e2e|integration|coverage|ci|watch)\b/i.test(x.comando) && x.tipo === 'test'
  const base = [...c].sort((a, b) => Number(superata(a)) - Number(superata(b)) || PRIORITA[a.tipo] - PRIORITA[b.tipo] || Number(variante(a)) - Number(variante(b)) || Number(b.comando.startsWith('bin/')) - Number(a.comando.startsWith('bin/')) || a.comando.length - b.comando.length)
  const visti = new Set<Comando['tipo']>(['altro'])
  const primi = base.filter((x) => !superata(x) && !visti.has(x.tipo) && visti.add(x.tipo))
  return [...primi, ...base.filter((x) => !primi.includes(x))]
}

const LANCIABILE = /^(npm|npx|pnpm|yarn|bun|make|go|cargo|docker|docker-compose|pip3?|pipx|uv|poetry|python3?|pytest|bundle|rails|rake|bin\/\S+|\.\/\S+|composer|php|mvn|gradle|dotnet|flutter|dart|cp|copy|supabase|mise|just|task|tox|nx|turbo)(\s|$)/
const tipoDiRiga = (c: string): Comando['tipo'] => (/\b(test|pytest|rspec|jest|vitest|e2e)\b/i.test(c) ? 'test' : /^(cp|copy)\b|\b(install|setup|deps|bootstrap|sync|ci)\b/i.test(c) ? 'installa' : /\b(dev|dx|start|run|serve|up|watch)\b/i.test(c) ? 'avvia' : /\b(build|compile|dist)\b/i.test(c) ? 'build' : 'altro')

// I comandi scritti nei blocchi di codice di una guida, sotto titoli su come partire. Restano nell'ordine della guida, con la cartella e il titolo della sezione: dicono dove lanciarli e per quale sistema.
export function comandiGuida(file: string, testo: string): Comando[] {
  const out: Comando[] = []
  let fence = false
  let titolo = ''
  const tutta = !/(^|\/)readme[^/]*$/i.test(file)
  let utile = tutta
  let livelloUtile = 0
  let cartella = ''
  testo.split(/\r?\n/).forEach((r, i) => {
    if (/^\s*(```|~~~)/.test(r)) {
      fence = !fence
      cartella = ''
      return
    }
    if (!fence) {
      const m = /^#{1,4}\s+(.+)$/.exec(r)
      if (m) {
        titolo = m[1].trim()
        const livello = /^#+/.exec(r)![0].length
        if (TITOLI_GUIDA.test(titolo)) {
          if (!utile || livello <= livelloUtile) livelloUtile = livello
          utile = true
        } else if (!tutta && livello <= livelloUtile) utile = false
      }
      return
    }
    if (!utile) return
    const comando = r.trim().replace(/^[$>]\s+/, '').replace(/^(\w+=\S*\s+)+/, '')
    const cd = /^cd\s+(\S+)$/.exec(comando)
    if (cd) cartella = cd[1]
    if (cd || !LANCIABILE.test(comando) || comando.length > 200) return
    out.push({ tipo: tipoDiRiga(comando), comando, certezza: 'guida', fonte: { file, riga: i + 1 }, nota: cartella ? t('doctor.guide.noteFolder', { title: titolo, folder: cartella }) : t('doctor.guide.note', { title: titolo }) })
  })
  return out
}

// Un pyproject può servire solo a configurare i linter: non vuol dire che il progetto sia in Python.
export const pyprojectVero = (testo: string): boolean => /^\[build-system\]|^\[tool\.poetry\]/m.test(testo) || /^dependencies\s*=\s*\[\s*["']/m.test(testo)

export function leggiPackage(cartella: string, testo: string, elenco: Set<string>): Omit<Parte, 'cartella' | 'variabili' | 'servizi'> & { strumenti: string[] } {
  const file = unisci(cartella, 'package.json')
  const dati = JSON.parse(testo) as { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
  const lock = lockVicino(cartella, elenco, ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json'])
  const pm = lock?.nome.startsWith('pnpm') ? 'pnpm' : lock?.nome === 'yarn.lock' ? 'yarn' : lock?.nome.startsWith('bun') ? 'bun' : 'npm'
  const installa = lock?.nome === 'package-lock.json' ? 'npm ci' : pm === 'pnpm' && lock ? 'pnpm install --frozen-lockfile' : `${pm} install`
  const comandi: Comando[] = !lock || lock.dove === cartella ? [{ tipo: 'installa', comando: installa, certezza: 'ipotizzato', fonte: { file, riga: 1 }, nota: t('doctor.warn.install') }] : []
  for (const [nome, valore] of Object.entries(dati.scripts ?? {})) {
    const tipo = SCRIPT_UTILI.find(([r]) => r.test(nome))?.[1]
    if (!tipo || typeof valore !== 'string') continue
    comandi.push({ tipo, comando: pm === 'npm' ? `npm run ${nome}` : `${pm} ${nome}`, certezza: 'dichiarato', fonte: { file, riga: rigaDi(testo, new RegExp(`"${scappa(nome)}"\\s*:`)) } })
  }
  const dip = { ...dati.dependencies, ...dati.devDependencies }
  return { stack: ['Node.js', ...STACK_NODE.filter(([k]) => k in dip).map(([, v]) => v)], comandi, strumenti: ['node', pm] }
}

function leggiMakefile(cartella: string, testo: string): Comando[] {
  const file = unisci(cartella, 'Makefile')
  const out: Comando[] = []
  testo.split(/\r?\n/).forEach((r, i) => {
    const m = /^([a-zA-Z][\w-]*)\s*:(?!=)/.exec(r)
    const tipo = m && SCRIPT_UTILI.find(([x]) => x.test(m[1]))?.[1]
    if (m && tipo) out.push({ tipo, comando: `make ${m[1]}`, certezza: 'dichiarato', fonte: { file, riga: i + 1 } })
  })
  return out
}

// Solo i nomi delle variabili: anche un file di esempio può contenere un valore vero.
export function nomiVariabili(testo: string): string[] {
  return [...new Set(testo.split(/\r?\n/).map((r) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(r)?.[1]).filter((x): x is string => Boolean(x)))]
}

export function serviziCompose(file: string, testo: string): { nome: string; fonte: Fonte }[] {
  const out: { nome: string; fonte: Fonte }[] = []
  const visti = new Set<string>()
  testo.split(/\r?\n/).forEach((r, i) => {
    if (!/^\s*image\s*:/.test(r)) return
    const nome = SERVIZI.find(([x]) => x.test(r))?.[1]
    if (nome && !visti.has(nome)) {
      visti.add(nome)
      out.push({ nome, fonte: { file, riga: i + 1 } })
    }
  })
  return out
}

export function comandiCi(file: string, testo: string): Comando[] {
  const out: Comando[] = []
  const righe = testo.split(/\r?\n/)
  righe.forEach((r, i) => {
    const m = /^(\s*)(?:-\s*)?run\s*:\s*(.*)$/.exec(r)
    if (!m) return
    const raccogli = (t: string, n: number): void => {
      const comando = t.trim()
      if (!comando || comando.startsWith('#')) return
      // Della CI interessano prove e compilazione: script e pacchetti di sistema valgono per quella macchina.
      if (!LANCIABILE.test(comando)) return
      const tipo: Comando['tipo'] | null = /\b(test|pytest|jest|vitest|e2e)\b/i.test(comando) ? 'test' : /\b(build|compile|dist)\b/i.test(comando) ? 'build' : null
      if (!tipo) return
      out.push({ tipo, comando: comando.slice(0, 200), certezza: 'dichiarato', fonte: { file, riga: n } })
    }
    if (!/^[|>]/.test(m[2])) return raccogli(m[2], i + 1)
    const base = r.search(/\S/)
    for (let j = i + 1; j < righe.length && (!righe[j].trim() || righe[j].search(/\S/) > base); j++) raccogli(righe[j], j + 1)
  })
  return out
}

export function titoliGuida(file: string, testo: string): { titolo: string; fonte: Fonte }[] {
  const out: { titolo: string; fonte: Fonte }[] = []
  let fence = false
  testo.split(/\r?\n/).forEach((r, i) => {
    if (/^\s*(```|~~~)/.test(r)) fence = !fence
    const m = !fence && /^#{1,4}\s+(.+)$/.exec(r)
    if (m && TITOLI_GUIDA.test(m[1])) out.push({ titolo: m[1].trim(), fonte: { file, riga: i + 1 } })
  })
  return out
}

export async function analizza(elenco: string[], leggi: Lettura): Promise<Omit<Referto, 'prerequisiti'> & { strumenti: { nome: string; perche: string; fonte: Fonte }[] }> {
  const insieme = new Set(elenco)
  const utili = elenco.filter((f) => !FUORI.test(`/${f}`) && f.split('/').length <= MAX_PROFONDITA + 1)
  const MANIFESTI = /^(package\.json|pubspec\.yaml|requirements\.txt|pyproject\.toml|Pipfile|manage\.py|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|.*\.(csproj|sln)|Gemfile|composer\.json|Makefile|docker-compose\.ya?ml|compose\.ya?ml|config\.toml)$/
  const cartelle = new Map<string, string[]>()
  for (const f of utili) {
    const n = NOME(f)
    if (!MANIFESTI.test(n) && !ESEMPI_ENV.test(n)) continue
    if (n === 'config.toml' && NOME(CARTELLA(f)) !== 'supabase') continue
    if (!cartelle.has(CARTELLA(f))) cartelle.set(CARTELLA(f), [])
    cartelle.get(CARTELLA(f))!.push(f)
  }
  // Le cartelle native di un progetto Flutter, o i moduli di un progetto Gradle, si costruiscono dal progetto che le contiene.
  const interne = (c: string): boolean => c.split('/').some((_, i, p) => {
    const sopra = p.slice(0, i).join('/')
    return (i > 0 || c.includes('/')) && (((/^(android|ios|macos|linux|windows|web)$/.test(p[i])) && insieme.has(unisci(sopra, 'pubspec.yaml'))) || (i > 0 && (insieme.has(unisci(sopra, 'build.gradle')) || insieme.has(unisci(sopra, 'build.gradle.kts')) || insieme.has(unisci(sopra, 'settings.gradle')) || insieme.has(unisci(sopra, 'settings.gradle.kts')))))
  })
  for (const c of [...cartelle.keys()]) if (interne(c)) cartelle.delete(c)
  const ordinate = [...cartelle.keys()].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  const strumenti: { nome: string; perche: string; fonte: Fonte }[] = []
  const serve = (nome: string, perche: string, file: string): void => {
    if (!strumenti.some((s) => s.nome === nome)) strumenti.push({ nome, perche, fonte: { file, riga: 1 } })
  }
  const parti: Parte[] = []
  for (const cartella of ordinate.slice(0, MAX_PARTI)) {
    const p: Parte = { cartella, stack: [], comandi: [], variabili: [], servizi: [] }
    const qui = cartelle.get(cartella)!
    const ha = (n: string): boolean => insieme.has(unisci(cartella, n))
    const ipotesi = (tipo: Comando['tipo'], comando: string, file: string, nota?: string): void => void p.comandi.push({ tipo, comando, certezza: 'ipotizzato', fonte: { file, riga: 1 }, ...(nota ? { nota } : {}) })
    for (const file of qui) {
      const n = NOME(file)
      const testo = (await leggi(file)) ?? ''
      if (n === 'package.json') {
        try {
          const j = leggiPackage(cartella, testo, insieme)
          p.stack.push(...j.stack)
          p.comandi.push(...j.comandi)
          for (const s of j.strumenti) serve(s, serveA(cartella), file)
        } catch {
          p.stack.push('Node.js')
        }
      } else if (n === 'pubspec.yaml') {
        const flutter = /^\s*flutter\s*:/m.test(testo)
        const sdk = flutter ? 'flutter' : 'dart'
        p.stack.push(flutter ? 'Flutter' : 'Dart')
        ipotesi('installa', `${sdk} pub get`, file, t('doctor.warn.install'))
        if (flutter) ipotesi('avvia', 'flutter run', file)
        if (elenco.some((f) => f.startsWith(unisci(cartella, 'test/')))) ipotesi('test', `${sdk} test`, file)
        serve(sdk, serveA(cartella), file)
      } else if (n === 'requirements.txt' || n === 'pyproject.toml' || n === 'Pipfile') {
        if (n === 'pyproject.toml' && !pyprojectVero(testo)) continue
        p.stack.push('Python', ...STACK_PY.filter(([r]) => r.test(testo)).map(([, v]) => v))
        const lockPy = lockVicino(cartella, insieme, ['uv.lock', 'poetry.lock'])
        const uv = lockPy?.nome === 'uv.lock'
        const poetry = lockPy?.nome === 'poetry.lock'
        if (lockPy && lockPy.dove !== cartella && n !== 'requirements.txt') {
          // Si installa dalla radice che ha il lockfile.
        } else if (n === 'requirements.txt') ipotesi('installa', 'pip install -r requirements.txt', file, t('doctor.warn.install'))
        else ipotesi('installa', uv ? 'uv sync' : poetry ? 'poetry install' : n === 'Pipfile' ? 'pipenv install' : 'pip install .', file, t('doctor.warn.install'))
        if (elenco.some((f) => f.startsWith(unisci(cartella, 'tests/')) || (f.startsWith(unisci(cartella, '')) && /(^|\/)(test_\w+|\w+_test)\.py$/.test(f)))) ipotesi('test', 'pytest', file)
        serve('python', serveA(cartella), file)
        if (lockPy) serve(uv ? 'uv' : 'poetry', t('doctor.why.lock', { file: lockPy.nome }), unisci(lockPy.dove, lockPy.nome))
      } else if (n === 'manage.py') {
        p.stack.push('Django')
        ipotesi('avvia', 'python manage.py runserver', file)
        ipotesi('test', 'python manage.py test', file)
      } else if (n === 'go.mod') {
        p.stack.push('Go')
        ipotesi('build', 'go build ./...', file)
        ipotesi('test', 'go test ./...', file)
        serve('go', serveA(cartella), file)
      } else if (n === 'Cargo.toml') {
        p.stack.push('Rust')
        ipotesi('build', 'cargo build', file)
        ipotesi('avvia', 'cargo run', file)
        ipotesi('test', 'cargo test', file)
        serve('cargo', serveA(cartella), file)
      } else if (n === 'pom.xml') {
        p.stack.push('Java', 'Maven')
        const mvn = ha('mvnw') ? involucro('mvnw') : 'mvn'
        ipotesi('build', `${mvn} package`, file)
        ipotesi('test', `${mvn} test`, file)
        if (mvn === 'mvn') serve('mvn', serveA(cartella), file)
        serve('java', serveA(cartella), file)
      } else if (/^build\.gradle/.test(n)) {
        const g = ha('gradlew') ? involucro('gradlew') : 'gradle'
        p.stack.push('Gradle')
        ipotesi('build', `${g} build`, file)
        ipotesi('test', `${g} test`, file)
        if (g === 'gradle') serve('gradle', serveA(cartella), file)
        serve('java', serveA(cartella), file)
      } else if (/\.(csproj|sln)$/.test(n)) {
        if (!p.stack.includes('.NET')) {
          p.stack.push('.NET')
          ipotesi('build', 'dotnet build', file)
          ipotesi('test', 'dotnet test', file)
          serve('dotnet', serveA(cartella), file)
        }
      } else if (n === 'Gemfile') {
        p.stack.push('Ruby')
        ipotesi('installa', 'bundle install', file, t('doctor.warn.install'))
        serve('bundle', serveA(cartella), file)
      } else if (n === 'composer.json') {
        p.stack.push('PHP')
        ipotesi('installa', 'composer install', file, t('doctor.warn.install'))
        serve('composer', serveA(cartella), file)
      } else if (n === 'Makefile') {
        p.comandi.push(...leggiMakefile(cartella, testo))
        serve('make', t('doctor.why.makefile', { folder: cartella || t('doctor.why.rootName') }), file)
      } else if (/compose\.ya?ml$/.test(n)) {
        p.stack.push('Docker Compose')
        p.servizi.push(...serviziCompose(file, testo))
        ipotesi('avvia', 'docker compose up', file, t('doctor.warn.compose'))
        serve('docker', serveA(cartella), file)
      } else if (n === 'config.toml') {
        p.stack.push('Supabase')
        ipotesi('avvia', 'supabase start', file, t('doctor.note.supabase'))
        serve('supabase', t('doctor.why.supabase'), file)
        serve('docker', t('doctor.why.supabaseDocker'), file)
      } else if (ESEMPI_ENV.test(n)) {
        const nomi = nomiVariabili(testo)
        if (nomi.length) p.variabili.push({ fonte: { file, riga: 1 }, nomi })
      }
    }
    for (const [nome, tipo] of [['setup', 'installa'], ['dev', 'avvia'], ['rspec', 'test'], ['test', 'test']] as const) {
      const f = unisci(cartella, `bin/${nome}`)
      if (insieme.has(f)) p.comandi.push({ tipo, comando: `bin/${nome}`, certezza: 'dichiarato', fonte: { file: f, riga: 1 }, ...(tipo === 'installa' ? { nota: t('doctor.warn.install') } : {}) })
    }
    if (ha('Gemfile') && !ha('bin/rspec') && elenco.some((f) => f.startsWith(unisci(cartella, 'spec/')))) ipotesi('test', 'bundle exec rspec', unisci(cartella, 'Gemfile'))
    p.stack = [...new Set(p.stack)]
    if (p.stack.length || p.comandi.length || p.variabili.length) parti.push(p)
  }
  const ci: Comando[] = []
  for (const f of elenco.filter((x) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(x)).slice(0, 12)) ci.push(...comandiCi(f, (await leggi(f)) ?? ''))
  const guide: { titolo: string; fonte: Fonte }[] = []
  const dallaGuida: Comando[] = []
  let testoGuide = ''
  const fileGuida = elenco.filter((x) => /^(readme|contributing|install|development|setup)(\.[\w-]+)?\.(md|mdx|rst|txt)$/i.test(x) || /^docs\/(.*\/)?(setup|install|getting-started|development|contributing)[^/]*\.mdx?$/i.test(x))
  // Il README per primo: è da lì che parte chi arriva.
  for (const f of fileGuida.sort((a, b) => Number(/^readme/i.test(b)) - Number(/^readme/i.test(a))).slice(0, 12)) {
    const testo = (await leggi(f)) ?? ''
    testoGuide += `\n${testo}`
    guide.push(...titoliGuida(f, testo))
    dallaGuida.push(...comandiGuida(f, testo).filter((c) => !dallaGuida.some((x) => x.comando === c.comando)))
  }
  const coperti = new Set(dallaGuida.map((c) => c.tipo))
  for (const p of parti) {
    p.comandi = inOrdine(p.comandi, coperti)
    // Prima il file e le variabili che la guida nomina: sono quelli che chi inizia deve toccare davvero.
    const citata = (x: string): boolean => new RegExp(`\\b${scappa(x)}\\b`).test(testoGuide)
    p.variabili = p.variabili.map((v) => {
      const citate = v.nomi.filter(citata)
      return { ...v, nomi: [...citate, ...v.nomi.filter((x) => !citate.includes(x))], citate: citate.length }
    }).sort((a, b) => Number(testoGuide.includes(NOME(b.fonte.file))) - Number(testoGuide.includes(NOME(a.fonte.file))))
  }
  return { parti, dallaGuida: dallaGuida.slice(0, 30), ci: ci.slice(0, 40), guide: guide.slice(0, 40), strumenti, nonEsaminati: Math.max(0, ordinate.length - MAX_PARTI) }
}

// I nomi vengono da un elenco fisso di Hub, e la ricerca parte fuori dal progetto: su Windows la cartella corrente conta, e una repo non fidata può contenere un eseguibile con lo stesso nome.
const NOTI = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'flutter', 'dart', 'python', 'uv', 'poetry', 'go', 'cargo', 'mvn', 'gradle', 'java', 'dotnet', 'bundle', 'composer', 'make', 'docker', 'supabase'])

export async function strumentoPresente(nome: string): Promise<boolean | null> {
  if (!NOTI.has(nome)) return null
  const cerca = process.platform === 'win32' ? 'where' : 'which'
  return exec(cerca, [nome], { cwd: tmpdir(), timeout: 5000, windowsHide: true }).then(() => true, () => false)
}

export async function visita(elenco: string[], leggi: Lettura): Promise<Referto> {
  const { strumenti, ...resto } = await analizza(elenco, leggi)
  return { ...resto, prerequisiti: await Promise.all(strumenti.map(async (s) => ({ ...s, trovato: await strumentoPresente(s.nome) }))) }
}
