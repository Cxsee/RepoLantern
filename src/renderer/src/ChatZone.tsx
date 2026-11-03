import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { locale, t } from '../../shared/i18n.ts'
import { ChatItemView } from './ChatItems'
import { addUser, answerPermission, applyEvent, emptyChat, processEnded, toolAnswers, waitingPermissions, type ChatState } from './chatState'
import { message } from './errors'
import type { Decision, RecentChat, Worktree } from './hub'

type Tab = { id: string; repo: string; cwd: string; titolo: string; resumeId: string | null; chat: ChatState }

const same = (a: string, b: string): boolean => a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase()

function NewChat({ repo, onStart, onResume }: { repo: string; onStart: (cwd: string) => void; onResume: (r: RecentChat) => void }) {
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [recent, setRecent] = useState<RecentChat[]>([])
  const [cwd, setCwd] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    window.hub.status.read(repo).then((s) => {
      setWorktrees(s.worktree.filter((w) => !w.manca))
      setCwd(s.worktree[0]?.path ?? '')
    }, (e) => setError(message(e)))
    window.hub.chat.recent(repo).then(setRecent, () => {})
  }, [repo])

  return (
    <div className="new-chat">
      {error && <p className="error" role="alert">{error}</p>}
      <div className="frame new-chat-start">
        <p className="eyebrow">{t('chat.new')}</p>
        <label htmlFor="worktree">{t('chat.where')}</label>
        <div className="add">
          <select id="worktree" value={cwd} onChange={(e) => setCwd(e.target.value)}>
            {worktrees.map((w) => (
              <option key={w.path} value={w.path}>{w.branch ?? w.head} — {w.path}</option>
            ))}
          </select>
          <button disabled={!cwd} onClick={() => onStart(cwd)}>{t('chat.start')}</button>
        </div>
        <p className="meta">{t('chat.safety')}</p>
      </div>
      {recent.length > 0 && (
        <section>
          <h2>{t('chat.recent')}</h2>
          <ul className="rows">
            {recent.map((r) => (
              <li key={r.sessionId} className="row recent">
                <div>
                  <strong>{r.titolo}</strong>
                  <p className="meta">{new Date(r.quando).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })} · {r.cwd}</p>
                </div>
                <button className="ghost" onClick={() => onResume(r)}>{t('chat.resume')}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function Conversation({ tab, onSend, onStop, onAnswer }: { tab: Tab; onSend: (text: string) => void; onStop: () => void; onAnswer: (id: string, d: Decision) => void }) {
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const { chat } = tab

  useLayoutEffect(() => {
    if (pinned.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [chat.items])

  const submit = (): void => {
    if (!draft.trim() || chat.busy) return
    onSend(draft.trim())
    setDraft('')
    pinned.current = true
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const waiting = waitingPermissions(chat) > 0
  const answers = toolAnswers(chat)

  return (
    <div className="conversation">
      <div
        className="messages"
        ref={scroller}
        role="log"
        aria-label={t('chat.conversation')}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
        {chat.items.length === 0 && <p className="muted hello">{t('chat.hello')}</p>}
        {chat.items.map((item) => <ChatItemView key={item.id} item={item} cwd={tab.cwd} answer={answers.get(item.id)} onAnswer={onAnswer} />)}
        {chat.busy && !waiting && <p className="working" role="status"><span className="pulse" aria-hidden="true" />{t('chat.working')}</p>}
      </div>
      <div className="composer">
        <textarea
          aria-label={t('chat.messageLabel')}
          placeholder={chat.busy ? t('chat.workingPlaceholder') : t('chat.placeholder')}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
        {chat.busy ? <button className="ghost danger" onClick={onStop}>{t('chat.stop')}</button> : <button disabled={!draft.trim()} onClick={submit}>{t('chat.send')}</button>}
      </div>
    </div>
  )
}

export type ChatRequest = { id: number; titolo: string; testo: string | null; cwd?: string }

export function ChatZone({ repo, visible, request, onAttention }: { repo: string; visible: boolean; request: ChatRequest | null; onAttention: (count: number) => void }) {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const update = useCallback((id: string, change: (chat: ChatState) => ChatState) => {
    setTabs((all) => all.map((t) => (t.id === id ? { ...t, chat: change(t.chat) } : t)))
  }, [])

  useEffect(() => {
    const stopEvents = window.hub.chat.onEvent((id, event) => update(id, (c) => applyEvent(c, event)))
    const stopEnd = window.hub.chat.onEnd((id, err) => update(id, (c) => processEnded(c, err)))
    return () => {
      stopEvents()
      stopEnd()
    }
  }, [update])

  useEffect(() => onAttention(tabs.reduce((sum, t) => sum + waitingPermissions(t.chat), 0)), [tabs, onAttention])

  const repoTabs = useMemo(() => tabs.filter((t) => same(t.repo, repo)), [tabs, repo])
  const active = repoTabs.find((t) => t.id === activeId) ?? null

  const open = (cwd: string, titolo: string, resumeId: string | null, chat: ChatState): Tab => {
    const tab: Tab = { id: crypto.randomUUID(), repo, cwd, titolo, resumeId, chat }
    setTabs((all) => [...all, tab])
    setActiveId(tab.id)
    return tab
  }

  const resume = async (r: RecentChat): Promise<void> => {
    setError('')
    const existing = repoTabs.find((t) => t.chat.sessionId === r.sessionId || t.resumeId === r.sessionId)
    if (existing) return setActiveId(existing.id)
    const history = await window.hub.chat.history(repo, r.cwd, r.sessionId).catch((e) => {
      setError(t('chat.noHistory', { error: message(e) }))
      return [] as unknown[]
    })
    const chat = history.reduce<ChatState>((state, event) => applyEvent(state, event, true), emptyChat)
    open(r.cwd, r.titolo, r.sessionId, { ...chat, busy: false })
  }

  const send = (tab: Tab, text: string): void => {
    setError('')
    update(tab.id, (c) => addUser(c, text))
    setTabs((all) => all.map((x) => (x.id === tab.id && x.titolo === t('chat.new') ? { ...x, titolo: text.slice(0, 40) } : x)))
    window.hub.chat.send(repo, tab.id, tab.cwd, tab.chat.sessionId ?? tab.resumeId, text).catch((e) => update(tab.id, (c) => processEnded(c, message(e))))
  }

  // Una richiesta da un'altra zona, come "Crea la mappa" o "Chat con Claude qui".
  const handled = useRef<number | null>(null)
  useEffect(() => {
    if (!request || handled.current === request.id) return
    handled.current = request.id
    const tab = open(request.cwd ?? repo, request.titolo, null, emptyChat)
    if (request.testo) send(tab, request.testo)
  })

  const answer = (tab: Tab, id: string, decision: Decision): void => {
    update(tab.id, (c) => answerPermission(c, id, decision.scelta === 'deny' ? 'deny' : 'allow'))
    window.hub.chat.respond(tab.id, id, decision).catch((e) => setError(message(e)))
  }

  const close = (tab: Tab): void => {
    if (tab.chat.busy && !window.confirm(t('chat.confirmClose'))) return
    void window.hub.chat.close(tab.id)
    setTabs((all) => all.filter((t) => t.id !== tab.id))
    if (activeId === tab.id) setActiveId(null)
  }

  return (
    <div className="chat" hidden={!visible}>
      <div className="tabs" role="tablist" aria-label={t('chat.open')}>
        {repoTabs.map((tb) => (
          <div key={tb.id} className={tb.id === activeId ? 'tab on' : 'tab'}>
            <button role="tab" aria-selected={tb.id === activeId} className="tab-title" onClick={() => setActiveId(tb.id)}>
              {waitingPermissions(tb.chat) > 0 ? <span className="dot attention-dot" aria-label={t('chat.awaiting')} /> : tb.chat.busy ? <span className="pulse" aria-label={t('chat.busy')} /> : null}
              {tb.titolo}
            </button>
            <button className="tab-close" aria-label={t('chat.close', { title: tb.titolo })} onClick={() => close(tb)}>×</button>
          </div>
        ))}
        <button className={activeId === null || !active ? 'tab-new on' : 'tab-new'} onClick={() => setActiveId(null)} aria-label={t('chat.new')}>{t('chat.newTab')}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {active ? (
        <Conversation key={active.id} tab={active} onSend={(t) => send(active, t)} onStop={() => void window.hub.chat.stop(active.id)} onAnswer={(id, d) => answer(active, id, d)} />
      ) : (
        <NewChat key={repo} repo={repo} onStart={(cwd) => open(cwd, t('chat.new'), null, emptyChat)} onResume={(r) => void resume(r)} />
      )}
    </div>
  )
}
