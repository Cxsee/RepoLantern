import assert from 'node:assert/strict'
import test from 'node:test'
import { sezioneValida, sezioniDi, soloUltima } from './sezioni.ts'

test('una sezione di modulo compare solo se il modulo è attivo', () => {
  assert.ok(!sezioniDi(new Set()).some((s) => s.id === 'social'))
  assert.ok(sezioniDi(new Set(['social'])).some((s) => s.id === 'social'))
  assert.deepEqual(sezioniDi(new Set()).map((s) => s.id), ['home', 'avvio', 'todo', 'stato', 'branch', 'claude', 'anteprima'])
})

test('una sezione salvata che non esiste più riporta alla prima', () => {
  assert.equal(sezioneValida('branch', new Set()), 'branch')
  assert.equal(sezioneValida('social', new Set(['social'])), 'social')
  assert.equal(sezioneValida('social', new Set()), 'home')
  for (const rotta of ['inventata', null, 3]) assert.equal(sezioneValida(rotta, new Set()), 'home')
})

test('di due risposte fuori ordine conta solo la più recente', async () => {
  const lancia = soloUltima<string>()
  const visti: string[] = []
  let lenta: (v: string) => void = () => {}
  lancia(new Promise((r) => { lenta = r }), (v) => void visti.push(v), () => void visti.push('errore'))
  lancia(Promise.resolve('recente'), (v) => void visti.push(v), () => void visti.push('errore'))
  await new Promise((r) => setTimeout(r, 5))
  lenta('vecchia')
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(visti, ['recente'])
  lancia(Promise.reject(new Error('x')), () => void visti.push('no'), () => void visti.push('errore'))
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(visti, ['recente', 'errore'])
})
