import { useEffect, useState } from 'react'
import { t, type Chiave } from '../../shared/i18n.ts'
import { message } from './errors'
import type { ComandoDoctor, FonteDoctor, RefertoDoctor } from './hub'
import { PannelloCodice } from './Ricerca'

const PRINCIPALI = 6
const VARIABILI = 12

function Origine({ repo, fonte }: { repo: string; fonte: FonteDoctor }) {
  const [aperta, setAperta] = useState(false)
  return (
    <>
      <button className="link" aria-expanded={aperta} onClick={() => setAperta(!aperta)}>{fonte.file}:{fonte.riga}</button>
      {aperta && <div className="doctor-origine"><PannelloCodice repo={repo} voce={{ ...fonte, testo: '', tipo: 'codice' }} /></div>}
    </>
  )
}

function Comando({ repo, c }: { repo: string; c: ComandoDoctor }) {
  const [copiato, setCopiato] = useState(false)
  return (
    <li className="doctor-comando">
      <span className="pill">{t(`doctor.kind.${c.tipo}` as Chiave)}</span>
      <code>{c.comando}</code>
      <button className="ghost small" onClick={() => navigator.clipboard.writeText(c.comando).then(() => setCopiato(true))}>{copiato ? t('doctor.copied') : t('doctor.copy')}</button>
      <span className="meta doctor-fonte"><span className={c.certezza === 'ipotizzato' ? 'pill warn' : 'pill'}>{t(`doctor.certainty.${c.certezza}` as Chiave)}</span> <Origine repo={repo} fonte={c.fonte} />{c.nota && ` ${c.nota}`}</span>
    </li>
  )
}

export function DoctorZone({ repo }: { repo: string }) {
  const [r, setR] = useState<RefertoDoctor | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let valido = true
    window.hub.doctor.visita(repo).then((v) => {
      if (valido) setR(v)
    }, (e) => {
      if (valido) setError(message(e))
    })
    return () => {
      valido = false
    }
  }, [repo])
  if (error) return <p className="error" role="alert">{error}</p>
  if (!r) return <p className="muted">{t('doctor.reading')}</p>
  const mancanti = r.prerequisiti.filter((p) => p.trovato === false)
  return (
    <div className="doctor">
      <p className="meta">{t('doctor.intro')}</p>
      {!r.parti.length && <div className="empty frame"><p>{t('doctor.empty')}</p></div>}
      {r.dallaGuida.length > 0 && (
        <section>
          <h2>{t('doctor.guide.title')}</h2>
          <p className="meta">{t('doctor.guide.intro')}</p>
          <ul className="doctor-comandi">{r.dallaGuida.slice(0, PRINCIPALI * 2).map((c) => <Comando key={`${c.fonte.file}${c.fonte.riga}`} repo={repo} c={c} />)}</ul>
          {r.dallaGuida.length > PRINCIPALI * 2 && (
            <details className="doctor-altri">
              <summary>{t('doctor.moreCommands', { n: r.dallaGuida.length - PRINCIPALI * 2 })}</summary>
              <ul className="doctor-comandi">{r.dallaGuida.slice(PRINCIPALI * 2).map((c) => <Comando key={`${c.fonte.file}${c.fonte.riga}`} repo={repo} c={c} />)}</ul>
            </details>
          )}
        </section>
      )}
      {r.prerequisiti.length > 0 && (
        <section>
          <h2>{mancanti.length === 1 ? t('doctor.tools.missingOne', { total: r.prerequisiti.length }) : mancanti.length ? t('doctor.tools.missingMany', { n: mancanti.length, total: r.prerequisiti.length }) : t('doctor.tools.title')}</h2>
          <ul className="doctor-strumenti">
            {r.prerequisiti.map((p) => <li key={p.nome}><span className={p.trovato ? 'pill' : 'pill warn'}>{p.trovato ? t('doctor.tools.found') : t('doctor.tools.notFound')}</span> <code>{p.nome}</code> <span className="meta">{p.perche}</span></li>)}
          </ul>
          <p className="meta">{t('doctor.tools.note')}</p>
        </section>
      )}
      {r.parti.map((p) => (
        <section key={p.cartella || '.'}>
          <h2>{p.cartella || t('doctor.root')}</h2>
          <p className="doctor-pila">{p.stack.map((s) => <span key={s} className="pill">{s}</span>)}</p>
          {p.comandi.length > 0 && <ul className="doctor-comandi">{p.comandi.slice(0, PRINCIPALI).map((c) => <Comando key={`${c.tipo}${c.comando}`} repo={repo} c={c} />)}</ul>}
          {p.comandi.length > PRINCIPALI && (
            <details className="doctor-altri">
              <summary>{t('doctor.moreCommands', { n: p.comandi.length - PRINCIPALI })}</summary>
              <ul className="doctor-comandi">{p.comandi.slice(PRINCIPALI).map((c) => <Comando key={`${c.tipo}${c.comando}`} repo={repo} c={c} />)}</ul>
            </details>
          )}
          {p.servizi.length > 0 && <p className="meta">{t('doctor.services', { list: p.servizi.map((s) => s.nome).join(', ') })}</p>}
          {p.variabili.map((v) => {
            const prime = v.citate || VARIABILI
            return (
              <div key={v.fonte.file}>
                <p className="meta">{t('doctor.configure')} <Origine repo={repo} fonte={v.fonte} />: {v.nomi.slice(0, prime).join(', ')}.</p>
                {v.nomi.length > prime && <details className="doctor-altri"><summary>{t('doctor.moreVariables', { n: v.nomi.length - prime })}</summary><p className="meta">{v.nomi.slice(prime).join(', ')}.</p></details>}
              </div>
            )
          })}
        </section>
      ))}
      {r.nonEsaminati > 0 && <p className="meta">{t('doctor.hiddenFolders', { n: r.nonEsaminati })}</p>}
      {r.ci.length > 0 && (
        <section>
          <h2>{t('doctor.ci.title')}</h2>
          <p className="meta">{t('doctor.ci.note')}</p>
          <ul className="doctor-comandi">{r.ci.map((c) => <Comando key={`${c.fonte.file}${c.fonte.riga}`} repo={repo} c={c} />)}</ul>
        </section>
      )}
      {r.guide.length > 0 && (
        <section>
          <h2>{t('doctor.guides.title')}</h2>
          <ul className="doctor-strumenti">{r.guide.map((g) => <li key={`${g.fonte.file}${g.fonte.riga}`}>{g.titolo} <span className="meta"><Origine repo={repo} fonte={g.fonte} /></span></li>)}</ul>
        </section>
      )}
    </div>
  )
}
