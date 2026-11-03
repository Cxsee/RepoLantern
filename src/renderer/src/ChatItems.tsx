import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { locale, t } from '../../shared/i18n.ts'
import { simpleDiff, type ChatItem, type Question, type SubagenteVisto } from './chatState'
import type { Decision } from './hub'

const MAX_OUTPUT = 20_000

const LABELS: Record<string, string> = {
  get Read() { return t('chat.tool.read') },
  get Edit() { return t('chat.tool.edit') },
  get MultiEdit() { return t('chat.tool.edit') },
  get Write() { return t('chat.tool.write') },
  get NotebookEdit() { return t('chat.tool.notebook') },
  get Bash() { return t('chat.tool.run') },
  get PowerShell() { return t('chat.tool.run') },
  get Grep() { return t('chat.tool.grep') },
  get Glob() { return t('chat.tool.glob') },
  get Task() { return t('chat.tool.agent') },
  get Agent() { return t('chat.tool.agent') },
  get WebFetch() { return t('chat.tool.fetch') },
  get WebSearch() { return t('chat.tool.search') },
  get TodoWrite() { return t('chat.tool.todo') },
  get Skill() { return t('chat.tool.skill') }
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

function shortPath(path: string, cwd: string): string {
  const [p, c] = [path.replaceAll('\\', '/'), cwd.replaceAll('\\', '/')]
  return p.toLowerCase().startsWith(c.toLowerCase() + '/') ? p.slice(c.length + 1) : p
}

function summary(name: string, input: Record<string, unknown>, cwd: string): string {
  const file = text(input.file_path) || text(input.notebook_path)
  if (file) return shortPath(file, cwd)
  const value = text(input.command) || text(input.description) || text(input.pattern) || text(input.query) || text(input.url) || text(input.skill)
  return value.split(/\r?\n/)[0] || name
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="diff">
      {simpleDiff(before, after).map((l, i) => (
        <span key={i} className={`diff-${l.tipo}`}>
          {l.tipo === 'tolta' ? '- ' : l.tipo === 'aggiunta' ? '+ ' : '  '}
          {l.testo}
          {'\n'}
        </span>
      ))}
    </pre>
  )
}

function Output({ value }: { value: string }) {
  const cut = value.length > MAX_OUTPUT
  return (
    <>
      <pre className="output">{cut ? value.slice(0, MAX_OUTPUT) : value}</pre>
      {cut && <p className="meta">{t('chat.shown', { shown: MAX_OUTPUT.toLocaleString(locale()), total: value.length.toLocaleString(locale()) })}</p>}
    </>
  )
}

function ToolPreview({ name, input }: { name: string; input: Record<string, unknown> }) {
  if (name === 'Edit') return <Diff before={text(input.old_string)} after={text(input.new_string)} />
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return <>{input.edits.map((e, i) => <Diff key={i} before={text(e?.old_string)} after={text(e?.new_string)} />)}</>
  }
  if (name === 'Write') return <Diff before="" after={text(input.content)} />
  if (name === 'Bash' || name === 'PowerShell') return <pre className="output command">{text(input.command)}</pre>
  if (name === 'Read') return null
  return <pre className="output">{JSON.stringify(input, null, 2)}</pre>
}

// La CLI chiude il risultato di un subagente con istruzioni per il modello, che a chi legge non dicono nulla.
const senzaCoda = (testo: string): string => testo.replace(/\s*agentId: \S+ \(use SendMessage[\s\S]*$/, '')

function SubagenteDettagli({ s }: { s: SubagenteVisto }) {
  return (
    <>
      <p className="meta">{s.strumenti.length ? t(s.strumenti.length === 1 ? 'chat.actions.one' : 'chat.actions.many', { n: s.strumenti.length, list: s.strumenti.map((n) => LABELS[n] ?? n).join(', ') }) : t('chat.noActions')}</p>
      {s.riassunto && s.riassunto !== s.descrizione && <p className="meta">{s.riassunto}</p>}
    </>
  )
}

function ToolCard({ item, cwd, answer }: { item: Extract<ChatItem, { kind: 'tool' }>; cwd: string; answer?: 'attesa' | 'negato' }) {
  const state =
    answer === 'negato' ? t('chat.state.denied')
    : answer === 'attesa' ? t('chat.state.waiting')
    : item.interrotto ? t('chat.state.interrupted')
    : item.result === undefined ? t('chat.state.running')
    : item.isError ? t('chat.state.error')
    : t('chat.state.done')
  const tone = state === t('chat.state.waiting') ? 'pill warn' : state === t('chat.state.running') ? 'pill busy' : state === t('chat.state.error') ? 'pill bad' : 'pill'
  return (
    <details className="tool">
      <summary>
        <span className="tool-name">{LABELS[item.name] ?? item.name}</span>
        <span className="tool-summary">{item.subagente?.descrizione || summary(item.name, item.input, cwd)}{item.subagente?.stato === 'in corso' && item.subagente.ultimo ? ` · ${LABELS[item.subagente.ultimo] ?? item.subagente.ultimo}` : ''}</span>
        <span className={tone}>{state}</span>
      </summary>
      <div className="tool-body">
        {item.subagente && <SubagenteDettagli s={item.subagente} />}
        {!item.subagente && <ToolPreview name={item.name} input={item.input} />}
        {item.result !== undefined && item.result !== '' && item.name !== 'Edit' && item.name !== 'Write' && <Output value={item.subagente ? senzaCoda(item.result) : item.result} />}
        {item.isError && (item.name === 'Edit' || item.name === 'Write') && item.result && <Output value={item.result} />}
      </div>
    </details>
  )
}

function QuestionCard({ item, onAnswer }: { item: Extract<ChatItem, { kind: 'permission' }>; onAnswer: (d: Decision) => void }) {
  const questions = (Array.isArray(item.input.questions) ? item.input.questions : []) as Question[]
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const complete = questions.every((q) => answers[q.question]?.trim())

  const toggle = (q: Question, label: string): void => {
    if (!q.multiSelect) return setAnswers({ ...answers, [q.question]: label })
    const current = (answers[q.question] ?? '').split(', ').filter(Boolean)
    const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label]
    setAnswers({ ...answers, [q.question]: next.join(', ') })
  }

  return (
    <div className="ask frame" role="group" aria-label={t('chat.questionLabel')}>
      <p className="eyebrow">{t('chat.asks')}</p>
      {questions.map((q) => (
        <fieldset key={q.question}>
          <legend>{q.question}</legend>
          {q.options.map((o) => {
            const on = (answers[q.question] ?? '').split(', ').includes(o.label)
            return (
              <button key={o.label} type="button" className={on ? 'option on' : 'option'} aria-pressed={on} onClick={() => toggle(q, o.label)}>
                <strong>{o.label}</strong>
                {o.description && <span>{o.description}</span>}
              </button>
            )
          })}
          <input
            aria-label={t('chat.otherAnswer', { question: q.question })}
            placeholder={t('chat.otherPlaceholder')}
            onChange={(e) => setAnswers({ ...answers, [q.question]: e.target.value })}
          />
        </fieldset>
      ))}
      <div className="ask-actions">
        <button disabled={!complete} onClick={() => onAnswer({ scelta: 'allow', risposte: answers })}>{t('chat.answer')}</button>
        <button className="ghost" onClick={() => onAnswer({ scelta: 'deny' })}>{t('chat.dontAnswer')}</button>
      </div>
    </div>
  )
}

function PermissionCard({ item, cwd, onAnswer }: { item: Extract<ChatItem, { kind: 'permission' }>; cwd: string; onAnswer: (d: Decision) => void }) {
  // A risposta data basta lo stato mostrato sulla riga dello strumento.
  if (item.risposta) return null
  if (item.name === 'AskUserQuestion') return <QuestionCard item={item} onAnswer={onAnswer} />
  const editsFiles = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(item.name)
  return (
    <div className="ask frame" role="group" aria-label={t('chat.permissionLabel')}>
      <p className="eyebrow attention">{t('chat.needsPermission')}</p>
      <p className="ask-title">
        <strong>{LABELS[item.name] ?? item.name}</strong> {summary(item.name, item.input, cwd)}
      </p>
      {item.description && item.description !== summary(item.name, item.input, cwd) && <p className="meta">{item.description}</p>}
      <ToolPreview name={item.name} input={item.input} />
      <div className="ask-actions">
        <button onClick={() => onAnswer({ scelta: 'allow' })}>{t('chat.allow')}</button>
        {item.session && (
          <button className="ghost" onClick={() => onAnswer({ scelta: 'allowSession' })}>
            {editsFiles ? t('chat.allowEditsSession') : t('chat.allowSession')}
          </button>
        )}
        <button className="ghost danger" onClick={() => onAnswer({ scelta: 'deny' })}>{t('chat.deny')}</button>
      </div>
    </div>
  )
}

export function ChatItemView({ item, cwd, answer, onAnswer }: { item: ChatItem; cwd: string; answer?: 'attesa' | 'negato'; onAnswer: (id: string, d: Decision) => void }) {
  switch (item.kind) {
    case 'user':
      return <div className="bubble-user">{item.text}</div>
    case 'text':
      return (
        <div className="markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>
            {item.text}
          </ReactMarkdown>
        </div>
      )
    case 'thinking':
      return (
        <details className="thinking">
          <summary>{t('chat.thinking')}</summary>
          <p>{item.text}</p>
        </details>
      )
    case 'tool':
      return <ToolCard item={item} cwd={cwd} answer={answer} />
    case 'permission':
      return <PermissionCard item={item} cwd={cwd} onAnswer={(d) => onAnswer(item.id, d)} />
    case 'note':
      return item.tone === 'login' ? (
        <div className="warning" role="alert">
          {item.text} {t('chat.loginBefore')} <code>claude auth login</code>{t('chat.loginAfter')}
        </div>
      ) : (
        <p className={item.tone === 'error' ? 'error' : 'meta note'} role={item.tone === 'error' ? 'alert' : undefined}>{item.text}</p>
      )
    case 'raw':
      return (
        <details className="thinking">
          <summary>{t('chat.unknownEvent')}</summary>
          <pre className="output">{item.text}</pre>
        </details>
      )
  }
}
