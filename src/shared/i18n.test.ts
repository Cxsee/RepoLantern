import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { en } from './en.ts'
import { linguaDaLocale, setLingua, t } from './i18n.ts'
import { it } from './it.ts'

const segnaposto = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

test('le due lingue hanno le stesse chiavi e gli stessi segnaposto', () => {
  assert.deepEqual(Object.keys(it).sort(), Object.keys(en).sort())
  for (const [k, v] of Object.entries(en)) {
    assert.deepEqual(segnaposto(it[k as keyof typeof en]), segnaposto(v), k)
    assert.ok(v.trim() && it[k as keyof typeof en].trim(), `${k} vuota`)
  }
})

test('nessuna chiave resta inutilizzata', () => {
  const file = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? file(join(d, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\.|[\\/]shared[\\/](en|it)\./.test(join(d, e.name)) ? [join(d, e.name)] : []))
  const codice = file('src').map((f) => readFileSync(f, 'utf8')).join('\n')
  // Le chiavi composte al volo (`doctor.kind.${tipo}`) contano per il loro prefisso.
  const prefissi = [...codice.matchAll(/`([\w.]+\.)\$\{/g)].map((m) => m[1])
  const orfane = Object.keys(en).filter((k) => !codice.includes(`'${k}'`) && !prefissi.some((p) => k.startsWith(p)))
  assert.deepEqual(orfane, [])
})

test('la lingua viene dal sistema: italiano se è italiano, altrimenti inglese', () => {
  assert.equal(linguaDaLocale('it-IT'), 'it')
  assert.equal(linguaDaLocale('fr'), 'en')
  setLingua('it')
  assert.equal(t('doctor.moreCommands', { n: 3 }), 'Altri 3 comandi')
  setLingua('en')
  assert.equal(t('doctor.moreCommands', { n: 3 }), '3 more commands')
})
