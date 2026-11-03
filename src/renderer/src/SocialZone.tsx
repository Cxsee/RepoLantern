import { useCallback, useEffect, useState } from 'react'
import { locale, t } from '../../shared/i18n.ts'
import { message } from './errors'
import type { SocialState, SocialVideo } from './hub'

const SOCIAL = [['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['instagram', 'Instagram']] as const
const INTERVALLI = [1, 3, 6, 12, 24]
const NUMERI = [['viste', 'social.views'], ['like', 'social.likes'], ['commenti', 'social.comments'], ['condivisioni', 'social.shares']] as const

const when = (value: string | number): string => new Date(value).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' })
const count = (n: number): string => n.toLocaleString(locale())

function Trend({ video }: { video: SocialVideo }) {
  const viste = video.punti.map((p) => p.viste)
  if (viste.length < 2) return <span className="muted">-</span>
  const [min, max] = [Math.min(...viste), Math.max(...viste)]
  const points = viste.map((v, i) => `${(i / (viste.length - 1)) * 80},${18 - ((v - min) / (max - min || 1)) * 16}`).join(' ')
  return <svg className="trend" viewBox="0 0 80 20" role="img" aria-label={t('social.trendLabel', { from: count(viste[0]), to: count(viste[viste.length - 1]) })}><polyline points={points} /></svg>
}

export function AttivaSocial({ repo, onDone }: { repo: string; onDone: () => void }) {
  const [avd, setAvd] = useState('')
  const [istruzioni, setIstruzioni] = useState('')
  const [datiVecchi, setDatiVecchi] = useState(false)
  const [pronto, setPronto] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    window.hub.moduli.leggi(repo).then((m) => {
      setAvd(m.social.avd ?? m.proposta.avd ?? '')
      setIstruzioni(m.social.istruzioni || m.proposta.istruzioni)
      setDatiVecchi(m.datiVecchi)
      setPronto(true)
    }, (e) => setError(message(e)))
  }, [repo])

  const attiva = (): void => {
    setError('')
    window.hub.moduli.attivaSocial(repo, avd, istruzioni).then(onDone, (e) => setError(message(e)))
  }

  return (
    <div className="frame attiva-modulo">
      <p>{t('social.intro')}</p>
      {datiVecchi && <p className="muted">{t('social.oldData')}</p>}
      <label>
        {t('social.emulator')}
        <input disabled={!pronto} value={avd} onChange={(e) => setAvd(e.target.value)} placeholder={t('social.emulatorPlaceholder')} />
      </label>
      <label>
        {t('social.instructions')}
        <textarea disabled={!pronto} rows={7} value={istruzioni} onChange={(e) => setIstruzioni(e.target.value)} placeholder={t('social.instructionsPlaceholder')} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button disabled={!pronto} onClick={attiva}>{t('social.activate')}</button>
    </div>
  )
}

export function SocialZone({ repo, onSession, onRemove }: { repo: string; onSession: (testo: string) => void; onRemove: () => void }) {
  const [data, setData] = useState<SocialState | null>(null)
  const [social, setSocial] = useState<string>('tiktok')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    window.hub.social.read(repo).then(setData, (e) => setError(message(e)))
  }, [repo])

  useEffect(() => {
    load()
    return window.hub.social.onChange(load)
  }, [load])

  if (!data) return null

  const act = (p: Promise<unknown>): void => {
    setError('')
    p.then(load, (e) => setError(message(e)))
  }
  const session = (): void => {
    setError('')
    window.hub.social.session(repo).then(onSession, (e) => setError(message(e)))
  }

  const video = data.video.filter((v) => v.social === social).sort((a, b) => (b.pubblicato ?? 0) - (a.pubblicato ?? 0))
  const total = (key: (typeof NUMERI)[number][0]): number => video.reduce((sum, v) => sum + (v.punti[v.punti.length - 1]?.[key] ?? 0), 0)
  const shown = data.errore || error

  return (
    <div className="social">
      <div className="social-bar">
        <button onClick={session}>{t('social.startSession')}</button>
        <button className="ghost" disabled={data.inCorso} onClick={() => act(window.hub.social.refresh(repo))}>
          {data.inCorso ? t('social.updating') : data.brand ? t('social.updateNow') : t('social.connect')}
        </button>
        <label className="social-every">
          {t('social.every')}
          <select value={data.ogniOre} onChange={(e) => act(window.hub.social.setInterval(repo, Number(e.target.value)))}>
            {INTERVALLI.map((n) => <option key={n} value={n}>{n === 1 ? t('social.oneHour') : t('social.hours', { n })}</option>)}
          </select>
        </label>
        <button className="ghost small" onClick={() => window.hub.moduli.togliSocial(repo).then(onRemove, (e) => setError(message(e)))}>{t('social.remove')}</button>
      </div>
      <p className="muted social-note">
        {data.aggiornato ? `${t('social.dataAt', { when: when(data.aggiornato) })} ` : ''}
        {t('social.note')}
      </p>
      {shown && <p className="error" role="alert">{shown}</p>}

      {!data.brand ? (
        <div className="empty frame"><p>{t('social.connectFirst')}</p></div>
      ) : (
        <>
          <div className="social-tabs" role="group" aria-label={t('nav.social')}>
            {SOCIAL.map(([id, nome]) => <button key={id} className={id === social ? 'ghost on' : 'ghost'} aria-pressed={id === social} onClick={() => setSocial(id)}>{nome}</button>)}
          </div>
          <dl className="readouts">
            {NUMERI.map(([key, nome]) => <div key={key} className="readout frame"><dt>{t(nome)}</dt><dd>{count(total(key))}</dd></div>)}
          </dl>
          {video.length === 0 ? (
            <div className="empty frame"><p>{t('social.noVideos')}</p></div>
          ) : (
            <div className="social-table frame">
              <table>
                <thead>
                  <tr><th>{t('social.colVideo')}</th><th>{t('social.colOut')}</th>{NUMERI.map(([key, nome]) => <th key={key} className="num">{t(nome)}</th>)}<th>{t('social.colTrend')}</th></tr>
                </thead>
                <tbody>
                  {video.map((v) => {
                    const last = v.punti[v.punti.length - 1]
                    const before = v.punti[v.punti.length - 2]
                    return (
                      <tr key={v.url}>
                        <td className="social-text"><a href={v.url} target="_blank" rel="noreferrer" title={v.testo}>{v.testo || v.url}</a></td>
                        <td className="social-date">{v.pubblicato ? when(v.pubblicato) : '-'}</td>
                        {NUMERI.map(([key]) => (
                          <td key={key} className="num">
                            {count(last?.[key] ?? 0)}
                            {before && last[key] > before[key] && <span className="social-delta"> +{count(last[key] - before[key])}</span>}
                          </td>
                        ))}
                        <td><Trend video={v} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
