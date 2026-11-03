import { contextBridge, ipcRenderer } from 'electron'

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('hub', {
  lingua: {
    get: call('lingua:get'),
    set: call('lingua:set')
  },
  repos: {
    list: call('repos:list'),
    add: call('repos:add'),
    select: call('repos:select'),
    remove: call('repos:remove')
  },
  todos: {
    watch: call('todos:watch'),
    list: call('todos:list'),
    add: call('todos:add'),
    setDone: call('todos:setDone'),
    setText: call('todos:setText'),
    remove: call('todos:remove'),
    restore: call('todos:restore'),
    onChange: (fn: (repo: string) => void) => {
      const listener = (_e: unknown, repo: string): void => fn(repo)
      ipcRenderer.on('todos-cambiati', listener)
      return () => ipcRenderer.off('todos-cambiati', listener)
    }
  },
  docs: {
    list: call('docs:list'),
    open: call('docs:open')
  },
  moduli: {
    leggi: call('moduli:leggi'),
    attivaSocial: call('moduli:attivaSocial'),
    togliSocial: call('moduli:togliSocial')
  },
  preferenze: {
    sezione: call('preferenze:sezione'),
    scriviSezione: call('preferenze:scriviSezione'),
    visitaHome: call('preferenze:visitaHome')
  },
  anteprima: {
    dati: call('anteprima:dati'),
    flusso: call('anteprima:flusso'),
    contesto: call('anteprima:contesto'),
    segnala: call('anteprima:segnala')
  },
  ricavo: {
    livello: call('ricavo:livello'),
    flusso: call('ricavo:flusso'),
    dati: call('ricavo:dati'),
    statoFlusso: call('ricavo:stato-flusso')
  },
  lavori: {
    elenco: call('lavori:elenco'),
    annulla: call('lavori:annulla'),
    onChange: (fn: (repo: string, id: string, evento: string | null) => void) => {
      const listener = (_e: unknown, repo: string, id: string, evento: string | null): void => fn(repo, id, evento)
      ipcRenderer.on('lavoro-cambiato', listener)
      return () => ipcRenderer.off('lavoro-cambiato', listener)
    }
  },
  doctor: {
    visita: call('doctor:visita')
  },
  codice: {
    cerca: call('codice:cerca'),
    brano: call('codice:brano')
  },
  archivio: {
    apri: call('archivio:apri'),
    cerca: call('archivio:cerca'),
    oggetto: call('archivio:oggetto'),
    aggiorna: call('archivio:aggiorna'),
    onChange: (fn: (repo: string) => void) => {
      const listener = (_e: unknown, repo: string): void => fn(repo)
      ipcRenderer.on('archivio-cambiato', listener)
      return () => ipcRenderer.off('archivio-cambiato', listener)
    }
  },
  status: {
    read: call('status:read'),
    watch: call('status:watch'),
    unwatch: call('status:unwatch'),
    onChange: (fn: (repo: string) => void) => {
      const listener = (_e: unknown, repo: string): void => fn(repo)
      ipcRenderer.on('stato-cambiato', listener)
      return () => ipcRenderer.off('stato-cambiato', listener)
    }
  },
  chat: {
    send: call('chat:send'),
    respond: call('chat:respond'),
    stop: call('chat:stop'),
    close: call('chat:close'),
    recent: call('chat:recent'),
    history: call('chat:history'),
    onEvent: (fn: (tab: string, event: unknown) => void) => {
      const listener = (_e: unknown, tab: string, event: unknown): void => fn(tab, event)
      ipcRenderer.on('chat-evento', listener)
      return () => ipcRenderer.off('chat-evento', listener)
    },
    onEnd: (fn: (tab: string, error: string | null) => void) => {
      const listener = (_e: unknown, tab: string, error: string | null): void => fn(tab, error)
      ipcRenderer.on('chat-fine', listener)
      return () => ipcRenderer.off('chat-fine', listener)
    }
  },
  git: {
    graph: call('git:graph'),
    commit: call('git:commit'),
    commitDiff: call('git:commitDiff'),
    branch: call('git:branch'),
    branchDiff: call('git:branchDiff'),
    worktreeChanges: call('git:worktreeChanges'),
    worktreeDiff: call('git:worktreeDiff')
  },
  social: {
    read: call('social:read'),
    refresh: call('social:refresh'),
    setInterval: call('social:setInterval'),
    session: call('social:session'),
    onChange: (fn: () => void) => {
      const listener = (): void => fn()
      ipcRenderer.on('social-cambiato', listener)
      return () => ipcRenderer.off('social-cambiato', listener)
    }
  },
  open: {
    vscode: call('open:vscode'),
    file: call('open:file'),
    terminal: call('open:terminal'),
    folder: call('open:folder'),
    github: call('open:github')
  }
})
