import assert from 'node:assert/strict'
import test from 'node:test'
import { diagnosticReport, sanitize } from './diagnostica.ts'

const base = { app: '1', electron: '2', node: '3', os: 'win32 10', language: 'en', git: 'git 2', claude: true, repos: 2, errors: [] }

test('il report non contiene percorsi, nomi di repo né segreti', () => {
  const chiave = 'AKIA' + 'ABCDEFGHIJKLMNOP'
  const privati = ['C:\\Users\\mario\\segreto', 'C:\\Users\\mario']
  const r = diagnosticReport({ ...base, errors: [`Errore in C:\\Users\\mario\\segreto\\a.js con ${chiave}`, 'Da D:\\altro\\b.txt e /home/luca/x', 'In C:/Users/mario/segreto/c.js'] }, privati)
  assert.doesNotMatch(r, /mario|segreto|luca|altro|ABCDEFGHIJKLMNOP/)
  assert.match(r, /Errore in <path>/)
  assert.match(r, /Repositories added: 2/)
})

test('senza errori lo dice, e tiene solo gli ultimi', () => {
  assert.match(diagnosticReport(base, []), /Recent job errors: none/)
  const r = diagnosticReport({ ...base, errors: Array.from({ length: 30 }, (_, i) => `errore ${i}`) }, [])
  assert.equal(r.split('\n').filter((l) => l.startsWith('- ')).length, 10)
  assert.equal(sanitize('nessun percorso', []), 'nessun percorso')
})
