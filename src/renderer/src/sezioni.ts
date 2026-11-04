import { t } from '../../shared/i18n.ts'

export type Sezione = { id: string; nome: string; icona: string; modulo?: string; claude?: boolean }

// Le sezioni di Hub. Quelle con un modulo compaiono solo nelle repo che lo hanno attivato.
export const SEZIONI: Sezione[] = [
  { id: 'home', get nome() { return t('nav.home') }, icona: 'M3 11l9-8 9 8M5 9.5V21h5v-6h4v6h5V9.5' },
  { id: 'avvio', get nome() { return t('nav.avvio') }, icona: 'M5 3l14 9-14 9z' },
  { id: 'todo', get nome() { return t('nav.todo') }, icona: 'M5 7l2 2 3-4M5 16l2 2 3-4M14 8h6M14 17h6' },
  { id: 'stato', get nome() { return t('nav.stato') }, icona: 'M3 12h4l3-7 4 14 3-7h4' },
  { id: 'branch', get nome() { return t('nav.branch') }, icona: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9' },
  { id: 'review', get nome() { return t('nav.review') }, icona: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4' },
  { id: 'claude', claude: true, get nome() { return t('nav.claude') }, icona: 'M4 6h16v10H10l-4 4v-4H4zM8 11h.01M12 11h.01M16 11h.01' },
  { id: 'anteprima', claude: true, get nome() { return t('nav.anteprima') }, icona: 'M9 3L3 6v15l6-3 6 3 6-3V3l-6 3zM9 3v15M15 6v15' },
  { id: 'social', get nome() { return t('nav.social') }, icona: 'M4 20V10M10 20V4M16 20v-7M21 20H3', modulo: 'social' }
]

export const sezioniDi = (attivi: ReadonlySet<string>): Sezione[] => SEZIONI.filter((s) => !s.modulo || attivi.has(s.modulo))

// Una sezione salvata può non esserci più in questa repo, o non esserci mai stata: in quel caso si riparte dalla prima.
export const sezioneValida = (id: unknown, attivi: ReadonlySet<string>): string => {
  const elenco = sezioniDi(attivi)
  return elenco.find((s) => s.id === id)?.id ?? elenco[0].id
}

// Di più richieste uguali conta solo l'ultima: una risposta in ritardo non deve sovrascriverne una più recente.
export function soloUltima<T>(): (p: Promise<T>, fatto: (v: T) => void, errore: (e: unknown) => void) => void {
  let ultima = 0
  return (p, fatto, errore) => {
    const mia = ++ultima
    p.then((v) => {
      if (mia === ultima) fatto(v)
    }, (e) => {
      if (mia === ultima) errore(e)
    })
  }
}
