import assert from 'node:assert/strict'
import test from 'node:test'
import { addUser, answerPermission, applyEvent, emptyChat, processEnded, simpleDiff, toolAnswers, waitingPermissions, type ChatState } from './chatState.ts'

const play = (events: object[], state: ChatState = emptyChat, replay = false): ChatState => events.reduce<ChatState>((s, e) => applyEvent(s, e, replay), state)
const stream = (event: object, parent: string | null = null): object => ({ type: 'stream_event', event, parent_tool_use_id: parent })

test('il testo a flusso si compone e il messaggio finale lo sostituisce senza doppioni', () => {
  const s = play([
    stream({ type: 'message_start', message: { id: 'm1' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Cia' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'o' } })
  ])
  assert.deepEqual(s.items.map((i) => (i.kind === 'text' ? [i.text, i.streaming] : null)), [['Ciao', true]])
  const end = applyEvent(s, { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Ciao!' }] } })
  assert.deepEqual(end.items.map((i) => (i.kind === 'text' ? [i.text, i.streaming] : null)), [['Ciao!', false]])
})

test('collega il risultato allo strumento giusto', () => {
  const s = play([
    { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'x' } }] } },
    { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'y' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'errore' }], is_error: true }] } }
  ])
  const [a, b] = s.items
  assert.ok(a.kind === 'tool' && a.result === undefined)
  assert.ok(b.kind === 'tool' && b.result === 'errore' && b.isError === true)
})

test('il lavoro dei subagenti non finisce nella conversazione principale', () => {
  const s = play([
    { type: 'assistant', parent_tool_use_id: 'task', message: { id: 'm', content: [{ type: 'text', text: 'interno' }] } },
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'interno' } }, 'task')
  ])
  assert.equal(s.items.length, 0)
})

test('gestisce richiesta, risposta e annullamento dei permessi', () => {
  const request = (id: string): object => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Edit', input: {}, description: 'x', permission_suggestions: [{}] } })
  let s = play([request('p1'), request('p2')])
  assert.equal(waitingPermissions(s), 2)
  s = answerPermission(s, 'p1', 'allow')
  s = applyEvent(s, { type: 'control_cancel_request', request_id: 'p2' })
  assert.equal(waitingPermissions(s), 0)
  assert.deepEqual(s.items.map((i) => (i.kind === 'permission' ? i.risposta : null)), ['allow', 'annullata'])
})

test('lo strumento sa se aspetta il permesso o se è stato negato', () => {
  const request = (id: string, tool: string): object => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Edit', input: {}, tool_use_id: tool } })
  let s = play([request('p1', 't1'), request('p2', 't2'), request('p3', 't3')])
  s = answerPermission(answerPermission(s, 'p2', 'deny'), 'p3', 'allow')
  assert.deepEqual([...toolAnswers(s)], [['t1', 'attesa'], ['t2', 'negato']])
})

test('interruzione: strumenti chiusi, nessun errore in più e chat di nuovo libera', () => {
  let s = addUser(emptyChat, 'vai')
  s = play([
    { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
    { type: 'result', subtype: 'error_during_execution', is_error: true, result: '' }
  ], s)
  assert.equal(s.busy, false)
  assert.deepEqual(s.items.map((i) => i.kind), ['user', 'tool', 'note'])
  assert.ok(s.items[1].kind === 'tool' && s.items[1].interrotto === true)
  assert.ok(s.items[2].kind === 'note' && s.items[2].tone === 'info')
})

test('un comando fermato che risulta in errore si mostra come interrotto', () => {
  const s = play([
    { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Exit code 1', is_error: true }] } },
    { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }
  ])
  assert.ok(s.items[0].kind === 'tool' && s.items[0].interrotto === true)
})

test('riconosce login scaduto ed errori veri', () => {
  const login = applyEvent(emptyChat, { type: 'result', subtype: 'success', result: 'Not logged in · Please run /login' })
  assert.ok(login.items[0].kind === 'note' && login.items[0].tone === 'login')
  const error = applyEvent(emptyChat, { type: 'result', subtype: 'error_max_turns', is_error: true })
  assert.ok(error.items[0].kind === 'note' && error.items[0].tone === 'error' && error.items[0].text === 'error_max_turns')
})

test('un evento sconosciuto si mostra grezzo dal vivo e non nella cronologia', () => {
  const event = { type: 'novita', x: 1 }
  assert.equal(applyEvent(emptyChat, event).items[0].kind, 'raw')
  assert.equal(applyEvent(emptyChat, event, true).items.length, 0)
  assert.equal(applyEvent(emptyChat, { type: 'rate_limit_event' }).items.length, 0)
})

test('la cronologia mostra i messaggi utente ma non quelli interni', () => {
  const s = play([
    { type: 'user', message: { content: 'domanda vera' } },
    { type: 'user', isMeta: true, message: { content: 'nascosto' } },
    { type: 'user', message: { content: '<command-name>/x</command-name>' } },
    { type: 'user', isSidechain: true, message: { content: 'subagente' } },
    { type: 'summary', summary: 'x' }
  ], emptyChat, true)
  assert.deepEqual(s.items.map((i) => (i.kind === 'user' ? i.text : i.kind)), ['domanda vera'])
})

test('la fine del programma libera la chat e segnala il motivo', () => {
  let s = addUser(emptyChat, 'vai')
  s = processEnded(s, 'Claude Code si è chiuso')
  assert.equal(s.busy, false)
  assert.ok(s.items[1].kind === 'note' && s.items[1].tone === 'error')
  assert.equal(processEnded(addUser(emptyChat, 'x'), null).items.length, 1)
})

test('il confronto mostra solo ciò che cambia', () => {
  assert.deepEqual(simpleDiff('a\nb\nc', 'a\nX\nc'), [
    { tipo: 'uguale', testo: 'a' },
    { tipo: 'tolta', testo: 'b' },
    { tipo: 'aggiunta', testo: 'X' },
    { tipo: 'uguale', testo: 'c' }
  ])
  assert.deepEqual(simpleDiff('a', 'a\nb').map((l) => l.tipo), ['uguale', 'aggiunta'])
  assert.deepEqual(simpleDiff('a\na', 'a').map((l) => l.tipo), ['uguale', 'tolta'])
})

test('si vede chi fa cosa: il subagente resta attaccato al suo strumento', () => {
  const fine = [
    { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'u1', name: 'Agent', input: { description: 'x' } }, { type: 'tool_use', id: 'u2', name: 'Agent', input: { description: 'y' } }] } },
    { type: 'system', subtype: 'task_started', tool_use_id: 'u1', description: 'Elenca i file' },
    { type: 'system', subtype: 'task_started', tool_use_id: 'u2', description: 'Legge a.txt' },
    { type: 'assistant', parent_tool_use_id: 'u1', message: { id: 'n', content: [{ type: 'text', text: 'interno' }, { type: 'tool_use', id: 't1', name: 'Glob', input: {} }] } },
    { type: 'system', subtype: 'task_progress', tool_use_id: 'u2', last_tool_name: 'Read' },
    { type: 'system', subtype: 'task_notification', tool_use_id: 'u1', status: 'completed', summary: 'Trovati 2 file' },
    { type: 'system', subtype: 'task_notification', tool_use_id: 'u2', status: 'failed' }
  ].reduce((s, e) => applyEvent(s, e), emptyChat)
  const [uno, due] = fine.items as any[]
  assert.equal(fine.items.length, 2)
  assert.deepEqual(uno.subagente, { descrizione: 'Elenca i file', stato: 'fatto', ultimo: 'Glob', strumenti: ['Glob'], riassunto: 'Trovati 2 file' })
  assert.deepEqual([due.subagente.descrizione, due.subagente.stato, due.subagente.ultimo], ['Legge a.txt', 'errore', 'Read'])
})

test('un evento di un subagente senza il suo strumento non fa danni', () => {
  const s = applyEvent(emptyChat, { type: 'system', subtype: 'task_progress', tool_use_id: 'perso', last_tool_name: 'Read' })
  assert.deepEqual(s.items, [])
})
