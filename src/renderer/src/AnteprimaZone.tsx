import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../../shared/i18n.ts'
import { message } from './errors'
import type { AnteprimaDati, FlussoCompleto, Contesto } from './hub'
import { soloUltima } from './sezioni'

// Le misure del 3/11 stanno nei testi map.confirmLevel e map.confirmFlow: si cambiano lì quando ce ne sono di nuove, non si nascondono.
const breve = (commit: string | null): string => commit?.slice(0, 9) ?? t('map.none')

function Citazione({ repo, commit, file, riga, stato }: { repo: string; commit: string | null; file: string; riga: number; stato: string }) {
  const [c, setC] = useState<Contesto | null | undefined>(undefined)
  const [error, setError] = useState('')
  const apri = (): void => {
    if (c !== undefined) return setC(undefined)
    window.hub.anteprima.contesto(repo, commit, file, riga).then(setC, (e) => setError(message(e)))
  }
  return (
    <div className="ante-citazione">
      <button className="ghost small" aria-expanded={c !== undefined} onClick={apri}>{c !== undefined ? t('map.hideCode') : t('map.showCode')}</button>
      {error && <p className="error" role="alert">{error}</p>}
      {c === null && <p className="meta">{t('map.cannotShow')}</p>}
      {c && (
        <>
          <p className="meta"><code>{file}</code>{t('map.lineCommit', { line: riga })} <code>{breve(commit)}</code>{t('map.stateShows', { state: stato })}</p>
          <pre className="output ante-codice">{c.righe.map((t, i) => {
            const n = c.inizio + i
            return <span key={n} className={n === riga ? 'ante-riga' : undefined}>{String(n).padStart(5)}  {t}{'\n'}</span>
          })}</pre>
        </>
      )}
    </div>
  )
}

function Segnala({ etichetta, onInvia }: { etichetta: string; onInvia: (testo: string) => Promise<void> }) {
  const [aperto, setAperto] = useState(false)
  const [testo, setTesto] = useState('')
  const [fatto, setFatto] = useState(false)
  const [error, setError] = useState('')
  if (fatto) return <p className="meta">{t('map.reported')}</p>
  if (!aperto) return <button className="ghost small" onClick={() => setAperto(true)}>{etichetta}</button>
  return (
    <div className="ante-segnala">
      <label>
        {t('map.whatsWrong')}
        <textarea rows={2} value={testo} onChange={(e) => setTesto(e.target.value)} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="ghost small" disabled={!testo.trim()} onClick={() => onInvia(testo).then(() => setFatto(true), (e) => setError(message(e)))}>{t('map.saveReport')}</button>
    </div>
  )
}

export function Conferma({ testo, avvia, onAvvia }: { testo: string; avvia: string; onAvvia: () => void }) {
  const [chiede, setChiede] = useState(false)
  if (!chiede) return <button onClick={() => setChiede(true)}>{avvia}</button>
  return (
    <div className="frame ante-conferma">
      <p>{testo} {t('map.estimate')}</p>
      <div className="ante-azioni">
        <button onClick={() => { setChiede(false); onAvvia() }}>{t('map.run')}</button>
        <button className="ghost" onClick={() => setChiede(false)}>{t('map.notNow')}</button>
      </div>
    </div>
  )
}

function Flusso({ repo, id, onSegnalato }: { repo: string; id: string; onSegnalato: () => void }) {
  const [f, setF] = useState<FlussoCompleto | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    window.hub.anteprima.flusso(repo, id).then(setF, (e) => setError(message(e)))
  }, [repo, id])
  if (error) return <p className="error" role="alert">{error}</p>
  if (!f) return null
  return (
    <div className="ante-flusso">
      <h3>{f.titolo}</h3>
      <p className="meta">
        {t('map.derivedFrom')} <code>{breve(f.commit)}</code>{t('map.lookingAt')} <code>{f.versione.percorso}</code>, {f.versione.branch ?? t('map.noBranch')}, {t('map.commitWord')} <code>{breve(f.versione.commit)}</code>
        {f.versione.modifiche ? t('map.withChanges', { n: f.versione.modifiche }) : ''}.
      </p>
      {f.superato && <p className="warning">{t('map.staleFlow')}</p>}
      <ol className="ante-passi">
        {f.passi.map((p) => (
          <li key={p.id} className="row">
            <div className="row-main">
              <strong>{p.nome}</strong>
              <span className="pill">{t('map.pillInferred')}</span>
              <span className={p.etichetta === 'non-valido' ? 'pill bad' : 'pill'}>{p.etichetta === 'non-valido' ? t('map.pillInvalid') : t('map.pillFound')}</span>
              {p.forseVecchia && <span className="pill warn">{t('map.pillMaybeOld')}</span>}
              {p.segnalato === 'questa' && <span className="pill warn">{t('map.pillDisputed')}</span>}
              {p.segnalato === 'precedente' && <span className="pill warn">{t('map.pillDisputedBefore')}</span>}
            </div>
            <p className="ante-frase">{p.spiega}</p>
            {p.motivoSegnalazione && <p className="meta">{t('map.yourReport', { text: p.motivoSegnalazione })}</p>}
            <p className="meta">{t('map.fromTo', { from: p.da, to: p.a })}</p>
            <Citazione repo={repo} commit={f.commit} file={p.file} riga={p.rigaCitata} stato={p.etichetta === 'non-valido' ? t('map.citationInvalid') : t('map.citationFound')} />
            <Segnala etichetta={t('map.explanationWrong')} onInvia={async (testo) => {
              await window.hub.anteprima.segnala(repo, p.passo, testo)
              onSegnalato()
            }} />
          </li>
        ))}
      </ol>
    </div>
  )
}

export function AnteprimaZone({ repo, funzione: daAprire, onFunzione }: { repo: string; funzione?: string | null; onFunzione?: () => void }) {
  const [dati, setDati] = useState<AnteprimaDati | null>(null)
  const [scelta, setScelta] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [avviso, setAvviso] = useState('')
  // Vero dal clic su Avvia fino alla fine del lavoro: un secondo clic non deve spendere due volte.
  const [impegnato, setImpegnato] = useState(false)
  const carica = useRef(soloUltima<AnteprimaDati>()).current

  const load = useCallback(() => {
    carica(window.hub.anteprima.dati(repo), setDati, (e) => setError(message(e)))
  }, [repo, carica])

  useEffect(() => {
    if (!daAprire) return
    setScelta(daAprire)
    onFunzione?.()
  }, [daAprire, onFunzione])

  useEffect(() => {
    load()
    return window.hub.lavori.onChange((quale) => {
      if (quale === repo) load()
    })
  }, [load, repo])

  if (!dati) return error ? <p className="error" role="alert">{error}</p> : null

  const inCorso = dati.lavori.find((l) => l.stato === 'in-corso' || l.stato === 'in-coda')
  const lancia = (p: Promise<{ correzioni?: number; trovata?: boolean; motivo?: string }>): void => {
    setError('')
    setAvviso('')
    setImpegnato(true)
    p.then((r) => {
      if (r.trovata === false) setAvviso(t('map.notFound', { reason: r.motivo ?? '' }))
    }, (e) => {
      // Un lavoro annullato è una scelta, non un errore.
      if (!/annullato|cancel/i.test(message(e))) setError(message(e))
    }).finally(() => {
      setImpegnato(false)
      load()
    })
  }
  const funzione = dati.funzioni.find((f) => f.id === scelta) ?? null
  const flussi = funzione ? dati.flussi.filter((f) => f.funzione_id === funzione.id) : []
  const copertura = (dati.stato?.copertura ?? {}) as { scoperte?: string[]; documentiNonCoperti?: string[]; nonValidate?: string[] }

  return (
    <div className="anteprima">
      <div className="warning ante-limite" role="note">
        <strong>{t('map.limitTitle')}</strong> {t('map.limit')}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {avviso && <p className="warning">{avviso}</p>}

      {inCorso || impegnato ? (
        <div className="frame ante-lavoro">
          <p>{t('map.working')}{inCorso ? `: ${inCorso.titolo}` : ''}. {t('map.notBlocking')}</p>
          {inCorso && <button className="ghost" onClick={() => window.hub.lavori.annulla(repo, inCorso.id).then(load, (e) => setError(message(e)))}>{t('map.cancelJob')}</button>}
        </div>
      ) : (
        <Conferma key="mappa" testo={t('map.confirmLevel')} avvia={dati.stato ? t('map.rerunMap') : t('map.runMap')} onAvvia={() => { lancia(window.hub.ricavo.livello(repo)); setTimeout(load, 200) }} />
      )}

      {dati.stato && (
        <>
          <p className="meta">{t('map.derivedFromMap')} <code>{breve(dati.commit)}</code>{t('map.lookingAt')} <code>{dati.versione.branch ?? t('map.noBranch')}</code>, {t('map.commitWord')} <code>{breve(dati.versione.commit)}</code>.</p>
          {dati.commit !== dati.versione.commit && <p className="warning">{t('map.staleMap')}</p>}
          <p className="ante-titolo">{dati.stato.titolo} <span className="pill">{t('search.inferred')}</span></p>
          <div className="ante-griglia">
            <nav aria-label={t('map.nav')}>
              {dati.aree.map((a) => (
                <section key={a.id}>
                  <h3>{a.nome} <span className="pill">{t('map.pillInferredF')}</span></h3>
                  <p className="meta">{a.spiega}</p>
                  <ul>
                    {dati.funzioni.filter((f) => f.area_id === a.id).map((f) => (
                      <li key={f.id}>
                        <button className={f.id === scelta ? 'zone on' : 'zone'} aria-current={f.id === scelta ? 'true' : undefined} onClick={() => setScelta(f.id)}>
                          {f.nome}
                          {f.citazione_valida === 0 && <span className="pill bad">{t('map.notValidated')}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </nav>
            <div>
              {!funzione ? (
                <p className="muted">{t('map.pick')}</p>
              ) : (
                // La chiave chiude citazioni e conferme aperte quando si cambia funzione: restano legate a quella per cui sono nate.
                <div className="ante-dettaglio" key={funzione.id}>
                  <h2>{funzione.nome}</h2>
                  <p>{funzione.spiega}</p>
                  <p><span className="pill">{t('map.pillInferred')}</span> {funzione.citazione_valida === 0 && <span className="pill bad">{t('map.pillInvalid')}</span>}</p>
                  {funzione.citazione && <Citazione repo={repo} commit={dati.commit} file={funzione.citazione.split(':')[0]} riga={Number(funzione.citazione.split(':')[1]) || 1} stato={funzione.citazione_valida === 0 ? t('map.citationInvalid') : t('map.citationFound')} />}
                  {funzione.nonDisponibile && <p className="warning">{funzione.nonDisponibile}</p>}
                  {flussi.map((f) => <Flusso key={f.id} repo={repo} id={f.id} onSegnalato={load} />)}
                  {!inCorso && !impegnato && (
                    <Conferma testo={t('map.confirmFlow')} avvia={flussi.length ? t('map.rerunFlow') : t('map.runFlow')} onAvvia={() => { lancia(window.hub.ricavo.flusso(repo, funzione.id)); setTimeout(load, 200) }} />
                  )}
                </div>
              )}
            </div>
          </div>
          <section className="ante-mancanze">
            <h3>{t('map.mayBeMissing')}</h3>
            <p>{t('map.missingNote')}</p>
            {!!copertura.scoperte?.length && <p className="meta">{t('map.uncoveredFolders', { list: copertura.scoperte.join(', ') })}</p>}
            {!!copertura.documentiNonCoperti?.length && <p className="meta">{t('map.uncoveredDocs', { list: copertura.documentiNonCoperti.join('; ') })}</p>}
            {!!copertura.nonValidate?.length && <p className="meta">{t('map.invalidFunctions', { list: copertura.nonValidate.join(', ') })}</p>}
            <Segnala etichetta={t('map.functionMissing')} onInvia={async (testo) => {
              await window.hub.anteprima.segnala(repo, null, testo)
              load()
            }} />
          </section>
        </>
      )}

      {dati.segnalazioni.length > 0 && (
        <section className="ante-mancanze">
          <h3>{t('map.yourReports', { n: dati.segnalazioni.length })}</h3>
          <ul>
            {dati.segnalazioni.map((s) => <li key={s.id} className="meta">{s.tipo === 'mancante' ? t('map.reportMissing') : t('map.reportWrong')}{s.funzione ? `, ${s.funzione}` : ''}: {s.testo}</li>)}
          </ul>
          <p className="meta">{t('map.reportsNote')}</p>
        </section>
      )}
    </div>
  )
}
