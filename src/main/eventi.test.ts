import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizza } from './eventi.ts'

test('un subagente si segue dall\'inizio alla fine', () => {
  assert.deepEqual(normalizza({ type: 'system', subtype: 'task_started', tool_use_id: 'u1', task_id: 'a1', description: 'Elenca i file', subagent_type: 'general-purpose' }), [{ tipo: 'subagente-inizio', id: 'u1', compito: 'a1', descrizione: 'Elenca i file', tipoAgente: 'general-purpose', ultimoStrumento: undefined, riassunto: undefined, consumo: undefined }])
  assert.equal((normalizza({ type: 'system', subtype: 'task_progress', tool_use_id: 'u1', last_tool_name: 'Glob' })[0] as any).ultimoStrumento, 'Glob')
  const fine = normalizza({ type: 'system', subtype: 'task_notification', tool_use_id: 'u1', status: 'completed', summary: 'Fatto' })[0] as any
  assert.deepEqual([fine.tipo, fine.stato, fine.riassunto], ['subagente-fine', 'completed', 'Fatto'])
  assert.deepEqual(normalizza({ type: 'system', subtype: 'task_started', task_id: 'senza-strumento' }), [])
})

test('gli strumenti dicono di chi sono e quali file toccano', () => {
  const eventi = normalizza({ type: 'assistant', parent_tool_use_id: 'u1', message: { content: [{ type: 'text', text: 'Leggo' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }, { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'b.txt' } }, { type: 'tool_use', id: 't3', name: 'Grep', input: { path: 'c' } }] } })
  assert.deepEqual(eventi.map((e) => e.tipo), ['testo', 'strumento', 'file', 'strumento', 'file', 'strumento'])
  assert.deepEqual(eventi.filter((e) => e.tipo === 'file'), [{ tipo: 'file', percorso: 'a.txt', azione: 'letto', subagente: 'u1' }, { tipo: 'file', percorso: 'b.txt', azione: 'scritto', subagente: 'u1' }])
  assert.deepEqual(normalizza({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } }), [{ tipo: 'esito-strumento', id: 't1', errore: true, subagente: null }])
})

test('fine, permesso, limite e avvio', () => {
  assert.deepEqual(normalizza({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.1, num_turns: 3, usage: { input_tokens: 5, output_tokens: 7 } }), [{ tipo: 'fine', errore: false, esito: 'success', testo: 'ok', costo: 0.1, turni: 3, tokenEntrata: 5, tokenUscita: 7 }])
  assert.deepEqual(normalizza({ type: 'result' }), [{ tipo: 'fine', errore: false, esito: '', testo: '', costo: null, turni: null, tokenEntrata: null, tokenUscita: null }])
  assert.deepEqual(normalizza({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'dir' } } }), [{ tipo: 'permesso', id: 'r', nome: 'Bash', input: { command: 'dir' } }])
  assert.deepEqual(normalizza({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', resetsAt: 9 } }), [{ tipo: 'limite', stato: 'allowed', tipoLimite: 'seven_day', scadenza: 9 }])
  assert.deepEqual(normalizza({ type: 'system', subtype: 'init', session_id: 's', model: 'm' }), [{ tipo: 'avvio', sessione: 's', modello: 'm' }])
})

test('un evento sconosciuto o rotto non fa cadere nulla', () => {
  for (const e of [null, undefined, 3, {}, { type: 'nuovo' }, { type: 'assistant' }, { type: 'system' }, { type: 'control_request' }]) assert.deepEqual(normalizza(e), [])
})
