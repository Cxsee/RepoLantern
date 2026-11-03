import { t } from '../../shared/i18n.ts'
import { normalizza } from '../../main/eventi.ts'

export type Question = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; messageId: string | null; text: string; streaming: boolean }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean; interrotto?: boolean; subagente?: SubagenteVisto }
  | {
      kind: 'permission'
      id: string
      toolUseId: string | null
      name: string
      input: Record<string, unknown>
      description: string
      session: boolean
      risposta?: 'allow' | 'deny' | 'annullata'
    }
  | { kind: 'note'; id: string; tone: 'info' | 'error' | 'login'; text: string }
  | { kind: 'raw'; id: string; text: string }

export type SubagenteVisto = { descrizione: string; stato: 'in corso' | 'fatto' | 'errore'; ultimo: string | null; strumenti: string[]; riassunto: string | null }
export type ChatState = { items: ChatItem[]; busy: boolean; sessionId: string | null; messageId: string | null; streamed: Record<number, string> }

export const emptyChat: ChatState = { items: [], busy: false, sessionId: null, messageId: null, streamed: {} }

// Tipi di evento che non servono all'interfaccia. Tutto il resto, se sconosciuto, si mostra grezzo invece di far cadere la chat.
const IGNORED = new Set(['system', 'rate_limit_event', 'control_response', 'stream_event', 'tool_progress', 'keep_alive'])

const nextId = (state: ChatState, prefix: string): string => `${prefix}${state.items.length}`
const note = (state: ChatState, tone: 'info' | 'error' | 'login', text: string) => ({ kind: 'note' as const, id: nextId(state, 'n'), tone, text })

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? String(c.text ?? '') : c?.type ? `[${c.type}]` : '')).join('\n')
}

function closeOpenWork(items: ChatItem[]): ChatItem[] {
  return items.map((i) => {
    if (i.kind === 'tool' && i.result === undefined) return { ...i, interrotto: true }
    if (i.kind === 'permission' && !i.risposta) return { ...i, risposta: 'annullata' as const }
    if (i.kind === 'text' && i.streaming) return { ...i, streaming: false }
    return i
  })
}

function applyStream(state: ChatState, event: any): ChatState {
  const e = event.event
  if (event.parent_tool_use_id) return state
  if (e?.type === 'message_start') return { ...state, messageId: e.message?.id ?? null, streamed: {} }
  if (e?.type === 'content_block_start' && e.content_block?.type === 'text') {
    const id = nextId(state, 't')
    return {
      ...state,
      streamed: { ...state.streamed, [e.index]: id },
      items: [...state.items, { kind: 'text', id, messageId: state.messageId, text: e.content_block.text ?? '', streaming: true }]
    }
  }
  if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
    const id = state.streamed[e.index]
    if (!id) return state
    return { ...state, items: state.items.map((i) => (i.id === id && i.kind === 'text' ? { ...i, text: i.text + e.delta.text } : i)) }
  }
  return state
}

const VUOTO: SubagenteVisto = { descrizione: '', stato: 'in corso', ultimo: null, strumenti: [], riassunto: null }

// Il lavoro di un subagente si attacca allo strumento che lo ha lanciato: non è parte della conversazione principale.
function applySubagente(state: ChatState, event: any): ChatState {
  let next = state
  for (const e of normalizza(event)) {
    const id = e.tipo === 'strumento' ? e.subagente : e.tipo.startsWith('subagente-') ? (e as { id: string }).id : null
    if (!id) continue
    next = {
      ...next,
      items: next.items.map((i) => {
        if (i.kind !== 'tool' || i.id !== id) return i
        const s = i.subagente ?? VUOTO
        if (e.tipo === 'strumento') return { ...i, subagente: { ...s, ultimo: e.nome, strumenti: [...s.strumenti, e.nome] } }
        if (e.tipo === 'subagente-inizio') return { ...i, subagente: { ...s, descrizione: e.descrizione ?? s.descrizione } }
        if (e.tipo === 'subagente-avanzamento') return { ...i, subagente: { ...s, descrizione: s.descrizione || (e.descrizione ?? ''), ultimo: e.ultimoStrumento ?? s.ultimo } }
        if (e.tipo === 'subagente-fine') return { ...i, subagente: { ...s, stato: e.stato === 'completed' ? 'fatto' : 'errore', riassunto: e.riassunto ?? null } }
        return i
      })
    }
  }
  return next
}

function applyAssistant(state: ChatState, event: any): ChatState {
  if (event.parent_tool_use_id) return applySubagente(state, event)
  if (event.isSidechain) return state
  const messageId: string | null = event.message?.id ?? null
  let next = state
  for (const block of event.message?.content ?? []) {
    if (block.type === 'text' && block.text) {
      const open = next.items.find((i) => i.kind === 'text' && i.streaming && i.messageId === messageId)
      next = open
        ? { ...next, items: next.items.map((i) => (i === open ? { ...open, text: block.text, streaming: false } as ChatItem : i)) }
        : { ...next, items: [...next.items, { kind: 'text', id: nextId(next, 't'), messageId, text: block.text, streaming: false }] }
    } else if (block.type === 'thinking' && block.thinking) {
      next = { ...next, items: [...next.items, { kind: 'thinking', id: nextId(next, 'r'), text: block.thinking }] }
    } else if (block.type === 'tool_use' && !next.items.some((i) => i.id === block.id)) {
      next = { ...next, items: [...next.items, { kind: 'tool', id: block.id, name: block.name, input: block.input ?? {} }] }
    }
  }
  return next
}

function applyUser(state: ChatState, event: any, replay: boolean): ChatState {
  if (event.parent_tool_use_id || event.isSidechain || event.isMeta) return state
  const content = event.message?.content
  const blocks: any[] = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
  let next = state
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      const result = resultText(block.content)
      next = { ...next, items: next.items.map((i) => (i.kind === 'tool' && i.id === block.tool_use_id ? { ...i, result, isError: block.is_error === true } : i)) }
    } else if (block.type === 'text') {
      const text = String(block.text ?? '')
      if (text.startsWith('[Request interrupted')) {
        // Il comando fermato arriva prima come risultato con errore: non è un errore vero.
        const lastTool = next.items.findLast((i) => i.kind === 'tool')
        const items = next.items.map((i) => (i === lastTool && i.kind === 'tool' && i.isError ? { ...i, interrotto: true } : i))
        next = { ...next, items: [...closeOpenWork(items), note(next, 'info', t('chat.state.interrupted'))] }
      }
      // Dal vivo il messaggio dell'utente lo aggiunge già l'interfaccia; i testi tra <…> sono comandi interni.
      else if (replay && text.trim() && !text.startsWith('<')) next = { ...next, items: [...next.items, { kind: 'user', id: nextId(next, 'u'), text }] }
    }
  }
  return next
}

function applyResult(state: ChatState, event: any): ChatState {
  const items = closeOpenWork(state.items)
  const base = { ...state, busy: false, items, sessionId: event.session_id ?? state.sessionId }
  const text = String(event.result ?? '')
  if (/not logged in|please run \/login/i.test(text)) return { ...base, items: [...items, note(base, 'login', t('chat.loginOff'))] }
  if (event.is_error && event.subtype !== 'error_during_execution') {
    const detail = text || (Array.isArray(event.errors) ? event.errors.join(' ') : '') || String(event.subtype ?? '')
    return { ...base, items: [...items, note(base, 'error', detail || t('chat.claudeError'))] }
  }
  return base
}

export function applyEvent(state: ChatState, event: any, replay = false): ChatState {
  switch (event?.type) {
    case 'system':
      return event.subtype === 'init' && event.session_id ? { ...state, sessionId: event.session_id } : applySubagente(state, event)
    case 'stream_event':
      return applyStream(state, event)
    case 'assistant':
      return applyAssistant(state, event)
    case 'user':
      return applyUser(state, event, replay)
    case 'result':
      return applyResult(state, event)
    case 'control_request': {
      const r = event.request
      if (r?.subtype !== 'can_use_tool') return state
      const permission: ChatItem = {
        kind: 'permission',
        id: event.request_id,
        toolUseId: typeof r.tool_use_id === 'string' ? r.tool_use_id : null,
        name: String(r.tool_name ?? t('chat.toolDefault')),
        input: r.input ?? {},
        description: String(r.description ?? ''),
        session: Array.isArray(r.permission_suggestions) && r.permission_suggestions.length > 0
      }
      return { ...state, items: [...state.items, permission] }
    }
    case 'control_cancel_request':
      return { ...state, items: state.items.map((i) => (i.kind === 'permission' && i.id === event.request_id && !i.risposta ? { ...i, risposta: 'annullata' as const } : i)) }
    default:
      if (replay || IGNORED.has(event?.type)) return state
      return { ...state, items: [...state.items, { kind: 'raw', id: nextId(state, 'x'), text: JSON.stringify(event) }] }
  }
}

export const addUser = (state: ChatState, text: string): ChatState => ({ ...state, busy: true, items: [...state.items, { kind: 'user', id: nextId(state, 'u'), text }] })

export const answerPermission = (state: ChatState, id: string, risposta: 'allow' | 'deny'): ChatState => ({
  ...state,
  items: state.items.map((i) => (i.kind === 'permission' && i.id === id ? { ...i, risposta } : i))
})

export function processEnded(state: ChatState, error: string | null): ChatState {
  const items = closeOpenWork(state.items)
  return { ...state, busy: false, items: error ? [...items, note(state, /login/i.test(error) ? 'login' : 'error', error)] : items }
}

// Lo stato che lo strumento deve mostrare in base alla risposta data al suo permesso.
export function toolAnswers(state: ChatState): Map<string, 'attesa' | 'negato'> {
  const answers = new Map<string, 'attesa' | 'negato'>()
  for (const i of state.items) {
    if (i.kind !== 'permission' || !i.toolUseId) continue
    if (!i.risposta) answers.set(i.toolUseId, 'attesa')
    if (i.risposta === 'deny') answers.set(i.toolUseId, 'negato')
  }
  return answers
}

export const waitingPermissions = (state: ChatState): number => state.items.filter((i) => i.kind === 'permission' && !i.risposta).length

export type DiffLine = { tipo: 'uguale' | 'tolta' | 'aggiunta'; testo: string }

// ponytail: toglie solo le righe uguali in cima e in fondo, senza confronto riga per riga; basta per le modifiche di Edit.
export function simpleDiff(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  return [
    ...a.slice(0, start).map((testo) => ({ tipo: 'uguale' as const, testo })),
    ...a.slice(start, a.length - end).map((testo) => ({ tipo: 'tolta' as const, testo })),
    ...b.slice(start, b.length - end).map((testo) => ({ tipo: 'aggiunta' as const, testo })),
    ...a.slice(a.length - end).map((testo) => ({ tipo: 'uguale' as const, testo }))
  ]
}
