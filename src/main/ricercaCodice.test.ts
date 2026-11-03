import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { branoFile, cercaNelCodice, leggiPerParole, leggiRisultati, radice } from './ricercaCodice.ts'

function repo(file: Record<string, string>): string {
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'hub-cerca-')))
  execFileSync('git', ['init', '-q'], { cwd: r })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: r })
  for (const [f, t] of Object.entries(file)) {
    mkdirSync(join(r, f, '..'), { recursive: true })
    writeFileSync(join(r, f), t)
  }
  return r
}

test('trova il testo dentro i file, modifiche e file nuovi compresi, con definizioni prima', async () => {
  const r = repo({
    'lib/chiama.dart': 'void f() {\n  EvaluateBadges();\n}\n',
    'lib/badge.dart': 'Future<void> evaluateBadges() async {\n}\n',
    'db/a.sql': 'create or replace function evaluateBadges() returns int as $$\n',
    'test/badge_test.dart': 'evaluateBadges();\n',
    'docs/nota.md': 'Vedi evaluateBadges nel server.\n',
    '.gitignore': 'ignorato.txt\n',
    'ignorato.txt': 'evaluateBadges\n',
    '.env': 'evaluateBadges=segreto\n',
    'pacco.lock': 'evaluateBadges\n',
    'img.bin': 'evaluateBadges\0binario'
  })
  execFileSync('git', ['add', 'lib/badge.dart'], { cwd: r })
  const { voci, altri } = await cercaNelCodice(r, 'evaluatebadges')
  assert.equal(altri, 0)
  assert.deepEqual(voci.filter((v) => !v.nonTracciato).map((v) => v.file), ['lib/badge.dart'])
  assert.deepEqual(voci.map((v) => [v.file, v.riga, v.tipo]), [
    ['db/a.sql', 1, 'definizione'],
    ['lib/badge.dart', 1, 'definizione'],
    ['lib/chiama.dart', 2, 'codice'],
    ['test/badge_test.dart', 1, 'test'],
    ['docs/nota.md', 1, 'documento']
  ])
})

test('una ricerca senza risultati, troppo corta o con caratteri speciali non è un errore', async () => {
  const r = repo({ 'a.ts': 'const x = "a.*b -e $(rm)"\n' })
  assert.deepEqual(await cercaNelCodice(r, 'nontrovato'), { voci: [], altri: 0 })
  assert.deepEqual(await cercaNelCodice(r, 'a'), { voci: [], altri: 0 })
  assert.equal((await cercaNelCodice(r, 'a.*b')).voci.length, 1)
  assert.equal((await cercaNelCodice(r, '-e $(rm)')).voci.length, 1)
  assert.equal((await cercaNelCodice(r, '--version')).voci.length, 0)
})

test('i risultati si limitano e dicono quanti ne restano, una riga enorme si accorcia', () => {
  const tanti = Array.from({ length: 90 }, (_, i) => `a.ts\0${i + 1}\0usa x`).join('\n')
  const { voci, altri } = leggiRisultati(tanti, 'x')
  assert.deepEqual([voci.length, altri], [80, 10])
  const lunga = leggiRisultati(`b.js\x001\0${'y'.repeat(5000)}cercato${'z'.repeat(5000)}`, 'cercato').voci[0]
  assert.ok(lunga.testo.length < 260)
  assert.match(lunga.testo, /cercato/)
  assert.deepEqual(leggiRisultati('.env\x001\0x\nchiavi/a.pem\x002\0y', 'x').voci, [])
})

test('il brano mostra il file attorno alla riga, mai fuori dalla repo né un segreto', async () => {
  const r = repo({ 'a.ts': Array.from({ length: 1000 }, (_, i) => `riga ${i + 1}`).join('\r\n'), '.env': 'CHIAVE=1\n', 'b.bin': 'a\0b' })
  const b = await branoFile(r, 'a.ts', 600)
  assert.deepEqual([b?.inizio, b?.righe[0], b?.totale, b?.righe.length], [350, 'riga 350', 1000, 501])
  assert.equal((await branoFile(r, 'a.ts', 'x'))?.inizio, 1)
  assert.equal(await branoFile(r, '.env', 1), null)
  assert.equal(await branoFile(r, 'b.bin', 1), null)
  assert.equal(await branoFile(r, '../fuori.txt', 1), null)
  assert.equal(await branoFile(r, join(r, 'a.ts'), 1), null)
  assert.equal(await branoFile(r, 3, 1), null)
  assert.equal(await branoFile(r, 'manca.ts', 1), null)
})

test('un collegamento verso un segreto o fuori dalla repo non si apre', async (t) => {
  const r = repo({ '.env': 'CHIAVE=1\n' })
  const fuori = realpathSync(mkdtempSync(join(tmpdir(), 'hub-fuori-')))
  writeFileSync(join(fuori, 'x.txt'), 'fuori')
  try {
    symlinkSync(join(r, '.env'), join(r, 'innocuo.txt'))
    symlinkSync(join(fuori, 'x.txt'), join(r, 'via.txt'))
  } catch {
    return t.skip('Questo Windows non permette di creare collegamenti.')
  }
  assert.equal(await branoFile(r, 'innocuo.txt', 1), null)
  assert.equal(await branoFile(r, 'via.txt', 1), null)
})

test('una definizione dentro un test o una traduzione non passa davanti a quella vera', () => {
  const f = 'tests/a.ts\x001\0function x() {\nsrc/locales/it.ts\x001\0const x = 1\nsrc/a.ts\x001\0function x() {'
  assert.deepEqual(leggiRisultati(f, 'x').voci.map((v) => [v.file, v.tipo]), [['src/a.ts', 'definizione'], ['tests/a.ts', 'test'], ['src/locales/it.ts', 'documento']])
})

test('fra le migrazioni la definizione più recente viene prima', () => {
  const f = 'db/migrations/1_a.sql\x001\0create function x()\nlib/a.ts\x001\0function x() {\ndb/migrations/2_b.sql\x001\0create or replace function x()'
  assert.deepEqual(leggiRisultati(f, 'x').voci.map((v) => v.file), ['db/migrations/2_b.sql', 'db/migrations/1_a.sql', 'lib/a.ts'])
})

test('commenti, dati, automazioni e migrazioni vengono dopo il codice vero, ma prima dei test', () => {
  const f = ['db/migrations/1_a.sql\x001\0select login', 'tests/a.ts\x001\0login()', '.github/workflows/c.yml\x001\0login', 'api/swagger.json\x001\0login', 'src/b.ts\x001\0// login', 'src/a.ts\x001\0login()'].join('\n')
  const v = leggiRisultati(f, 'login').voci.map((x) => x.file)
  assert.equal(v[0], 'src/a.ts')
  assert.equal(v.at(-1), 'tests/a.ts')
})

test('per parole: tengono i file con tutte le parole, anche solo nel percorso', () => {
  const f = ['src/import_csv.rb\x003\0import transactions', 'src/import_csv.rb\x004\0transactions', 'src/import_csv.rb\x005\0transactions', 'src/altro.rb\x001\0import'].join('\n')
  const r = leggiPerParole(f, ['import', 'transactions', 'csv'])
  assert.deepEqual(r.voci.map((v) => [v.file, v.riga]), [['src/import_csv.rb', 3], ['src/import_csv.rb', 4]])
  assert.deepEqual(r.parole, ['import', 'transactions', 'csv'])
})

test('per parole: radici, inizio parola, nomi composti e definizioni di una sola parola', () => {
  assert.deepEqual(['creation', 'delivery', 'transactions', 'face', 'login'].map(radice), ['creat', 'deliver', 'transact', 'face', 'login'])
  const f = ['features/handleNewBooking/a.ts\x001\0const x = createThing()', 'src/pg.ts\x001\0compost status', 'src/app.py\x005\0    def route(self, rule):', 'CHANGES.rst\x001\0the route and decorator', 'src/nulla.ts\x001\0route'].join('\n')
  assert.deepEqual(leggiPerParole(f, ['booking', 'creation']).voci.map((v) => v.file), ['features/handleNewBooking/a.ts'])
  assert.deepEqual(leggiPerParole(f, ['post', 'status']).voci, [])
  const v = leggiPerParole(f, ['route', 'decorator']).voci
  assert.deepEqual(v.map((x) => [x.file, x.tipo]), [['src/app.py', 'definizione'], ['CHANGES.rst', 'documento']])
})
