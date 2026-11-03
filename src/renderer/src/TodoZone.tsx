import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { t } from '../../shared/i18n.ts'
import { message } from './errors'
import type { DocTodo, Todo } from './hub'

export function TodoZone({ repo }: { repo: string }) {
  const [todos, setTodos] = useState<Todo[]>([])
  const [docs, setDocs] = useState<DocTodo[] | null>(null)
  const [testo, setTesto] = useState('')
  const [editing, setEditing] = useState<{ id: string; testo: string } | null>(null)
  const [removed, setRemoved] = useState<{ todo: Todo; index: number } | null>(null)
  const [error, setError] = useState('')

  const act = useCallback((p: Promise<Todo[]>) => {
    setError('')
    return p.then(setTodos, (e) => setError(message(e)))
  }, [])

  const loadDocs = useCallback(() => {
    setDocs(null)
    window.hub.docs.list(repo).then(setDocs, (e) => { setDocs([]); setError(message(e)) })
  }, [repo])

  useEffect(() => {
    void act(window.hub.todos.list(repo))
    loadDocs()
    void window.hub.todos.watch(repo)
    return window.hub.todos.onChange((changed) => {
      if (changed === repo) void act(window.hub.todos.list(repo))
    })
  }, [repo, act, loadDocs])

  const groups = useMemo(() => {
    const map = new Map<string, DocTodo[]>()
    for (const d of docs ?? []) map.set(d.file, [...(map.get(d.file) ?? []), d])
    return [...map].sort(([a], [b]) => a.localeCompare(b))
  }, [docs])

  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!testo.trim()) return
    void act(window.hub.todos.add(repo, testo)).then(() => setTesto(''))
  }

  const saveEdit = () => {
    if (!editing) return
    const { id, testo: text } = editing
    setEditing(null)
    if (text.trim() && text.trim() !== todos.find((t) => t.id === id)?.testo) void act(window.hub.todos.setText(repo, id, text))
  }

  const remove = (todo: Todo) => {
    setRemoved({ todo, index: todos.indexOf(todo) })
    void act(window.hub.todos.remove(repo, todo.id))
  }

  const ordered = [...todos.filter((t) => !t.fatta), ...todos.filter((t) => t.fatta)]

  return (
    <>
      {error && <p className="error" role="alert">{error}</p>}
      <form className="add" onSubmit={add}>
        <input aria-label={t('todo.newLabel')} placeholder={t('todo.placeholder')} maxLength={2000} value={testo} onChange={(e) => setTesto(e.target.value)} />
        <button disabled={!testo.trim()}>{t('todo.add')}</button>
      </form>

      {removed && (
        <p className="undo" role="status">
          {t('todo.deleted')}{' '}
          <button className="link" onClick={() => { void act(window.hub.todos.restore(repo, removed.todo, removed.index)); setRemoved(null) }}>{t('todo.undo')}</button>
        </p>
      )}

      {ordered.length === 0 ? (
        <p className="muted">{t('todo.empty')}</p>
      ) : (
        <ul className="todos">
          {ordered.map((voce) => (
            <li key={voce.id} className={voce.fatta ? 'done' : ''}>
              <input type="checkbox" aria-label={t('todo.doneLabel', { text: voce.testo })} checked={voce.fatta} onChange={(e) => void act(window.hub.todos.setDone(repo, voce.id, e.target.checked))} />
              {editing?.id === voce.id ? (
                <input
                  className="edit"
                  autoFocus
                  aria-label={t('todo.editLabel')}
                  maxLength={2000}
                  value={editing.testo}
                  onChange={(e) => setEditing({ id: voce.id, testo: e.target.value })}
                  onBlur={saveEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEdit()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <span className="text">{voce.testo}</span>
              )}
              <button className="link" onClick={() => setEditing({ id: voce.id, testo: voce.testo })}>{t('todo.edit')}</button>
              <button className="link danger" onClick={() => remove(voce)}>{t('todo.delete')}</button>
            </li>
          ))}
        </ul>
      )}

      <div className="docs-head">
        <h2>{t('todo.fromDocs')}</h2>
        <button className="link" onClick={loadDocs}>{t('common.refresh')}</button>
      </div>
      {docs === null ? (
        <p className="muted">{t('todo.readingDocs')}</p>
      ) : groups.length === 0 ? (
        <p className="muted">{t('todo.noOpen')}</p>
      ) : (
        <>
          <p className="muted">{t('todo.openSummary', { n: docs.length, files: groups.length })}</p>
          {groups.map(([file, items]) => (
            <details key={file} className="doc">
              <summary><span className="file">{file}</span> <span className="count">{items.length}</span></summary>
              <ul>
                {items.map((d) => (
                  <li key={d.riga}>
                    <span className="line">{t('todo.lineN', { n: d.riga })}</span> {d.sezione && <span className="muted">{d.sezione}: </span>}{d.testo}
                  </li>
                ))}
              </ul>
              <button className="link" onClick={() => window.hub.docs.open(repo, file).catch((e) => setError(message(e)))}>{t('todo.openOutside')}</button>
            </details>
          ))}
        </>
      )}
    </>
  )
}
