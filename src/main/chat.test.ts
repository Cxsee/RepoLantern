import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { projectSlug } from './agents.ts'
import { buildPermissionResponse, Chats, claudeArgs, readHistory, readRecent, saveRecent } from './chat.ts'

const pending = { input: { command: 'dir' }, suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' }] }
const id = '41414f9f-baf0-4446-8f8b-c3423e5a09e2'

test('consenti usa il comando originale', () => {
  assert.deepEqual(buildPermissionResponse(pending, { scelta: 'allow' }), { behavior: 'allow', updatedInput: { command: 'dir' } })
})

test('nega non consente nulla', () => {
  assert.deepEqual(buildPermissionResponse(pending, { scelta: 'deny' }), { behavior: 'deny', message: "Negato dall'utente" })
})

test('consenti per la sessione non scrive mai nei file di impostazioni', () => {
  const r = buildPermissionResponse(pending, { scelta: 'allowSession' }) as any
  assert.equal(r.updatedPermissions[0].destination, 'session')
  assert.equal(r.updatedPermissions[0].mode, 'acceptEdits')
})

test('le risposte a una domanda si aggiungono al comando senza cambiarlo', () => {
  const r = buildPermissionResponse({ input: { questions: [1] }, suggestions: [] }, { scelta: 'allow', risposte: { 'Quale?': 'A' } }) as any
  assert.deepEqual(r.updatedInput, { questions: [1], answers: { 'Quale?': 'A' } })
  const bad = buildPermissionResponse({ input: { x: 1 }, suggestions: [] }, { scelta: 'allow', risposte: { a: 1 } as any }) as any
  assert.deepEqual(bad.updatedInput, { x: 1 })
})

test('accetta solo identificativi di sessione validi', () => {
  assert.ok(claudeArgs(id).includes(id))
  assert.ok(!claudeArgs(null).includes('--resume'))
  assert.throws(() => claudeArgs('--dangerously-skip-permissions'))
  assert.ok(claudeArgs(null).includes('default'))
  assert.ok(!claudeArgs(null).includes('--chrome'))
  assert.ok(claudeArgs(null, { chrome: true }).includes('--chrome'))
  const impostazioni = JSON.parse(claudeArgs(null)[claudeArgs(null).indexOf('--settings') + 1])
  assert.ok(impostazioni.permissions.deny.includes('Read(**/.env)'))
  assert.ok(impostazioni.permissions.ask.includes('Bash(git push*)'))
})

test('legge la cronologia saltando le righe rovinate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-'))
  const cwd = 'C:\\repo x'
  mkdirSync(join(dir, 'projects', projectSlug(cwd)), { recursive: true })
  writeFileSync(join(dir, 'projects', projectSlug(cwd), `${id}.jsonl`), '{"type":"user"}\r\n{rotta\n\n{"type":"assistant"}\n')
  assert.deepEqual(await readHistory(dir, cwd, id), [{ type: 'user' }, { type: 'assistant' }])
  await assert.rejects(readHistory(dir, cwd, '../../segreto'))
})

test('le chat recenti tengono il primo titolo e stanno in cima', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hub-')), 'chats.json')
  const item = (sessionId: string, titolo: string) => ({ sessionId, cwd: 'c', titolo, quando: 'q' })
  await saveRecent(file, 'r', item('a', 'prima'))
  await saveRecent(file, 'r', item('b', 'seconda'))
  await saveRecent(file, 'r', item('a', 'nuovo'))
  assert.deepEqual((await readRecent(file, 'r')).map((x) => [x.sessionId, x.titolo]), [['a', 'prima'], ['b', 'seconda']])
  assert.deepEqual(await readRecent(file, 'altra'), [])
})

function chatFinta(): { chats: Chats; eventi: any[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hub-chat-'))
  const finto = join(dir, 'finto.mjs')
  writeFileSync(finto, "import { createInterface } from 'node:readline'\nprocess.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sessione-a' }) + String.fromCharCode(10))\ncreateInterface({ input: process.stdin }).on('line', (l) => process.stdout.write(JSON.stringify({ type: 'eco', pid: process.pid, testo: JSON.parse(l).message.content }) + String.fromCharCode(10)))\n")
  const eventi: any[] = []
  return { chats: new Chats((_t, e) => eventi.push(e), () => {}, async () => ({ exe: process.execPath, args: [finto] })), eventi, dir }
}
const attendi = async (fatto: () => boolean): Promise<void> => {
  const t = Date.now()
  while (!fatto() && Date.now() - t < 8000) await new Promise((r) => setTimeout(r, 20))
}

test('due invii ravvicinati usano un solo processo', async () => {
  const { chats, eventi, dir } = chatFinta()
  await Promise.all([chats.send('t', dir, null, 'uno'), chats.send('t', dir, null, 'due')])
  const eco = (): any[] => eventi.filter((e) => e.type === 'eco')
  await attendi(() => eco().length === 2)
  assert.deepEqual(eco().map((e) => e.testo).sort(), ['due', 'uno'])
  assert.equal(new Set(eco().map((e) => e.pid)).size, 1)
  chats.closeAll()
})

test("una scheda non accetta messaggi per un'altra cartella o un'altra sessione", async () => {
  const { chats, eventi, dir } = chatFinta()
  await chats.send('t', dir, null, 'uno')
  await attendi(() => eventi.some((e) => e.type === 'eco'))
  await assert.rejects(chats.send('t', mkdtempSync(join(tmpdir(), 'hub-altra-')), null, 'due'), /different folder/)
  await assert.rejects(chats.send('t', dir, '41414f9f-baf0-4446-8f8b-c3423e5a09e2', 'tre'), /different session/)
  await chats.send('t', dir.toUpperCase(), 'sessione-a', 'quattro')
  await attendi(() => eventi.filter((e) => e.type === 'eco').length === 2)
  assert.deepEqual(eventi.filter((e) => e.type === 'eco').map((e) => e.testo), ['uno', 'quattro'])
  chats.closeAll()
})

test('una scheda chiusa mentre Claude parte non lo avvia, e dopo si può riaprire', async () => {
  const { dir } = chatFinta()
  const finto = join(dir, 'finto.mjs')
  const eventi: any[] = []
  let lascia: () => void = () => {}
  let richieste = 0
  const chats = new Chats((_t, e) => eventi.push(e), () => {}, async () => {
    richieste++
    if (richieste === 1) await new Promise<void>((ok) => { lascia = ok })
    return { exe: process.execPath, args: [finto] }
  })
  const invio = chats.send('t', dir, null, 'uno')
  await attendi(() => richieste === 1)
  chats.close('t')
  lascia()
  await assert.rejects(invio, /closed/)
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(eventi.length, 0)

  await chats.send('t', dir, null, 'due')
  await attendi(() => eventi.some((e) => e.type === 'eco'))
  assert.equal(eventi.find((e) => e.type === 'eco').testo, 'due')
  chats.closeAll()
})
