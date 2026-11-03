import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Archivio } from './archivio.ts'
import { datiVecchiDisponibili, importaDatiVecchi, Pianificatore, propostaSocial, SOCIAL_VUOTO, validaSocial } from './moduli.ts'

test("la configurazione accetta solo un nome d'emulatore sicuro e niente segreti", () => {
  assert.deepEqual(validaSocial(' Mio_AVD-1 ', ' Parti da TikTok '), { avd: 'Mio_AVD-1', istruzioni: 'Parti da TikTok' })
  assert.deepEqual(validaSocial('', undefined), { avd: null, istruzioni: '' })
  for (const avd of ['a b', '--wipe-data;', '../x', 'x'.repeat(200)]) assert.throws(() => validaSocial(avd, ''), /emulator/)
  for (const testo of ['password: abc', 'API_KEY=123', 'token = xyz', 'api key: 9']) assert.throws(() => validaSocial('', testo), /password/)
  assert.doesNotThrow(() => validaSocial('', 'Se serve una password chiedimela'))
  assert.throws(() => validaSocial('', 'x'.repeat(9000)), /too long/)
})

test('la proposta viene dalla repo, e se è rotta non conta', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-mod-'))
  assert.deepEqual(await propostaSocial(repo), { avd: null, istruzioni: '' })
  mkdirSync(join(repo, '.hub'))
  writeFileSync(join(repo, '.hub', 'social.json'), JSON.stringify({ avd: 'Telefono', istruzioni: 'Parti da YouTube' }))
  assert.deepEqual(await propostaSocial(repo), { avd: 'Telefono', istruzioni: 'Parti da YouTube' })
  writeFileSync(join(repo, '.hub', 'social.json'), JSON.stringify({ avd: 'a; b' }))
  assert.deepEqual(await propostaSocial(repo), { avd: null, istruzioni: '' })
  writeFileSync(join(repo, '.hub', 'social.json'), 'non json')
  assert.deepEqual(await propostaSocial(repo), { avd: null, istruzioni: '' })
})

test('i dati vecchi vanno alla prima repo e il file originale resta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-mod-'))
  const vecchio = join(dir, 'social.json')
  const uno = join(dir, 'uno.json')
  const due = join(dir, 'due.json')
  assert.equal(await datiVecchiDisponibili(vecchio, uno), false)
  await importaDatiVecchi(vecchio, uno)
  assert.equal(existsSync(uno), false)
  writeFileSync(vecchio, '{"brand":"1"}')
  assert.equal(await datiVecchiDisponibili(vecchio, uno), true)
  await importaDatiVecchi(vecchio, uno)
  assert.equal(readFileSync(uno, 'utf8'), '{"brand":"1"}')
  assert.equal(readFileSync(vecchio, 'utf8'), '{"brand":"1"}')
  assert.equal(await datiVecchiDisponibili(vecchio, due), false)
  await importaDatiVecchi(vecchio, due)
  assert.equal(existsSync(due), false)
})

test('togliere un modulo non cancella nulla, e le preferenze restano per repo', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hub-mod-')), 'hub.db')
  const db = new Archivio(file)
  assert.deepEqual(db.preferenza('modulo:social', SOCIAL_VUOTO), SOCIAL_VUOTO)
  db.scriviPreferenza('modulo:social', { attivo: true, avd: 'X', istruzioni: 'Y' })
  db.scriviPreferenza('modulo:social', { attivo: false, avd: 'X', istruzioni: 'Y' })
  db.scriviPreferenza('sezione', 'branch')
  db.close()
  const riaperto = new Archivio(file)
  assert.deepEqual(riaperto.preferenza('modulo:social', SOCIAL_VUOTO), { attivo: false, avd: 'X', istruzioni: 'Y' })
  assert.equal(riaperto.preferenza('sezione', 'todo'), 'branch')
  assert.equal(riaperto.preferenza('nessuna', 7), 7)
  riaperto.close()
})

test('due repo insieme: i dati vecchi vanno a una sola, senza sovrascrivere', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-mod-'))
  const vecchio = join(dir, 'social.json')
  writeFileSync(vecchio, '{"brand":"1"}')
  const uno = join(dir, 'uno.json')
  const due = join(dir, 'due.json')
  await Promise.all([importaDatiVecchi(vecchio, uno), importaDatiVecchi(vecchio, due)])
  assert.equal([uno, due].filter((f) => existsSync(f)).length, 1)
  assert.equal(readFileSync(vecchio, 'utf8'), '{"brand":"1"}')
})

test("un'importazione interrotta riprende solo per la stessa repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-mod-'))
  const vecchio = join(dir, 'social.json')
  writeFileSync(vecchio, '{"brand":"1"}')
  const uno = join(dir, 'uno.json')
  const due = join(dir, 'due.json')
  // Come un crash dopo aver preso il segno e prima di copiare.
  writeFileSync(`${vecchio}.importato`, uno)
  assert.equal(await datiVecchiDisponibili(vecchio, due), false)
  await importaDatiVecchi(vecchio, due)
  assert.equal(existsSync(due), false)
  assert.equal(await datiVecchiDisponibili(vecchio, uno), true)
  await importaDatiVecchi(vecchio, uno)
  assert.equal(readFileSync(uno, 'utf8'), '{"brand":"1"}')
})

const pausa = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test("vale solo l'ultima pianificazione, anche se la prima risponde dopo", async () => {
  const p = new Pianificatore()
  const eseguiti: string[] = []
  const prima = p.pianifica(async () => {
    await pausa(40)
    return { repo: 'a', attesa: 5 }
  }, (r) => void eseguiti.push(r))
  await p.pianifica(async () => ({ repo: 'b', attesa: 5 }), (r) => void eseguiti.push(r))
  await prima
  await pausa(60)
  assert.deepEqual(eseguiti, ['b'])
})

test('un timer non parte se nel frattempo il modulo è stato tolto o la repo è cambiata', async () => {
  const eseguiti: string[] = []
  let ora: { repo: string; attesa: number } | null = { repo: 'a', attesa: 10 }
  const p = new Pianificatore()
  await p.pianifica(async () => ora, (r) => void eseguiti.push(r))
  ora = null
  await pausa(40)
  assert.equal(eseguiti.length, 0)
  ora = { repo: 'a', attesa: 10 }
  await p.pianifica(async () => ora, (r) => void eseguiti.push(r))
  ora = { repo: 'b', attesa: 10 }
  await pausa(40)
  assert.equal(eseguiti.length, 0)
  ora = { repo: 'a', attesa: 10 }
  await p.pianifica(async () => ora, (r) => void eseguiti.push(r))
  p.ferma()
  await pausa(40)
  assert.equal(eseguiti.length, 0)
})
