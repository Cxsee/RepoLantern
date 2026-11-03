import { readFile, realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { dentroLaRepo, git, SEGRETO } from './scansione.ts'

export type Occorrenza = { file: string; riga: number; testo: string; tipo: 'definizione' | 'codice' | 'test' | 'documento'; nonTracciato?: boolean }
export type RisultatiCodice = { voci: Occorrenza[]; altri: number; parole?: string[]; esatte?: number }
export type BranoFile = { inizio: number; righe: string[]; totale: number }

const MAX_TESTO = 200
const MAX_VOCI = 80
const PER_FILE = 20
const MAX_RIGA = 240
const RIGHE_PER_PAROLE = 2
const POCHE = 3
const MAX_FILE = 4 * 1024 * 1024
const MARGINE = 250
// File generati: pieni di occorrenze e inutili per capire un progetto.
const ESCLUSI = ['*.lock', '*-lock.json', '*-lock.yaml', '*.min.js', '*.min.css', '*.map', '*.g.dart', '*.freezed.dart'].map((g) => `:(exclude,glob)**/${g}`)
const ORDINE: Record<Occorrenza['tipo'], number> = { definizione: 0, codice: 1, test: 3, documento: 4 }
const VUOTE = new Set(['the', 'and', 'for', 'from', 'with', 'into', 'how', 'where', 'what', 'che', 'del', 'della', 'delle', 'dei', 'per', 'con', 'come', 'dove'])
const migrazione = (f: string): boolean => /(^|\/)(migrations?|migrate)\//.test(f)
// Codice che raramente è quello che si cerca: commenti, dati, migrazioni, automazioni del repository. Restano sopra test e documenti.
const inSecondoPiano = (v: Occorrenza): boolean => v.tipo === 'codice' && (/^(\/\/|#|\*|\/\*|--|<!--)/.test(v.testo) || /\.(json|ya?ml|xml|svg|csv|tmpl)$/i.test(v.file) || /(^|\/)\.github\//.test(v.file) || migrazione(v.file))
const peso = (v: Occorrenza): number => (inSecondoPiano(v) ? 2 : ORDINE[v.tipo])

const scappa = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ponytail: riconosce le definizioni comuni dal testo, senza capire il linguaggio; una definizione insolita resta fra il codice normale.
function tipoDi(file: string, riga: string, cercato: string): Occorrenza['tipo'] {
  const n = scappa(cercato)
  const definizione = new RegExp(`\\b(function|def|class|interface|enum|struct|type|fn|func|mixin|extension)\\s+(public\\.)?${n}\\b|\\b(const|let|var|final)\\s+${n}\\s*[=:]|^\\s*[\\w<>?,\\[\\] .]*\\b${n}\\s*\\([^;]*\\)\\s*(async\\s*)?(\\{|=>|:)\\s*$`, 'i')
  // Prima il tipo di file: una definizione dentro un test o una traduzione non è quella che si cerca.
  if (/(^|\/)(tests?|e2e|__tests__|spec)\/|[._](test|spec)\.\w+$|(^|\/)test_\w+\.\w+$/i.test(file)) return 'test'
  if (/\.(md|mdx|txt|rst)$/i.test(file) || /(^|\/)(locales?|i18n|l10n|translations|lang)\//i.test(file)) return 'documento'
  if (definizione.test(riga)) return 'definizione'
  return 'codice'
}

// Una riga lunghissima, come nei file compressi, si accorcia attorno a ciò che si cerca.
function ritaglia(riga: string, cercato: string): string {
  const t = riga.trim()
  if (t.length <= MAX_RIGA) return t
  const dove = Math.max(0, t.toLowerCase().indexOf(cercato.toLowerCase()))
  const da = Math.max(0, dove - 80)
  return `${da ? '…' : ''}${t.slice(da, da + MAX_RIGA)}…`
}

export function leggiRisultati(output: string, cercato: string, nonTracciati: ReadonlySet<string> = new Set(), massimo = MAX_VOCI): RisultatiCodice {
  const voci: Occorrenza[] = []
  for (const linea of output.split('\n')) {
    const [file, riga, ...resto] = linea.split('\0')
    if (!file || !riga || !resto.length || SEGRETO.test(basename(file))) continue
    const testo = resto.join(' ').replace(/\r$/, '')
    voci.push({ file, riga: Number(riga), testo: ritaglia(testo, cercato), tipo: tipoDi(file, testo, cercato), ...(nonTracciati.has(file) ? { nonTracciato: true } : {}) })
  }
  // Fra le migrazioni la più recente viene prima: è un ordine, non la prova che sia quella attiva.
  voci.sort((a, b) => peso(a) - peso(b) || Number(migrazione(b.file)) - Number(migrazione(a.file)) || (migrazione(a.file) ? b.file.localeCompare(a.file) : 0))
  return { voci: voci.slice(0, massimo), altri: Math.max(0, voci.length - massimo) }
}

// La parte comune di una parola: "creation" deve trovare createBooking, "delivery" deve trovare deliver.
export function radice(parola: string): string {
  for (const fine of ['ations', 'ation', 'ions', 'ion', 'ies', 'ing', 'ed', 'es', 's', 'y', 'e']) {
    if (parola.endsWith(fine) && parola.length - fine.length >= 4) return parola.slice(0, -fine.length)
  }
  return parola
}
const scappaTutto = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// All'inizio di una parola, anche dentro un nome composto: niente "postgres" per "post", ma "handleNewBooking" per "booking".
const haParola = (testo: string, r: string): boolean => {
  const n = scappaTutto(r)
  return new RegExp(`(?<![a-zA-Z])${n}`, 'i').test(testo) || new RegExp(`(?<=[a-z])${n[0].toUpperCase()}${n.slice(1)}`).test(testo)
}
const nomeDefinito = (riga: string, r: string): boolean => {
  const n = scappaTutto(r)
  return new RegExp(`\\b(function|def|class|interface|enum|struct|type|fn|func)\\s+\\w*${n}|^\\s*((public|private|protected|static|async)\\s+)*\\w*${n}\\w*\\s*\\([^;]*\\)\\s*(:[^=]*)?\\{\\s*$`, 'i').test(riga)
}

// Una frase raramente compare identica nel codice. Si tengono i file che hanno tutte le parole, nelle righe o nel percorso, più le definizioni di ogni parola.
// ponytail: confronta parole e non significati, quindi "upload a photo" non trova il codice che parla solo di asset; serve un indice semantico se conta.
export function leggiPerParole(output: string, parole: string[], nonTracciati: ReadonlySet<string> = new Set()): RisultatiCodice {
  const radici = parole.map(radice)
  const perFile = new Map<string, string[]>()
  for (const linea of output.split('\n')) {
    if (!linea.includes('\0')) continue
    const file = linea.split('\0')[0]
    perFile.set(file, [...(perFile.get(file) ?? []), linea])
  }
  const copre = new Map<string, number>()
  const scelti: string[] = []
  for (const [file, righe] of perFile) {
    const testo = `${file}\n${righe.map((l) => l.split('\0').slice(2).join(' ')).join('\n')}`
    const quante = radici.filter((r) => haParola(testo, r)).length
    copre.set(file, quante)
    const conta = (l: string): number => radici.filter((r) => haParola(l.split('\0').slice(2).join(' '), r)).length
    if (quante === radici.length) scelti.push(...[...righe].sort((a, b) => conta(b) - conta(a)).slice(0, RIGHE_PER_PAROLE))
    else scelti.push(...righe.filter((l) => radici.some((r) => nomeDefinito(l.split('\0').slice(2).join(' '), r))).slice(0, RIGHE_PER_PAROLE))
  }
  const { voci, altri } = leggiRisultati(scelti.join('\n'), parole[0], nonTracciati, Infinity)
  for (const v of voci) if (v.tipo === 'codice' && radici.some((r) => nomeDefinito(v.testo, r))) v.tipo = 'definizione'
  const punti = (v: Occorrenza): number => (copre.get(v.file) ?? 0) * 2 - peso(v)
  voci.sort((a, b) => punti(b) - punti(a))
  return { voci: voci.slice(0, MAX_VOCI), altri: altri + Math.max(0, voci.length - MAX_VOCI), parole }
}

// Cerca nei file come sono ora, modifiche comprese, senza AI e senza eseguire nulla del progetto. Ciò che git ignora resta fuori.
export async function cercaNelCodice(repo: string, testo: unknown): Promise<RisultatiCodice> {
  const cercato = String(testo ?? '').trim().slice(0, MAX_TESTO)
  if (cercato.length < 2) return { voci: [], altri: 0 }
  // git grep esce con 1 quando non trova nulla: non è un errore.
  const trova = (...e: string[]): Promise<string> => git(repo, 'grep', '-n', '-I', '-i', '-F', '--untracked', '--null', '-m', String(PER_FILE), ...e.flatMap((x) => ['-e', x]), '--', '.', ...ESCLUSI).catch((err) => {
    if ((err as { code?: unknown }).code === 1) return ''
    throw err
  })
  const nonTracciati = new Set((await git(repo, 'ls-files', '-z', '--others', '--exclude-standard')).split('\0'))
  const esatta = leggiRisultati(await trova(cercato), cercato, nonTracciati)
  const vere = esatta.voci.filter((v) => peso(v) <= ORDINE.codice)
  if (vere.length >= POCHE) return esatta
  const parole = [...new Set(cercato.toLowerCase().split(/[\s,.;:/_-]+/))].filter((p) => p.length > 2 && !VUOTE.has(p))
  if (parole.length < 2) return esatta
  // La frase esatta sta solo in commenti, dati o documenti, oppure in pochissimo codice: si aggiungono i file con quelle parole, senza confonderli.
  const perParole = leggiPerParole(await trova(...parole.map(radice)), parole, nonTracciati)
  const chiave = (v: Occorrenza): string => `${v.file}:${v.riga}`
  const gia = new Set(vere.map(chiave))
  const nuove = perParole.voci.filter((v) => !gia.has(chiave(v)))
  const presi = new Set(nuove.map(chiave))
  return { voci: [...vere, ...nuove, ...esatta.voci.filter((v) => !gia.has(chiave(v)) && !presi.has(chiave(v)))].slice(0, MAX_VOCI), altri: perParole.altri, parole, esatte: esatta.voci.length }
}

export async function branoFile(repo: string, file: unknown, riga: unknown): Promise<BranoFile | null> {
  if (typeof file !== 'string' || SEGRETO.test(basename(file))) return null
  const vero = await dentroLaRepo(await realpath(repo), file)
  if (!vero || SEGRETO.test(basename(vero))) return null
  const info = await stat(vero)
  if (!info.isFile() || info.size > MAX_FILE) return null
  const testo = await readFile(vero, 'utf8')
  if (testo.includes('\0')) return null
  const righe = testo.replace(/\r\n/g, '\n').split('\n')
  const n = Math.min(Math.max(1, Math.floor(Number(riga)) || 1), righe.length)
  const inizio = Math.max(1, n - MARGINE)
  return { inizio, righe: righe.slice(inizio - 1, n + MARGINE).map((r) => r.slice(0, 1000)), totale: righe.length }
}
