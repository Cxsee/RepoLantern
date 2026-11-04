import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { lingua, t } from '../../shared/i18n.ts'
import { BranchZone } from './BranchZone'
import { ChatZone, type ChatRequest } from './ChatZone'
import { message } from './errors'
import type { RepoList } from './hub'
import { sezioneValida, sezioniDi, soloUltima } from './sezioni'
import { DoctorZone } from './DoctorZone'
import { ReviewZone } from './ReviewZone'
import { AnteprimaZone } from './AnteprimaZone'
import { HomeZone, type Destinazione } from './HomeZone'
import type { DestinazioneOggetto } from './hub'
import { Ricerca } from './Ricerca'
import { AttivaSocial, SocialZone } from './SocialZone'
import { StatusZone } from './StatusZone'
import { TodoZone } from './TodoZone'

const ATTIVA_SOCIAL = 'attiva-social'

export function App() {
  const [list, setList] = useState<RepoList | null>(null)
  const [zone, setZoneState] = useState('home')
  // Vale una volta sola e solo per la repo da cui è stata scelta.
  const [destinazione, setDestinazione] = useState<{ repo: string; dove: Destinazione } | null>(null)
  const consumaDestinazione = useCallback(() => setDestinazione(null), [])
  const [funzioneDa, setFunzioneDa] = useState<{ repo: string; id: string } | null>(null)
  const consumaFunzione = useCallback(() => setFunzioneDa(null), [])
  const [cercando, setCercando] = useState(false)
  const [moduli, setModuli] = useState<ReadonlySet<string>>(new Set())
  // Social è un modulo su misura: si propone solo a chi ha già una configurazione o dei dati.
  const [socialPossibile, setSocialPossibile] = useState(false)
  const [error, setError] = useState('')
  const [attention, setAttention] = useState(0)
  const [chatRequest, setChatRequest] = useState<ChatRequest | null>(null)

  useEffect(() => {
    window.hub.repos.list().then(setList, (e) => setError(message(e)))
  }, [])

  const lanciaRepo = useRef(soloUltima<RepoList>()).current
  const apply = (p: Promise<RepoList>) => {
    setError('')
    lanciaRepo(p, setList, (e) => setError(message(e)))
  }

  const active = list?.repos.find((r) => r.path === list.attiva) ?? null
  const usable = !!active && !active.manca
  const percorso = usable ? active.path : null
  const repoAttuale = useRef(percorso)
  repoAttuale.current = percorso
  const sezioni = useMemo(() => sezioniDi(moduli), [moduli])
  const index = sezioni.findIndex((z) => z.id === zone)
  const current = index >= 0 ? sezioni[index] : { id: zone, nome: zone === ATTIVA_SOCIAL ? t('app.activateSocial') : sezioni[0].nome }
  // Se nel frattempo l'utente ha già scelto una sezione, quella salvata non gliela toglie di mano.
  const scelta = useRef(false)

  const setZone = useCallback((id: string): void => {
    scelta.current = true
    setZoneState(id)
    if (percorso && id !== ATTIVA_SOCIAL) void window.hub.preferenze.scriviSezione(percorso, id).catch(() => {})
  }, [percorso])

  const vaiDaRicerca = (repo: string, d: DestinazioneOggetto): void => {
    if (d.t === 'file') {
      window.hub.open.file(repo, d.percorso).catch((e) => setError(message(e)))
    } else if (d.t === 'funzione') {
      setFunzioneDa({ repo, id: d.id })
      setZone('anteprima')
    } else {
      setDestinazione({ repo, dove: d })
      setZone('branch')
    }
    setCercando(false)
  }

  // Non durante una conferma o una richiesta di permesso: lì la tastiera serve a rispondere.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (!e.ctrlKey || e.key.toLowerCase() !== 'k' || !percorso || document.querySelector('.ask, .ante-conferma')) return
      e.preventDefault()
      setCercando(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [percorso])

  useEffect(() => setCercando(false), [percorso])

  const onAttention = useCallback((n: number) => setAttention(n), [])

  // Una risposta arrivata dopo il cambio di repo riguarda quella di prima: non deve muovere la navigazione né finire nella sua chat.
  const seAncora = (repo: string, fare: () => void): void => {
    if (repoAttuale.current === repo) fare()
  }

  const apriChat = (repo: string, titolo: string, testo: string): void => seAncora(repo, () => {
    setChatRequest({ id: Date.now(), titolo, testo })
    setZone('claude')
  })



  // Ogni repo ricorda i suoi moduli e la sezione in cui eri.
  useEffect(() => {
    if (!percorso) return
    let valido = true
    scelta.current = false
    setModuli(new Set())
    setSocialPossibile(false)
    Promise.all([window.hub.moduli.leggi(percorso), window.hub.preferenze.sezione(percorso)]).then(([m, salvata]) => {
      if (!valido) return
      const attivi = new Set(m.social.attivo ? ['social'] : [])
      setModuli(attivi)
      setSocialPossibile(Boolean(m.proposta.avd || m.proposta.istruzioni || m.datiVecchi))
      setZoneState((ora) => (scelta.current ? (ora === 'social' && !attivi.has('social') ? 'home' : ora) : sezioneValida(salvata, attivi)))
    }, (e) => setError(message(e)))
    return () => {
      valido = false
    }
  }, [percorso])

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand"><span className="brand-mark" aria-hidden="true" />RepoLantern</span>
      </div>
      <nav className="side" aria-label={t('app.zones')}>
        <label className="eyebrow" htmlFor="repo">{t('app.repo')}</label>
        <select id="repo" value={active?.path ?? ''} disabled={!list?.repos.length} onChange={(e) => apply(window.hub.repos.select(e.target.value))}>
          {!list?.repos.length && <option value="">{t('app.noRepo')}</option>}
          {list?.repos.map((r) => (
            <option key={r.path} value={r.path}>{r.manca ? t('app.repoMissing', { name: r.nome }) : r.nome}</option>
          ))}
        </select>
        <button className="ghost" onClick={() => apply(window.hub.repos.add())}>{t('app.addRepo')}</button>
        {usable && <button className="ghost cerca-apri" onClick={() => setCercando(true)}>{t('app.search')} <kbd>Ctrl K</kbd></button>}
        <ul>
          {sezioni.map((z, i) => (
            <li key={z.id}>
              {z.claude && !sezioni[i - 1]?.claude && <p className="eyebrow gruppo-claude">{t('app.optionalClaude')}</p>}
              <button className={z.id === zone ? 'zone on' : 'zone'} aria-current={z.id === zone ? 'page' : undefined} onClick={() => setZone(z.id)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d={z.icona} /></svg>
                {z.nome}
                {z.id === 'claude' && attention > 0 ? (
                  <span className="badge" aria-label={t('app.waiting', { n: attention })}>{attention}</span>
                ) : (
                  <span className="zone-index" aria-hidden="true">0{i + 1}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        {usable && socialPossibile && !moduli.has('social') && <button className="ghost small" onClick={() => setZone(ATTIVA_SOCIAL)}>{t('app.activateSocial')}</button>}
        {active && <button className="ghost small" onClick={() => apply(window.hub.repos.remove(active.path))}>{t('app.removeRepo', { name: active.nome })}</button>}
        <label className="meta">{t('language.label')} <select value={lingua()} onChange={(e) => void window.hub.lingua.set(e.target.value as 'en' | 'it')}><option value="en">English</option><option value="it">Italiano</option></select></label>
      </nav>
      <main className={zone === 'claude' ? 'main-chat' : zone === 'branch' ? 'main-chat main-branch' : ''}>
        <header className="zone-head">
          <p className="eyebrow">{index >= 0 ? t('app.position', { n: index + 1, total: sezioni.length }) : t('app.module')}</p>
          <h1 key={zone}>{current.nome}</h1>
          {active && <p className="path">{active.path}</p>}
        </header>
        {error && <p className="error" role="alert">{error}</p>}
        {!list ? null : !active ? (
          <div className="empty frame">
            <p>{t('app.empty')}</p>
            <button onClick={() => apply(window.hub.repos.add())}>{t('app.addRepo')}</button>
          </div>
        ) : active.manca ? (
          <div className="empty frame"><p>{t('app.notGit')}</p></div>
        ) : zone === 'home' ? (
          <HomeZone
            key={active.path}
            repo={active.path}
            onZona={setZone}
            onBranch={(d) => {
              setDestinazione({ repo: active.path, dove: d })
              setZone('branch')
            }}
          />
        ) : zone === 'todo' ? (
          <TodoZone key={active.path} repo={active.path} />
        ) : zone === 'stato' ? (
          <StatusZone key={active.path} repo={active.path} onOpenBranches={() => setZone('branch')} />
        ) : zone === 'branch' ? (
          <BranchZone
            key={active.path}
            repo={active.path}
            destinazione={destinazione?.repo === active.path ? destinazione.dove : null}
            onDestinazione={consumaDestinazione}
            onChat={(cwd, titolo) => {
              setChatRequest({ id: Date.now(), titolo, testo: null, cwd })
              setZone('claude')
            }}
          />
        ) : zone === 'claude' ? null : zone === 'avvio' ? (
          <DoctorZone key={active.path} repo={active.path} />
        ) : zone === 'review' ? (
          <ReviewZone key={active.path} repo={active.path} />
        ) : zone === 'anteprima' ? (
          <AnteprimaZone key={active.path} repo={active.path} funzione={funzioneDa?.repo === active.path ? funzioneDa.id : null} onFunzione={consumaFunzione} />
        ) : zone === ATTIVA_SOCIAL ? (
          <AttivaSocial
            key={active.path}
            repo={active.path}
            onDone={() => seAncora(active.path, () => {
              setModuli(new Set(['social']))
              setZone('social')
            })}
          />
        ) : (
          <SocialZone
            key={active.path}
            repo={active.path}
            onSession={(testo) => apriChat(active.path, t('app.socialSession'), testo)}
            onRemove={() => seAncora(active.path, () => {
              setModuli(new Set())
              setZone('home')
            })}
          />
        )}
        {/* Sempre montata: le chat devono continuare e restare in memoria quando si cambia zona. */}
        {cercando && percorso && <Ricerca key={`ricerca:${percorso}`} repo={percorso} onClose={() => setCercando(false)} onVai={(d) => vaiDaRicerca(percorso, d)} />}
        {usable && <ChatZone repo={active.path} visible={zone === 'claude'} request={chatRequest} onAttention={onAttention} />}
      </main>
    </div>
  )
}
