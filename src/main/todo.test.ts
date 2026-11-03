import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { addTodo, parseMarkdownTodos, readTodos, removeTodo, restoreTodo, safeDocPath, scanDocs, todoPath, updateTodo } from './todo.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hub-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

test('aggiunge, spunta, elimina e ripristina una voce al suo posto', async () => {
  const r = repo()
  await addTodo(r, 'uno')
  const [uno, due] = await addTodo(r, 'due')
  await updateTodo(r, uno.id, { fatta: true })
  assert.equal((await readTodos(r))[0].fatta, true)
  await removeTodo(r, uno.id)
  await restoreTodo(r, uno, 0)
  assert.deepEqual((await readTodos(r)).map((t) => t.id), [uno.id, due.id])
})

test('due salvataggi insieme non perdono voci', async () => {
  const r = repo()
  await Promise.all([addTodo(r, 'a'), addTodo(r, 'b'), addTodo(r, 'c')])
  assert.equal((await readTodos(r)).length, 3)
})

test('un file rovinato dà errore e non viene sovrascritto', async () => {
  const r = repo()
  mkdirSync(join(r, '.hub'))
  writeFileSync(todoPath(r), '{rotto')
  await assert.rejects(addTodo(r, 'x'))
  assert.equal(readFileSync(todoPath(r), 'utf8'), '{rotto')
})

test('.hub resta fuori da git', async () => {
  const r = repo()
  await addTodo(r, 'x')
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: r, encoding: 'utf8' }), '')
  await addTodo(r, 'y')
  const exclude = readFileSync(join(r, '.git', 'info', 'exclude'), 'utf8')
  assert.equal(exclude.split('\n').filter((l) => l === '.hub/').length, 1)
})

test('legge le voci aperte dei .md e ignora chiuse e blocchi di codice', () => {
  const md = '- [ ] aperta\r\n- [x] chiusa\n```\n- [ ] nel codice\n```\n  * [ ] annidata\ntesto [ ] normale'
  assert.deepEqual(parseMarkdownTodos('a.md', md), [
    { file: 'a.md', riga: 1, testo: 'aperta' },
    { file: 'a.md', riga: 6, testo: 'annidata' }
  ])
})

test('la scansione rispetta .gitignore', async () => {
  const r = repo()
  writeFileSync(join(r, '.gitignore'), 'ignorata/\n')
  mkdirSync(join(r, 'ignorata'))
  mkdirSync(join(r, 'docs'))
  writeFileSync(join(r, 'ignorata', 'x.md'), '- [ ] no\n')
  writeFileSync(join(r, 'docs', 'y.md'), '- [ ] si\n')
  assert.deepEqual(await scanDocs(r), [{ file: 'docs/y.md', riga: 1, testo: 'si' }])
})

test('apre solo file .md dentro la repo', () => {
  const r = repo()
  assert.ok(safeDocPath(r, 'docs/a.md'))
  assert.equal(safeDocPath(r, '../fuori.md'), null)
  assert.equal(safeDocPath(r, 'virus.exe'), null)
  assert.equal(safeDocPath(r, 'C:\\Windows\\a.md'), null)
})

test('una voce dei documenti dice in che sezione sta, senza asterischi', () => {
  assert.deepEqual(parseMarkdownTodos('a.md', '- [ ] prima\n## Da fare\n- [ ] **Emoji**: gioco\n```\n# non titolo\n```\n- [x] fatta\n## Altro\n- [ ] dopo'), [
    { file: 'a.md', riga: 1, testo: 'prima' },
    { file: 'a.md', riga: 3, testo: 'Emoji: gioco', sezione: 'Da fare' },
    { file: 'a.md', riga: 9, testo: 'dopo', sezione: 'Altro' }
  ])
})
