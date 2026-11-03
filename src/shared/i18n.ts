import { en } from './en.ts'
import { it } from './it.ts'

export type Lingua = 'en' | 'it'
export type Chiave = keyof typeof en

const DIZIONARI: Record<Lingua, Record<Chiave, string>> = { en, it }
let attuale: Lingua = 'en'

export const linguaDaLocale = (locale: string): Lingua => (locale.toLowerCase().startsWith('it') ? 'it' : 'en')
export const lingua = (): Lingua => attuale
export const locale = (): string => (attuale === 'it' ? 'it-IT' : 'en-US')
export const setLingua = (l: Lingua): void => {
  attuale = l
}
export const t = (k: Chiave, v: Record<string, string | number> = {}): string =>
  DIZIONARI[attuale][k].replace(/\{(\w+)\}/g, (tutto, n: string) => (n in v ? String(v[n]) : tutto))
