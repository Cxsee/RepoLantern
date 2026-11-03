import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { t } from '../../shared/i18n.ts'
import { message } from './errors'
import type { BranoFile, DestinazioneOggetto, Occorrenza, OggettoHub, RisultatiCodice, TrovatoHub } from './hub'
import { soloUltima } from './sezioni'

const TIPI: Record<string, string> = { get file() { return t('search.type.file') }, get commit() { return t('search.type.commit') }, get ref() { return t('search.type.ref') }, get funzione() { return t('search.type.function') }, get attivita() { return t('search.type.activity') } }
const AZIONE: Record<DestinazioneOggetto['t'], string> = { get commit() { return t('search.action.commit') }, get branch() { return t('search.action.branch') }, get funzione() { return t('search.action.function') }, get file() { return t('search.action.file') } }

const TIPI_CODICE: Record<Occorrenza['tipo'], string> = { get definizione() { return t('search.code.definition') }, get codice() { return t('search.code.code') }, get test() { return t('search.code.test') }, get documento() { return t('search.code.document') } }

export function PannelloCodice({ repo, voce }: { repo: string; voce: Occorrenza }) {
  const [b, setB] = useState<BranoFile | null | undefined>(undefined)
  const [error, setError] = useState('')
  const riga = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let valido = true
    setB(undefined)
    window.hub.codice.brano(repo, voce.file, voce.riga).then((v) => {
      if (valido) setB(v)
    }, (e) => {
      if (valido) setError(message(e))
    })
    return () => {
      valido = false
    }
  }, [repo, voce.file, voce.riga])
  useEffect(() => {
    // Scorre solo il riquadro del codice: il pulsante sopra deve restare visibile.
    const r = riga.current
    if (r?.parentElement) r.parentElement.scrollTop = r.offsetTop - r.parentElement.clientHeight / 2
  }, [b])
  return (
    <div className="pannello">
      <p className="eyebrow">{TIPI_CODICE[voce.tipo]}</p>
      <h2>{voce.file}:{voce.riga}</h2>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="ghost small" onClick={() => window.hub.open.file(repo, voce.file, voce.riga).catch((e) => setError(message(e)))}>{t('search.openAtLine')}</button>
      {b === undefined && !error && <p className="muted">{t('common.reading')}</p>}
      {b === null && <p className="meta">{t('search.cannotShow')}</p>}
      {b && (
        <>
          <p className="meta">{t('search.fileNow', { total: b.totale })}{b.righe.length < b.totale ? t('search.around', { line: voce.riga }) : ''}.{voce.nonTracciato && ` ${t('search.untracked')}`}{voce.file.endsWith('.sql') && voce.file.includes('migrations') && voce.tipo === 'definizione' && ` ${t('search.migrated')}`}</p>
          <div className="output pannello-codice file-righe" role="region" aria-label={t('search.contentOf', { file: voce.file })} tabIndex={0}>
            {b.righe.map((t, i) => {
              const n = b.inizio + i
              return <div key={n} ref={n === voce.riga ? riga : undefined} className={n === voce.riga ? 'file-riga on' : 'file-riga'}><span className="file-numero">{n}</span><span>{t || ' '}</span></div>
            })}
          </div>
        </>
      )}
    </div>
  )
}

function Pannello({ repo, id, onVai }: { repo: string; id: string; onVai: (d: DestinazioneOggetto) => void }) {
  const [o, setO] = useState<OggettoHub | null | undefined>(undefined)
  const [error, setError] = useState('')
  useEffect(() => {
    let valido = true
    setO(undefined)
    window.hub.archivio.oggetto(repo, id).then((v) => {
      if (valido) setO(v)
    }, (e) => {
      if (valido) setError(message(e))
    })
    return () => {
      valido = false
    }
  }, [repo, id])
  if (error) return <p className="error" role="alert">{error}</p>
  if (o === undefined) return <p className="muted">{t('common.reading')}</p>
  if (o === null) return <p className="muted">{t('search.gone')}</p>
  return (
    <div className="pannello">
      <p className="eyebrow">{TIPI[o.tipo] ?? o.tipo}</p>
      <h2>{o.titolo}</h2>
      {o.spiega && <p>{o.spiega}</p>}
      <p className="meta">
        <span className={o.provenienza.certezza === 'certo' ? 'pill' : 'pill warn'}>{o.provenienza.certezza === 'certo' ? t('search.certain') : o.provenienza.certezza === 'non-disponibile' ? t('search.notFound') : t('search.inferred')}</span> {o.provenienza.testo}
      </p>
      <dl className="pannello-dati">
        {o.dati.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {o.anteprima && (
        <>
          <p className="meta">{t('search.firstLines', { commit: o.commitAnteprima?.slice(0, 9) ?? '' })}</p>
          <pre className="output pannello-codice">{o.anteprima.righe.join('\n')}</pre>
        </>
      )}
      {o.percorso && !o.anteprima && <p className="meta">{t('search.notInCommit')}</p>}
      {o.voci.length > 0 && (
        <>
          <h3>{t('search.todosInFile')}</h3>
          <ul>{o.voci.map((v) => <li key={`${v.tipo}${v.riga}`} className="meta">{t('search.line', { line: v.riga, text: v.testo })}</li>)}</ul>
        </>
      )}
      <h3>{t('search.links')}</h3>
      {o.legami.length ? <ul>{o.legami.map((l) => <li key={`${l.altro}${l.tipo}`} className="meta">{l.titolo} ({l.tipo.replaceAll('_', ' ')})</li>)}</ul> : <p className="meta">{t('search.noLinks')}</p>}
      {o.destinazione && <button onClick={() => onVai(o.destinazione!)}>{AZIONE[o.destinazione.t]}</button>}
    </div>
  )
}

export function Ricerca({ repo, onClose, onVai }: { repo: string; onClose: () => void; onVai: (d: DestinazioneOggetto) => void }) {
  const [testo, setTesto] = useState('')
  const [trovati, setTrovati] = useState<TrovatoHub[]>([])
  // Il testo a cui appartengono i risultati: Invio non deve aprire quelli di una ricerca precedente.
  const [perTesto, setPerTesto] = useState<string | null>(null)
  const [giri, setGiri] = useState(0)
  const [scelto, setScelto] = useState(0)
  const [error, setError] = useState('')
  const lancia = useRef(soloUltima<TrovatoHub[]>()).current
  const [codice, setCodice] = useState<RisultatiCodice>({ voci: [], altri: 0 })
  const [perCodice, setPerCodice] = useState<string | null>(null)
  const lanciaCodice = useRef(soloUltima<RisultatiCodice>()).current
  const campo = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const prima = document.activeElement as HTMLElement | null
    campo.current?.focus()
    // L'indice si riallinea all'apertura e poi la ricerca si rifà: un file nuovo o appena modificato si deve trovare.
    let valido = true
    window.hub.archivio.aggiorna(repo).then(() => {
      if (valido) setGiri((g) => g + 1)
    }, () => {})
    return () => {
      valido = false
      prima?.focus?.()
    }
  }, [repo])

  useEffect(() => {
    const t = setTimeout(() => {
      lancia(window.hub.archivio.cerca(repo, testo), (v) => {
        setTrovati(v)
        setPerTesto(testo)
        setScelto((s) => (s < v.length ? s : 0))
        setError('')
      }, (e) => setError(message(e)))
    }, 100)
    return () => clearTimeout(t)
  }, [repo, testo, lancia, giri])

  // Git legge i file a ogni ricerca: si aspetta che smetti di scrivere.
  useEffect(() => {
    const t = setTimeout(() => {
      lanciaCodice(window.hub.codice.cerca(repo, testo), (v) => {
        setCodice(v)
        setPerCodice(testo)
      }, (e) => setError(message(e)))
    }, 250)
    return () => clearTimeout(t)
  }, [repo, testo, lanciaCodice])

  const totale = trovati.length + codice.voci.length
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setScelto((s) => (totale ? (s + (e.key === 'ArrowDown' ? 1 : totale - 1)) % totale : 0))
    } else if (e.key === 'Tab') {
      // La tastiera resta nel dialogo: dietro c'è il resto di Hub, che ora non si deve toccare.
      const dentro = [...e.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled), a[href], textarea')]
      const i = dentro.indexOf(document.activeElement as HTMLElement)
      e.preventDefault()
      dentro[(i + (e.shiftKey ? dentro.length - 1 : 1)) % dentro.length]?.focus()
    } else if (e.key === 'Enter' && perCodice === testo && scelto >= trovati.length && codice.voci[scelto - trovati.length] && (e.target as HTMLElement).tagName === 'INPUT') {
      const v = codice.voci[scelto - trovati.length]
      void window.hub.open.file(repo, v.file, v.riga).catch((err) => setError(message(err)))
    } else if (e.key === 'Enter' && perTesto === testo && trovati[scelto] && (e.target as HTMLElement).tagName === 'INPUT') {
      void window.hub.archivio.oggetto(repo, trovati[scelto].oggetto).then((o) => {
        if (o?.destinazione) onVai(o.destinazione)
      }, (err) => setError(message(err)))
    }
  }

  const corrente = trovati[scelto]
  const inCodice = scelto >= trovati.length ? codice.voci[scelto - trovati.length] : undefined
  const attesa = testo.trim().length >= 2 && perCodice !== testo
  return (
    <div className="ricerca-sfondo" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ricerca frame" role="dialog" aria-modal="true" aria-label={t('search.dialog')} onKeyDown={onKey}>
        <input ref={campo} type="search" aria-label={t('search.label')} placeholder={t('search.placeholder')} value={testo} onChange={(e) => setTesto(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="ricerca-corpo">
          <ul aria-label={t('search.results')}>
            {trovati.map((t, i) => (
              <li key={t.oggetto}>
                <button className={i === scelto ? 'ricerca-voce on' : 'ricerca-voce'} aria-current={i === scelto ? 'true' : undefined} onClick={() => setScelto(i)}>
                  <span className="ricerca-titolo">{t.titolo}</span>
                  <span className="pill">{TIPI[t.tipo] ?? t.tipo}</span>
                </button>
              </li>
            ))}
            {codice.voci.length > 0 && <li className="ricerca-gruppo">{t('search.inCode')}</li>}
            {codice.voci.length > 0 && codice.parole && <li className="meta ricerca-vuoto">{t(codice.esatte ? 'search.wordsToo' : 'search.wordsOnly', { words: codice.parole.join(', ') })}</li>}
            {codice.voci.map((v, i) => {
              const n = trovati.length + i
              return (
                <li key={`${v.file}:${v.riga}`}>
                  <button className={n === scelto ? 'ricerca-voce on' : 'ricerca-voce'} aria-current={n === scelto ? 'true' : undefined} onClick={() => setScelto(n)}>
                    <span className="ricerca-titolo"><span className="ricerca-file">{v.file}:{v.riga}</span><code>{v.testo}</code></span>
                    {v.nonTracciato ? <span className="pill warn">{t('search.notInGit')}</span> : v.tipo !== 'codice' && <span className="pill">{TIPI_CODICE[v.tipo]}</span>}
                  </button>
                </li>
              )
            })}
            {codice.altri > 0 && <li className="muted ricerca-vuoto">{t('search.moreResults', { n: codice.altri })}</li>}
            {attesa && <li className="muted ricerca-vuoto">{t('search.searchingCode')}</li>}
            {testo.trim() && !attesa && !totale && <li className="muted ricerca-vuoto">{t('search.noResults')}</li>}
            {!testo.trim() && <li className="muted ricerca-vuoto">{t('search.prompt')}</li>}
          </ul>
          <div className="ricerca-dettaglio">
            {corrente && <Pannello key={corrente.oggetto} repo={repo} id={corrente.oggetto} onVai={onVai} />}
            {inCodice && <PannelloCodice key={`${inCodice.file}:${inCodice.riga}`} repo={repo} voce={inCodice} />}
          </div>
        </div>
      </div>
    </div>
  )
}
