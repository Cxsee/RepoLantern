// Il solo punto che conosce il formato degli eventi della CLI di Claude Code per chi non ha bisogno del testo in streaming.
export type Subagente = { compito?: string; descrizione?: string; tipoAgente?: string; ultimoStrumento?: string; riassunto?: string; consumo?: unknown }

export type EventoMotore =
  | { tipo: 'avvio'; sessione: string | null; modello: string | null }
  | { tipo: 'testo'; testo: string; subagente: string | null }
  | { tipo: 'strumento'; id: string; nome: string; input: Record<string, unknown>; subagente: string | null }
  | { tipo: 'esito-strumento'; id: string; errore: boolean; subagente: string | null }
  | { tipo: 'file'; percorso: string; azione: 'letto' | 'scritto'; subagente: string | null }
  | { tipo: 'permesso'; id: string; nome: string; input: Record<string, unknown> }
  | ({ tipo: 'subagente-inizio'; id: string } & Subagente)
  | ({ tipo: 'subagente-avanzamento'; id: string } & Subagente)
  | ({ tipo: 'subagente-fine'; id: string; stato: string } & Subagente)
  | { tipo: 'limite'; stato: string; tipoLimite: string | null; scadenza: number | null }
  | { tipo: 'fine'; errore: boolean; esito: string; testo: string; costo: number | null; turni: number | null; tokenEntrata: number | null; tokenUscita: number | null }

const LEGGE = new Set(['Read', 'NotebookRead'])
const SCRIVE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const numero = (v: unknown): number | null => (typeof v === 'number' ? v : null)

function dalMessaggio(e: any): EventoMotore[] {
  const subagente: string | null = e.parent_tool_use_id ?? null
  const eventi: EventoMotore[] = []
  for (const b of e.message?.content ?? []) {
    if (b?.type === 'text' && b.text) eventi.push({ tipo: 'testo', testo: String(b.text), subagente })
    if (b?.type === 'tool_result') eventi.push({ tipo: 'esito-strumento', id: String(b.tool_use_id), errore: b.is_error === true, subagente })
    if (b?.type !== 'tool_use') continue
    const input = b.input ?? {}
    eventi.push({ tipo: 'strumento', id: String(b.id), nome: String(b.name), input, subagente })
    const percorso = input.file_path ?? input.notebook_path
    if (typeof percorso === 'string' && (LEGGE.has(b.name) || SCRIVE.has(b.name))) eventi.push({ tipo: 'file', percorso, azione: SCRIVE.has(b.name) ? 'scritto' : 'letto', subagente })
  }
  return eventi
}

function dalSistema(e: any): EventoMotore[] {
  if (e.subtype === 'init') return [{ tipo: 'avvio', sessione: e.session_id ?? null, modello: e.model ?? null }]
  // Un compito che non è di un subagente non ha uno strumento a cui attaccarsi.
  if (!e.tool_use_id) return []
  const dati: Subagente = { compito: e.task_id, descrizione: e.description, tipoAgente: e.subagent_type, ultimoStrumento: e.last_tool_name, riassunto: e.summary, consumo: e.usage }
  if (e.subtype === 'task_started') return [{ tipo: 'subagente-inizio', id: e.tool_use_id, ...dati }]
  if (e.subtype === 'task_progress') return [{ tipo: 'subagente-avanzamento', id: e.tool_use_id, ...dati }]
  if (e.subtype === 'task_notification') return [{ tipo: 'subagente-fine', id: e.tool_use_id, stato: String(e.status ?? 'sconosciuto'), ...dati }]
  return []
}

// Un evento sconosciuto non è un errore: la CLI ne aggiunge di nuovi a ogni versione.
export function normalizza(e: any): EventoMotore[] {
  switch (e?.type) {
    case 'system':
      return dalSistema(e)
    case 'assistant':
    case 'user':
      return dalMessaggio(e)
    case 'control_request':
      return e.request?.subtype === 'can_use_tool' ? [{ tipo: 'permesso', id: String(e.request_id), nome: String(e.request.tool_name), input: e.request.input ?? {} }] : []
    case 'rate_limit_event': {
      const i = e.rate_limit_info ?? {}
      return [{ tipo: 'limite', stato: String(i.status ?? 'sconosciuto'), tipoLimite: i.rateLimitType ?? null, scadenza: numero(i.resetsAt) }]
    }
    case 'result':
      return [{ tipo: 'fine', errore: e.is_error === true, esito: String(e.subtype ?? ''), testo: String(e.result ?? ''), costo: numero(e.total_cost_usd), turni: numero(e.num_turns), tokenEntrata: numero(e.usage?.input_tokens), tokenUscita: numero(e.usage?.output_tokens) }]
    default:
      return []
  }
}
