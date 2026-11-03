export type Repo = { path: string; nome: string; manca: boolean }
export type RepoList = { repos: Repo[]; attiva: string | null }
export type Todo = { id: string; testo: string; fatta: boolean; creata: string }
export type FonteDoctor = { file: string; riga: number }
export type ComandoDoctor = { tipo: 'installa' | 'avvia' | 'test' | 'build' | 'altro'; comando: string; certezza: 'guida' | 'dichiarato' | 'ipotizzato'; fonte: FonteDoctor; nota?: string }
export type RefertoDoctor = {
  dallaGuida: ComandoDoctor[]
  parti: { cartella: string; stack: string[]; comandi: ComandoDoctor[]; variabili: { fonte: FonteDoctor; nomi: string[]; citate?: number }[]; servizi: { nome: string; fonte: FonteDoctor }[] }[]
  prerequisiti: { nome: string; perche: string; fonte: FonteDoctor; trovato: boolean | null }[]
  ci: ComandoDoctor[]
  guide: { titolo: string; fonte: FonteDoctor }[]
  nonEsaminati: number
}
export type Occorrenza = { file: string; riga: number; testo: string; tipo: 'definizione' | 'codice' | 'test' | 'documento'; nonTracciato?: boolean }
export type RisultatiCodice = { voci: Occorrenza[]; altri: number; parole?: string[]; esatte?: number }
export type BranoFile = { inizio: number; righe: string[]; totale: number }
export type DocTodo = { file: string; riga: number; testo: string; sezione?: string }
export type Worktree = { path: string; branch: string | null; head: string; modificati: number; nuovi: number; manca: boolean; errore: boolean }
export type Branch = {
  nome: string
  avanti: number
  indietro: number
  upstream: string | null
  upstreamAvanti: number
  upstreamIndietro: number
  upstreamSparito: boolean
  data: string
}
export type Subagent = { id: string; descrizione: string; tipo: string; attivo: boolean; attivita: number }
export type Session = { id: string; nome: string; cwd: string; stato: string; origine: string; aggiornata: number; subagenti: Subagent[] }
export type Contesto = { inizio: number; righe: string[] }
export type TrovatoHub = { oggetto: string; tipo: string; titolo: string }
export type DestinazioneOggetto = { t: 'commit'; hash: string } | { t: 'branch'; nome: string } | { t: 'funzione'; id: string } | { t: 'file'; percorso: string }
export type OggettoHub = { id: string; tipo: string; titolo: string; spiega: string | null; provenienza: { certezza: 'certo' | 'dedotto' | 'non-disponibile'; testo: string }; dati: [string, string][]; voci: { riga: number; testo: string; tipo: string }[]; legami: { altro: string; tipo: string; verso: string; titolo: string }[]; destinazione: DestinazioneOggetto | null; anteprima: Contesto | null; commitAnteprima: string | null; percorso: string | null }
export type VersioneLetta = { percorso: string; branch: string | null; commit: string | null; modifiche: number }
export type AnteprimaDati = {
  stato: { titolo: string; versione_id: string; autore: string; copertura: unknown; quando: number } | null
  aree: { id: string; nome: string; spiega: string }[]
  funzioni: { id: string; nome: string; spiega: string; area_id: string | null; citazione: string | null; citazione_valida: number | null; nonDisponibile: string | null }[]
  flussi: { id: string; funzione_id: string; titolo: string }[]
  commit: string | null
  versione: VersioneLetta
  segnalazioni: { id: string; tipo: string; testo: string; funzione: string | null }[]
  lavori: { id: string; titolo: string; stato: string; costo: number | null; durata: number | null; errore: string | null }[]
}
export type FlussoCompleto = {
  id: string
  titolo: string
  funzione: string
  commit: string | null
  versione: VersioneLetta
  superato: boolean
  passi: { id: string; passo: string; chiave: string; nome: string; spiega: string; da: string; a: string; file: string; riga: number | null; rigaCitata: number; inizio: number; stato: string; etichetta: 'citazione-trovata' | 'non-valido'; forseVecchia: boolean; segnalato: 'questa' | 'precedente' | null; motivoSegnalazione: string | null }[]
}
export type Status = { base: string | null; worktree: Worktree[]; branch: Branch[]; github: string | null; sessioni: Session[]; illeggibili: number }
export type Ref = { nome: string; tipo: 'locale' | 'remoto' | 'tag' | 'head' }
export type LogCommit = { hash: string; parents: string[]; refs: Ref[]; author: string; time: number; subject: string }
export type FileStat = { path: string; da: string | null; add: number | null; del: number | null }
export type CommitDetail = LogCommit & { body: string; files: FileStat[] }
export type BranchDetail = { commits: LogCommit[]; files: FileStat[] }
export type ChangedFile = { path: string; stato: string; da: string | null }
export type DiffResult = { testo: string; tagliato: boolean; binario: boolean; nuovo: boolean; cartella: boolean }
export type Decision = { scelta: 'allow' | 'allowSession' | 'deny'; risposte?: Record<string, string> }
export type RecentChat = { sessionId: string; cwd: string; titolo: string; quando: string }
export type SocialVideo = { social: string; url: string; testo: string; pubblicato: number | null; punti: { t: string; viste: number; like: number; commenti: number; condivisioni: number }[] }
export type SocialState = { ogniOre: number; brand: string | null; aggiornato: string | null; errore: string | null; video: SocialVideo[]; inCorso: boolean }

declare global {
  interface Window {
    hub: {
      lingua: {
        get(): Promise<'en' | 'it'>
        set(l: 'en' | 'it'): Promise<void>
      }
      repos: {
        list(): Promise<RepoList>
        add(): Promise<RepoList>
        select(repo: string): Promise<RepoList>
        remove(repo: string): Promise<RepoList>
      }
      todos: {
        watch(repo: string): Promise<void>
        list(repo: string): Promise<Todo[]>
        add(repo: string, testo: string): Promise<Todo[]>
        setDone(repo: string, id: string, fatta: boolean): Promise<Todo[]>
        setText(repo: string, id: string, testo: string): Promise<Todo[]>
        remove(repo: string, id: string): Promise<Todo[]>
        restore(repo: string, todo: Todo, index: number): Promise<Todo[]>
        onChange(fn: (repo: string) => void): () => void
      }
      docs: {
        list(repo: string): Promise<DocTodo[]>
        open(repo: string, file: string): Promise<void>
      }
      anteprima: {
        dati(repo: string): Promise<AnteprimaDati>
        flusso(repo: string, id: string): Promise<FlussoCompleto>
        contesto(repo: string, commit: string | null, file: string, riga: number): Promise<Contesto | null>
        segnala(repo: string, passo: string | null, testo: string): Promise<string>
      }
      ricavo: {
        livello(repo: string): Promise<{ titolo: string; commit: string; costo: number; secondi: number; correzioni: number; funzioni: number; errori: string[]; scoperte: string[]; documentiNonCoperti: string[] }>
        flusso(repo: string, funzione: string): Promise<{ trovata: boolean; commit: string; costo: number; secondi: number; correzioni: number; flusso?: string; motivo?: string; errori?: string[] }>
        dati(repo: string): Promise<{ stato: { titolo: string; versione_id: string; autore: string; copertura: unknown; quando: number } | null; aree: { id: string; nome: string; spiega: string }[]; funzioni: { id: string; nome: string; spiega: string; area_id: string | null; citazione: string | null; citazione_valida: number | null }[] }>
        statoFlusso(repo: string, flusso: string): Promise<{ versione: { percorso: string; branch: string | null; commit: string | null; modifiche: number }; riferimenti: { file: string; stato: string; riga: number | null; etichetta: 'citazione-trovata' | 'non-valido'; spiegazione: 'dedotta'; forseVecchia: boolean; fileModificato: boolean; versioneUguale: boolean }[] }>
      }
      lavori: {
        elenco(repo: string): Promise<{ id: string; titolo: string; stato: string; costo: number | null; durata: number | null; errore: string | null }[]>
        annulla(repo: string, id: string): Promise<void>
        onChange(fn: (repo: string, id: string, evento: string | null) => void): () => void
      }
      doctor: {
        visita(repo: string): Promise<RefertoDoctor>
      }
      codice: {
        cerca(repo: string, testo: string): Promise<RisultatiCodice>
        brano(repo: string, file: string, riga: number): Promise<BranoFile | null>
      }
      archivio: {
        apri(repo: string): Promise<{ file: number; commit: number; ref: number; worktree: number; voci: number; profilo: { tipo: string; linguaggi: Record<string, number>; framework: string[] } | null }>
        cerca(repo: string, testo: string): Promise<TrovatoHub[]>
        oggetto(repo: string, id: string): Promise<OggettoHub | null>
        aggiorna(repo: string): Promise<void>
        onChange(fn: (repo: string) => void): () => void
      }
      status: {
        read(repo: string): Promise<Status>
        watch(repo: string): Promise<void>
        unwatch(): Promise<void>
        onChange(fn: (repo: string) => void): () => void
      }
      chat: {
        send(repo: string, tab: string, cwd: string, resumeId: string | null, text: string): Promise<void>
        respond(tab: string, requestId: string, decision: Decision): Promise<void>
        stop(tab: string): Promise<void>
        close(tab: string): Promise<void>
        recent(repo: string): Promise<RecentChat[]>
        history(repo: string, cwd: string, sessionId: string): Promise<unknown[]>
        onEvent(fn: (tab: string, event: unknown) => void): () => void
        onEnd(fn: (tab: string, error: string | null) => void): () => void
      }
      git: {
        graph(repo: string, limit: number): Promise<LogCommit[]>
        commit(repo: string, hash: string): Promise<CommitDetail>
        commitDiff(repo: string, hash: string, file: string): Promise<DiffResult>
        branch(repo: string, name: string, base: string): Promise<BranchDetail>
        branchDiff(repo: string, name: string, base: string, file: string): Promise<DiffResult>
        worktreeChanges(repo: string, path: string): Promise<ChangedFile[]>
        worktreeDiff(repo: string, path: string, file: string): Promise<DiffResult>
      }
      moduli: {
        leggi(repo: string): Promise<{ social: { attivo: boolean; avd: string | null; istruzioni: string }; proposta: { avd: string | null; istruzioni: string }; datiVecchi: boolean }>
        attivaSocial(repo: string, avd: string, istruzioni: string): Promise<void>
        togliSocial(repo: string): Promise<void>
      }
      preferenze: {
        sezione(repo: string): Promise<string | null>
        scriviSezione(repo: string, id: string): Promise<void>
        visitaHome(repo: string): Promise<number | null>
      }
      social: {
        read(repo: string): Promise<SocialState>
        refresh(repo: string): Promise<void>
        setInterval(repo: string, ore: number): Promise<void>
        session(repo: string): Promise<string>
        onChange(fn: () => void): () => void
      }
      open: {
        vscode(repo: string, path: string): Promise<void>
        file(repo: string, file: string, riga?: number): Promise<void>
        terminal(repo: string, path: string): Promise<void>
        folder(repo: string, path: string): Promise<void>
        github(repo: string, branch: string | null): Promise<void>
      }
    }
  }
}
