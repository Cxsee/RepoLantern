import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { frameworkDi, kindOf, leggiAlbero, leggiTesto, leggiVociCodice, linguaggioDi, parseVociCodice, titoloDi } from './scansione.ts'

function repo(): { dir: string; git: (...a: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'hub-scan-'))
  const git = (...a: string[]): string => execFileSync('git', ['-c', 'user.name=Prova', '-c', 'user.email=p@p', '-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  git('init', '-q', '-b', 'master')
  return { dir, git }
}

test('il tipo di progetto si deduce senza supporre mobile', () => {
  assert.equal(kindOf(['app/pubspec.yaml', 'x.dart'], ''), 'mobile')
  assert.equal(kindOf(['package.json'], '{"dependencies":{"expo":"1"}}'), 'mobile')
  assert.equal(kindOf(['package.json'], '{"devDependencies":{"electron":"1","vite":"1"}}'), 'desktop')
  assert.equal(kindOf(['package.json'], '{"dependencies":{"next":"1"}}'), 'web')
  assert.equal(kindOf(['main.py'], ''), 'altro')
})

test('framework e linguaggi vengono dai file noti', () => {
  assert.deepEqual(frameworkDi(['app/pubspec.yaml', 'supabase/config.toml'], ''), ['Flutter', 'Supabase'])
  assert.deepEqual(frameworkDi(['package.json', 'backend/requirements.txt'], '{"dependencies":{"react":"1","react-dom":"1"}}\nfastapi==1.0\n'), ['FastAPI', 'React'])
  assert.deepEqual(frameworkDi(['package.json'], '{"name":"reactor","dependencies":{"preact":"1"}}'), [])
  assert.equal(linguaggioDi('a/b.DART'), 'Dart')
  assert.equal(linguaggioDi('LICENSE'), null)
})

test('il titolo di un documento salta i blocchi di codice', () => {
  assert.equal(titoloDi('testo\n```\n# non questo\n```\n# Il titolo #\n## Altro'), 'Il titolo')
  assert.equal(titoloDi('nessuno'), null)
})

test('le voci del codice si leggono e le righe enormi si scartano', () => {
  const lunga = 'x'.repeat(600)
  assert.deepEqual(parseVociCodice(`a.ts\x002:// TODO fare\r\nb.ts\x007\x00  FIXME dopo\nc.js\x001:${lunga}\n`), [{ file: 'a.ts', riga: 2, testo: '// TODO fare' }, { file: 'b.ts', riga: 7, testo: 'FIXME dopo' }])
})

test('git grep dà le voci, e nessuna voce non è un errore', async () => {
  const { dir, git } = repo()
  assert.deepEqual(await leggiVociCodice(dir), [])
  writeFileSync(join(dir, 'a.ts'), 'uno\n// TODO fare\n')
  writeFileSync(join(dir, 'nota.md'), 'TODO nei documenti no\n')
  writeFileSync(join(dir, 'nuovo.ts'), '// FIXME anche non tracciato\n')
  git('add', 'a.ts', 'nota.md')
  assert.deepEqual((await leggiVociCodice(dir)).map((v) => [v.file, v.riga]).sort(), [['a.ts', 2], ['nuovo.ts', 1]])
})

test("l'albero distingue file puliti, modificati, nuovi e cancellati", async () => {
  const { dir, git } = repo()
  writeFileSync(join(dir, 'a.txt'), 'a')
  writeFileSync(join(dir, 'b.txt'), 'b')
  writeFileSync(join(dir, 'via.txt'), 'c')
  writeFileSync(join(dir, '.gitignore'), 'ignorato.txt\n')
  git('add', '.')
  git('commit', '-qm', 'primo')
  const prima = await leggiAlbero(dir)
  assert.deepEqual([...prima.keys()].sort(), ['.gitignore', 'a.txt', 'b.txt', 'via.txt'])
  writeFileSync(join(dir, 'a.txt'), 'cambiato')
  writeFileSync(join(dir, 'nuovo.txt'), 'n')
  writeFileSync(join(dir, 'ignorato.txt'), 'i')
  rmSync(join(dir, 'via.txt'))
  const dopo = await leggiAlbero(dir)
  assert.deepEqual([...dopo.keys()].sort(), ['.gitignore', 'a.txt', 'b.txt', 'nuovo.txt'])
  assert.equal(dopo.get('b.txt'), prima.get('b.txt'))
  assert.notEqual(dopo.get('a.txt'), prima.get('a.txt'))
})

test('un documento che è un collegamento non viene seguito', async () => {
  const { dir } = repo()
  const fuori = mkdtempSync(join(tmpdir(), 'hub-fuori-'))
  writeFileSync(join(fuori, 'f.md'), '# Fuori')
  symlinkSync(fuori, join(dir, 'ponte'), 'junction')
  writeFileSync(join(dir, 'd.md'), '# Dentro')
  assert.equal(await leggiTesto(dir, 'd.md'), '# Dentro')
  assert.equal(await leggiTesto(dir, 'nessuno.md'), null)
  assert.equal(await leggiTesto(dir, 'ponte/f.md'), null)
  assert.deepEqual([...(await leggiAlbero(dir)).keys()], ['d.md'])
})
