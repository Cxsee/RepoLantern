import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { t } from '../shared/i18n.ts'

const MAX_ISTRUZIONI = 8000
const NOME_AVD = /^[\w.-]{1,100}$/
// ponytail: riconosce solo i segreti scritti come "password: valore"; basta contro l'incolla distratto, non è una garanzia.
const SEGRETO_SCRITTO = /(password|passwd|token|api[ _-]?key|secret)\s*[:=]\s*\S/i

export type ConfigSocial = { attivo: boolean; avd: string | null; istruzioni: string }
export type Modulo = { id: string; nome: string; fonte: string; permessi: string[] }

// Un modulo appartiene a una repo: Hub funziona uguale senza, e toglierlo non cancella i suoi dati.
export const MODULI: Modulo[] = [
  { id: 'social', nome: 'Social', fonte: 'Metricool, attraverso Claude Code', permessi: ['Legge i numeri dei video', 'Nella sessione guidata apre browser ed emulatore, con la tua conferma prima di ogni azione'] }
]

export const SOCIAL_VUOTO: ConfigSocial = { attivo: false, avd: null, istruzioni: '' }

export function validaSocial(avd: unknown, istruzioni: unknown): { avd: string | null; istruzioni: string } {
  const nome = typeof avd === 'string' ? avd.trim() : ''
  if (nome && !NOME_AVD.test(nome)) throw new Error(t('modules.avdName'))
  const testo = typeof istruzioni === 'string' ? istruzioni.trim() : ''
  if (testo.length > MAX_ISTRUZIONI) throw new Error(t('modules.tooLong'))
  if (SEGRETO_SCRITTO.test(testo)) throw new Error(t('modules.noSecrets'))
  return { avd: nome || null, istruzioni: testo }
}

// Una proposta scritta nella repo: si mostra a chi attiva il modulo, non vale finché non conferma.
export async function propostaSocial(repo: string): Promise<{ avd: string | null; istruzioni: string }> {
  try {
    const d = JSON.parse(await readFile(join(repo, '.hub', 'social.json'), 'utf8'))
    return validaSocial(d?.avd, d?.istruzioni)
  } catch {
    return { avd: null, istruzioni: '' }
  }
}

// Le versioni precedenti tenevano un solo file per tutta Hub: va alla prima repo che attiva Social e non viene toccato, perché la versione installata lo usa ancora.
const segno = (vecchio: string): string => `${vecchio}.importato`
const esiste = (file: string): Promise<boolean> => stat(file).then(() => true, () => false)

const destinatario = (vecchio: string): Promise<string | null> => readFile(segno(vecchio), 'utf8').catch(() => null)

export async function datiVecchiDisponibili(vecchio: string, nuovo: string): Promise<boolean> {
  if (!(await esiste(vecchio)) || (await esiste(nuovo))) return false
  const gia = await destinatario(vecchio)
  return gia === null || gia === nuovo
}

// Il segno si prende per primo e in esclusiva: una sola repo può avere quei dati. Se la copia si interrompe, la stessa repo può riprovare.
export async function importaDatiVecchi(vecchio: string, nuovo: string): Promise<void> {
  if (!(await datiVecchiDisponibili(vecchio, nuovo))) return
  await writeFile(segno(vecchio), nuovo, { flag: 'wx' }).catch(() => {})
  if ((await destinatario(vecchio)) !== nuovo) return
  const parziale = `${nuovo}.importazione`
  await copyFile(vecchio, parziale)
  await rename(parziale, nuovo)
}

// Vale solo l'ultima pianificazione: una più vecchia, arrivata in ritardo, non può lasciare un timer attivo.
// Prima di partire si ricontrolla, perché nel frattempo la repo può essere cambiata o il modulo tolto.
export class Pianificatore {
  private giro = 0
  private timer: NodeJS.Timeout | undefined

  async pianifica(calcola: () => Promise<{ repo: string; attesa: number } | null>, esegui: (repo: string) => void): Promise<void> {
    clearTimeout(this.timer)
    const mio = ++this.giro
    const piano = await calcola()
    if (mio !== this.giro || !piano) return
    this.timer = setTimeout(() => {
      void calcola().then((ora) => {
        if (mio === this.giro && ora?.repo === piano.repo) esegui(piano.repo)
      }, () => {})
    }, piano.attesa)
  }

  ferma(): void {
    this.giro++
    clearTimeout(this.timer)
  }
}
