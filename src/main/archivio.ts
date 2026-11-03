import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { locale, t } from '../shared/i18n.ts'
import { parseStatus, readGraph } from './gitnav.ts'
import { dentroLaRepo, frameworkDi, git, isDocumento, kindOf, leggiAlbero, leggiManifesti, leggiTesto, leggiVociCodice, linguaggioDi, SEGRETO, titoloDi, type Tipo } from './scansione.ts'
import { readStatus } from './status.ts'
import { parseMarkdownTodos } from './todo.ts'

const PREFISSI: Record<string, string> = { attivita: 'attivita', funzione: 'funzione', worktree: 'worktree', commit: 'commit_git', sessione: 'sessione', area: 'area', nodo: 'nodo' }

const pulisciLegami = (t: string): string => `create trigger ${t}_legami after delete on ${t} begin delete from legami where da = old.id or a = old.id; end;`
const pulisciProvenienza = (t: string): string => `create trigger ${t}_provenienza after delete on ${t} begin delete from provenienza where oggetto = old.id; end;`
const SCHEMA_DEDOTTO = ['funzione', 'flusso', 'passo']

// Ogni migrazione gira in una transazione. Non si cambia una migrazione già pubblicata: se ne aggiunge una.
export const MIGRAZIONI = [
  `
create table versione (id text primary key, commit_hash text, impronta text, modifiche integer not null);
create table commit_git (id text primary key, hash text not null unique, tempo integer not null, titolo text not null);
create table ref_git (nome text not null, tipo text not null, commit_id text not null references commit_git(id) on delete cascade, primary key (nome, tipo));
create table worktree (id text primary key, percorso text not null unique, branch text, testa text not null, modificati integer not null, nuovi integer not null);
create table attivita (id text primary key, titolo text not null);
create table funzione (id text primary key, nome text not null, spiega text not null, versione_id text not null references versione(id));
create table flusso (id text primary key, funzione_id text not null references funzione(id) on delete cascade, titolo text not null);
create table passo (id text primary key, flusso_id text not null references flusso(id) on delete cascade, ordine integer not null, nome text not null, spiega text not null, certezza text not null check (certezza in ('verificato','dedotto')));
create table riferimento (id text primary key, passo_id text not null references passo(id) on delete cascade, versione_id text not null references versione(id), file text not null, riga integer not null, inizio integer not null, brano text not null);
create table tipo_legame (nome text primary key, da text not null, a text not null);
insert into tipo_legame values ('riguarda', 'attivita', 'funzione'), ('lavora_su', 'attivita', 'worktree'), ('nata_da', 'funzione', 'commit');
create table legami (da text not null, a text not null, tipo text not null references tipo_legame(nome), fonte text not null, certezza text not null, primary key (da, a, tipo));
create index legami_a on legami(a);
${['attivita', 'funzione', 'worktree', 'commit_git'].map(pulisciLegami).join('\n')}
`,
  `
create table workspace (id text primary key check (id = 'workspace'), percorso text not null, nome text not null);
create table area (id text primary key, nome text not null, spiega text not null);
alter table funzione add column area_id text references area(id) on delete set null;
create table nodo (id text primary key, flusso_id text not null references flusso(id) on delete cascade, chiave text not null, zona text not null, kind text not null check (kind in ('schermata','servizio','dati','esterno')), nome text not null, tec text not null, unique (flusso_id, chiave));
alter table passo add column da_nodo text references nodo(id) on delete cascade;
alter table passo add column a_nodo text references nodo(id) on delete cascade;
alter table passo add column tipo text check (tipo in ('dati','nav','dip'));
create table sessione (id text primary key, claude_id text, titolo text not null, worktree_id text references worktree(id) on delete set null);
create table provenienza (oggetto text primary key, fonte text not null, certezza text not null check (certezza in ('verificato','dedotto','non-disponibile')), versione_id text not null references versione(id), autore text not null);
create index funzione_area on funzione(area_id);
insert into provenienza select id, 'deduzione', 'dedotto', versione_id, 'sconosciuto' from funzione;
insert into provenienza select f.id, 'deduzione', 'dedotto', z.versione_id, 'sconosciuto' from flusso f join funzione z on z.id = f.funzione_id;
insert into provenienza select p.id, 'deduzione', 'dedotto', z.versione_id, 'sconosciuto' from passo p join flusso f on f.id = p.flusso_id join funzione z on z.id = f.funzione_id;
insert into tipo_legame values ('portata_avanti_in', 'attivita', 'sessione'), ('rappresenta', 'nodo', 'funzione');
${['sessione', 'area', 'nodo'].map(pulisciLegami).join('\n')}
${[...SCHEMA_DEDOTTO, 'area', 'nodo'].map(pulisciProvenienza).join('\n')}
`,
  `
create table file (percorso text primary key, firma text not null, linguaggio text, titolo text);
create table voce (file text not null, riga integer not null, testo text not null, tipo text not null check (tipo in ('documento','codice')));
create index voce_file on voce(file);
create table profilo (id text primary key check (id = 'profilo'), tipo text not null, linguaggi text not null, framework text not null);
create virtual table ricerca using fts5(oggetto unindexed, tipo unindexed, titolo, testo, tokenize = 'unicode61 remove_diacritics 2');
${[['funzione', 'funzione', 'new.id', 'new.nome', 'new.spiega', 'old.id'], ['attivita', 'attivita', 'new.id', 'new.titolo', "''", 'old.id'], ['commit_git', 'commit', 'new.id', 'new.titolo', 'new.hash', 'old.id'], ['file', 'file', "'file:' || new.percorso", 'new.percorso', "coalesce(new.titolo, '')", "'file:' || old.percorso"]]
  .map(([t, tipo, id, titolo, testo, vecchio]) => `create trigger ${t}_ricerca_nuovo after insert on ${t} begin insert into ricerca (oggetto, tipo, titolo, testo) values (${id}, '${tipo}', ${titolo}, ${testo}); end;
create trigger ${t}_ricerca_via after delete on ${t} begin delete from ricerca where oggetto = ${vecchio}; end;`).join('\n')}
insert into ricerca (oggetto, tipo, titolo, testo) select id, 'funzione', nome, spiega from funzione;
insert into ricerca (oggetto, tipo, titolo, testo) select id, 'attivita', titolo, '' from attivita;
insert into ricerca (oggetto, tipo, titolo, testo) select id, 'commit', titolo, hash from commit_git;
`,
  `
create table lavoro (id text primary key, titolo text not null, prompt text not null, modello text not null, tempo_massimo integer not null, stato text not null check (stato in ('in-coda','in-corso','finito','errore','annullato','interrotto','scaduto')), creato integer not null, inizio integer, fine integer, durata integer, pid integer, pid_avvio integer, commit_hash text, esito text, errore text, costo real, turni integer, token_entrata integer, token_uscita integer);
`,
  `
alter table funzione add column citazione text;
alter table funzione add column citazione_valida integer;
alter table riferimento add column rotto integer not null default 0;
create table preferenza (chiave text primary key, valore text not null);
create table stato_mappa (id text primary key check (id = 'mappa'), titolo text not null, versione_id text not null references versione(id), autore text not null, copertura text not null, quando integer not null);
`,
  `
create table segnalazione (id text primary key, tipo text not null check (tipo in ('spiegazione','mancante')), testo text not null, chiave text, funzione text, frase text, file text, commit_hash text, stato text not null default 'da-rivedere' check (stato in ('da-rivedere','confermata','respinta')), quando integer not null);
create index segnalazione_chiave on segnalazione(chiave);
`
]

export type Riferimento = { f: string; l: number; s: number; righe: string[] }
export type Controllo = { stato: 'valido' | 'spostato' | 'non-valido'; riga: number | null }
export type Versione = { percorso: string; branch: string | null; commit: string | null; impronta: string | null; modifiche: number }
// L'etichetta dice solo se il brano citato c'è. Che il brano provi la spiegazione nessun controllo lo sa: la spiegazione resta dedotta.
export type StatoRiferimento = Controllo & { id: string; passo: string; file: string; fileModificato: boolean; versioneUguale: boolean; forseVecchia: boolean; etichetta: 'citazione-trovata' | 'non-valido'; spiegazione: 'dedotta' }
export type Legame = { altro: string; tipo: string; verso: 'uscente' | 'entrante'; fonte: string; certezza: string }
export type Lavoro = { id: string; titolo: string; prompt: string; modello: string; tempo_massimo: number; stato: 'in-coda' | 'in-corso' | 'finito' | 'errore' | 'annullato' | 'interrotto' | 'scaduto'; creato: number; inizio: number | null; fine: number | null; durata: number | null; pid: number | null; pid_avvio: number | null; commit_hash: string | null; esito: string | null; errore: string | null; costo: number | null; turni: number | null; token_entrata: number | null; token_uscita: number | null }
export type FunzioneMappa = { id: string; nome: string; spiega: string; area_id: string | null; citazione: string | null; citazione_valida: number | null }
export type AreaMappa = { id: string; nome: string; spiega: string }
export type StatoMappa = { titolo: string; versione_id: string; autore: string; copertura: unknown; quando: number }
type LivelloDati = { titolo: string; aree: { nome: string; spiega: string; funzioni: { nome: string; spiega: string; fonte: { testo: string } }[] }[] }
export type Segnalazione = { id: string; tipo: 'spiegazione' | 'mancante'; testo: string; chiave: string | null; funzione: string | null; frase: string | null; file: string | null; commit_hash: string | null; stato: string; quando: number }
export type PassoCompleto = StatoRiferimento & { chiave: string; nome: string; spiega: string; tipo: string | null; da: string; a: string; inizio: number; rigaCitata: number; segnalato: 'questa' | 'precedente' | null; motivoSegnalazione: string | null }
export type FlussoCompleto = { id: string; titolo: string; funzione: string; commit: string | null; versione: Omit<Versione, 'impronta'>; superato: boolean; passi: PassoCompleto[] }
export type DestinazioneOggetto = { t: 'commit'; hash: string } | { t: 'branch'; nome: string } | { t: 'funzione'; id: string } | { t: 'file'; percorso: string }
// Cos'è un elemento, da dove viene e dove si apre: solo ciò che l'archivio sa davvero.
export type OggettoHub = { id: string; tipo: string; titolo: string; spiega: string | null; provenienza: { certezza: 'certo' | 'dedotto' | 'non-disponibile'; testo: string }; dati: [string, string][]; voci: { riga: number; testo: string; tipo: string }[]; legami: (Legame & { titolo: string })[]; destinazione: DestinazioneOggetto | null; percorso: string | null }
export type Trovato = { oggetto: string; tipo: string; titolo: string }
export type Riepilogo = { file: number; commit: number; ref: number; worktree: number; voci: number; profilo: { tipo: Tipo; linguaggi: Record<string, number>; framework: string[] } | null }
export type Provenienza = { fonte: string; certezza: string; versione_id: string; autore: string }
type FlussoDati = {
  titolo: string
  nodi: { id: string; zona: string; kind: string; nome: string; tec: string }[]
  passi: { da: string; a: string; tipo: string; nome: string; spiega: string; fonte: { certezza: 'verificato' | 'dedotto' }; ref: Riferimento; rotto?: boolean }[]
}

// Il controllo non usa AI: il brano citato c'è ancora in quel punto, si è spostato o non c'è più.
export function controllaBrano(testo: string, r: Pick<Riferimento, 'l' | 's' | 'righe'>): Controllo {
  const n = r.righe.length
  if (!n || r.l < r.s || r.l >= r.s + n) return { stato: 'non-valido', riga: null }
  const righe = testo.replace(/\r\n/g, '\n').split('\n')
  const qui = (da: number): boolean => r.righe.every((t, k) => righe[da + k] === t)
  if (qui(r.s - 1)) return { stato: 'valido', riga: r.l }
  // Un brano che compare più volte non dice quale sia quello giusto.
  const trovati: number[] = []
  for (let j = 0; j + n <= righe.length; j++) if (qui(j)) trovati.push(j)
  return trovati.length === 1 ? { stato: 'spostato', riga: r.l + trovati[0] + 1 - r.s } : { stato: 'non-valido', riga: null }
}

// L'impronta dice qual è il codice, quindi guarda il contenuto: dimensione e data possono coincidere su due stati diversi.
// È costosa su una repo con molti file non committati, perciò si calcola solo quando serve identificare una versione.
async function improntaDi(percorso: string, cambiati: { path: string; stato: string }[]): Promise<string | null> {
  if (!cambiati.length) return null
  const hash = createHash('sha256')
  for (const { path, stato } of [...cambiati].sort((x, y) => x.path.localeCompare(y.path))) {
    const dove = join(percorso, path)
    const info = await lstat(dove).catch(() => null)
    hash.update(`${stato}|${path}|`)
    if (info?.isSymbolicLink()) hash.update(await readlink(dove))
    else if (info?.isFile()) for await (const pezzo of createReadStream(dove)) hash.update(pezzo as Buffer)
    hash.update('|')
  }
  return hash.digest('hex').slice(0, 16)
}

const statoGit = (percorso: string): Promise<{ path: string; stato: string }[]> => git(percorso, 'status', '--porcelain', '-z', '-uall').then(parseStatus)

// Dove si legge e com'è messa, senza leggere il contenuto: basta per mostrarlo.
export async function statoVersione(percorso: string): Promise<Omit<Versione, 'impronta'>> {
  const [commit, branch, cambiati] = await Promise.all([
    git(percorso, 'rev-parse', '--verify', '--quiet', 'HEAD').then((s) => s.trim(), () => null),
    git(percorso, 'symbolic-ref', '--short', '--quiet', 'HEAD').then((s) => s.trim(), () => null),
    statoGit(percorso)
  ])
  return { percorso, branch, commit, modifiche: new Set(cambiati.map((c) => c.path)).size }
}

export async function leggiVersione(percorso: string): Promise<Versione> {
  const [stato, cambiati] = await Promise.all([statoVersione(percorso), statoGit(percorso)])
  return { ...stato, impronta: await improntaDi(percorso, cambiati) }
}

// La versione è il codice, non il posto: due worktree con lo stesso contenuto sono la stessa versione, due stati dello stesso worktree no.
const idVersione = (v: Pick<Versione, 'commit' | 'impronta'>): string => `versione:${v.commit ?? 'vuota'}:${v.impronta ?? 'pulita'}`

export class Archivio {
  private db: DatabaseSync

  constructor(file: string, migrazioni: string[] = MIGRAZIONI) {
    this.db = new DatabaseSync(file, { enableForeignKeyConstraints: true })
    try {
      const da = Number(this.db.prepare('pragma user_version').get()?.user_version)
      if (da > migrazioni.length) throw new Error(t('arch.newer'))
      for (let i = da; i < migrazioni.length; i++) {
        this.transazione(() => {
          this.db.exec(migrazioni[i])
          this.db.exec(`pragma user_version = ${i + 1}`)
        })
      }
    } catch (e) {
      this.db.close()
      throw e
    }
  }

  close(): void {
    this.db.close()
  }

  private transazione<T>(fare: () => T): T {
    this.db.exec('begin')
    try {
      const esito = fare()
      this.db.exec('commit')
      return esito
    } catch (e) {
      this.db.exec('rollback')
      throw e
    }
  }

  async aggiornaDaGit(repo: string, limite = 5000): Promise<{ commit: number; ref: number; worktree: number }> {
    const [commits, stato] = await Promise.all([readGraph(repo, limite), readStatus(repo)])
    return this.transazione(() => {
      const c = this.db.prepare('insert or ignore into commit_git (id, hash, tempo, titolo) values (?, ?, ?, ?)')
      const r = this.db.prepare('insert or replace into ref_git (nome, tipo, commit_id) values (?, ?, ?)')
      const w = this.db.prepare('insert into worktree (id, percorso, branch, testa, modificati, nuovi) values (?, ?, ?, ?, ?, ?) on conflict(id) do update set branch = excluded.branch, testa = excluded.testa, modificati = excluded.modificati, nuovi = excluded.nuovi')
      this.db.exec('delete from ref_git')
      for (const k of commits) c.run(`commit:${k.hash}`, k.hash, k.time, k.subject)
      for (const k of commits) for (const x of k.refs) r.run(x.nome, x.tipo, `commit:${k.hash}`)
      // Un worktree sparito perde anche i suoi legami, gli altri li conservano.
      const vivi = new Set(stato.worktree.map((x) => `worktree:${x.path}`))
      for (const x of this.db.prepare('select id from worktree').all() as { id: string }[]) if (!vivi.has(x.id)) this.db.prepare('delete from worktree where id = ?').run(x.id)
      for (const x of stato.worktree) w.run(`worktree:${x.path}`, x.path, x.branch, x.head, x.modificati, x.nuovi)
      // Dopo un rebase i commit vecchi non devono più comparire. Se la lista è tagliata non si può sapere quali siano spariti.
      if (commits.length < limite) {
        const presenti = new Set(commits.map((k) => `commit:${k.hash}`))
        for (const x of this.db.prepare('select id from commit_git').all() as { id: string }[]) if (!presenti.has(x.id)) this.db.prepare('delete from commit_git where id = ?').run(x.id)
      }
      this.db.exec("delete from ricerca where tipo = 'ref'")
      for (const x of this.db.prepare('select nome, tipo from ref_git').all() as { nome: string; tipo: string }[]) this.db.prepare("insert into ricerca (oggetto, tipo, titolo, testo) values (?, 'ref', ?, ?)").run(`ref:${x.tipo}:${x.nome}`, x.nome, x.tipo)
      return { commit: this.conta('commit_git'), ref: this.conta('ref_git'), worktree: this.conta('worktree') }
    })
  }

  // Rilegge solo i documenti cambiati. Le voci nel codice si ricalcolano se è cambiato qualcosa: git grep è già veloce.
  async aggiornaFile(repo: string): Promise<{ file: number; cambiati: number; documentiLetti: number }> {
    const albero = await leggiAlbero(repo)
    const noti = new Map((this.db.prepare('select percorso, firma from file').all() as { percorso: string; firma: string }[]).map((f) => [f.percorso, f.firma]))
    const daRifare = [...albero].filter(([f, firma]) => noti.get(f) !== firma)
    const spariti = [...noti.keys()].filter((f) => !albero.has(f))
    if (!daRifare.length && !spariti.length) return { file: albero.size, cambiati: 0, documentiLetti: 0 }

    const documenti = new Map<string, string | null>()
    await Promise.all(daRifare.filter(([f]) => isDocumento(f)).map(async ([f]) => void documenti.set(f, await leggiTesto(repo, f))))
    const elenco = [...albero.keys()]
    const [codice, manifesti] = await Promise.all([leggiVociCodice(repo), leggiManifesti(repo, elenco)])
    const linguaggi: Record<string, number> = {}
    for (const f of elenco) {
      const l = linguaggioDi(f)
      if (l) linguaggi[l] = (linguaggi[l] ?? 0) + 1
    }

    this.transazione(() => {
      const via = this.db.prepare('delete from file where percorso = ?')
      const viaVoci = this.db.prepare("delete from voce where file = ? and tipo = 'documento'")
      const nuovo = this.db.prepare('insert into file (percorso, firma, linguaggio, titolo) values (?, ?, ?, ?)')
      const voce = this.db.prepare('insert into voce (file, riga, testo, tipo) values (?, ?, ?, ?)')
      for (const f of spariti) {
        via.run(f)
        viaVoci.run(f)
      }
      for (const [f, firma] of daRifare) {
        const testo = documenti.get(f) ?? null
        via.run(f)
        viaVoci.run(f)
        nuovo.run(f, firma, linguaggioDi(f), testo === null ? null : titoloDi(testo))
        if (testo !== null) for (const v of parseMarkdownTodos(f, testo)) voce.run(f, v.riga, v.testo, 'documento')
      }
      this.db.exec("delete from voce where tipo = 'codice'")
      for (const v of codice) if (albero.has(v.file)) voce.run(v.file, v.riga, v.testo, 'codice')
      this.db.prepare("insert or replace into profilo (id, tipo, linguaggi, framework) values ('profilo', ?, ?, ?)").run(kindOf(elenco, manifesti.packageJson), JSON.stringify(linguaggi), JSON.stringify(frameworkDi(elenco, manifesti.tutti)))
    })
    return { file: albero.size, cambiati: daRifare.length + spariti.length, documentiLetti: documenti.size }
  }

  async aggiorna(repo: string): Promise<Riepilogo> {
    await Promise.all([this.aggiornaDaGit(repo), this.aggiornaFile(repo)])
    return this.riepilogo()
  }

  riepilogo(): Riepilogo {
    const p = this.db.prepare('select tipo, linguaggi, framework from profilo').get() as { tipo: Tipo; linguaggi: string; framework: string } | undefined
    return { file: this.conta('file'), commit: this.conta('commit_git'), ref: this.conta('ref_git'), worktree: this.conta('worktree'), voci: this.conta('voce'), profilo: p ? { tipo: p.tipo, linguaggi: JSON.parse(p.linguaggi), framework: JSON.parse(p.framework) } : null }
  }

  // Ogni parola è tra virgolette: il testo di chi cerca non può diventare sintassi di FTS5.
  cerca(testo: string, limite = 30): Trovato[] {
    const parole = testo.split(/\s+/).filter(Boolean).map((p) => `"${p.replace(/"/g, '""')}"*`)
    if (!parole.length) return []
    return (this.db.prepare('select oggetto, tipo, titolo from ricerca where ricerca match ? order by bm25(ricerca, 0, 0, 5, 1) limit ?').all(parole.join(' '), limite) as unknown) as Trovato[]
  }

  private titoloDi(id: string): string {
    const [tipo] = id.split(':')
    const colonna: Record<string, [string, string]> = { attivita: ['attivita', 'titolo'], funzione: ['funzione', 'nome'], worktree: ['worktree', 'percorso'], commit: ['commit_git', 'titolo'], sessione: ['sessione', 'titolo'], area: ['area', 'nome'], nodo: ['nodo', 'nome'] }
    const c = colonna[tipo]
    return (c && (this.db.prepare(`select ${c[1]} as t from ${c[0]} where id = ?`).get(id)?.t as string | undefined)) || id
  }

  oggetto(id: string): OggettoHub | null {
    const legami = this.legamiDi(id).map((l) => ({ ...l, titolo: this.titoloDi(l.altro) }))
    const certo = (testo: string) => ({ certezza: 'certo' as const, testo })
    const base = { id, spiega: null, voci: [], legami, percorso: null }
    if (id.startsWith('commit:')) {
      const c = this.db.prepare('select hash, tempo, titolo from commit_git where id = ?').get(id) as { hash: string; tempo: number; titolo: string } | undefined
      if (!c) return null
      const ref = (this.db.prepare('select nome from ref_git where commit_id = ?').all(id) as { nome: string }[]).map((r) => r.nome)
      return { ...base, tipo: 'commit', titolo: c.titolo, provenienza: certo(t('obj.fromGit')), dati: [[t('obj.commit'), c.hash.slice(0, 9)], [t('obj.date'), new Date(c.tempo).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })], ...(ref.length ? [[t('obj.branchesTags'), ref.join(', ')] as [string, string]] : [])], destinazione: { t: 'commit', hash: c.hash } }
    }
    if (id.startsWith('ref:')) {
      const [, tipo, ...resto] = id.split(':')
      const nome = resto.join(':')
      const r = this.db.prepare('select c.hash, c.titolo from ref_git r join commit_git c on c.id = r.commit_id where r.nome = ? and r.tipo = ?').get(nome, tipo) as { hash: string; titolo: string } | undefined
      if (!r) return null
      return { ...base, tipo: 'ref', titolo: nome, provenienza: certo(t('obj.fromGit')), dati: [[t('obj.type'), tipo === 'locale' ? t('obj.branch') : tipo === 'remoto' ? t('obj.remoteBranch') : t('obj.tag')], [t('obj.lastCommit'), r.titolo]], destinazione: tipo === 'locale' ? { t: 'branch', nome } : { t: 'commit', hash: r.hash } }
    }
    if (id.startsWith('file:')) {
      const percorso = id.slice(5)
      const f = this.db.prepare('select linguaggio, titolo, firma from file where percorso = ?').get(percorso) as { linguaggio: string | null; titolo: string | null; firma: string } | undefined
      if (!f) return null
      return { ...base, tipo: 'file', titolo: percorso, percorso, provenienza: certo(f.firma.startsWith('disco:') ? t('obj.fromDisk') : t('obj.fromLastCommit')), dati: [...(f.linguaggio ? [[t('obj.language'), f.linguaggio] as [string, string]] : []), ...(f.titolo ? [[t('obj.title'), f.titolo] as [string, string]] : [])], voci: this.vociDi(percorso).slice(0, 10), destinazione: { t: 'file', percorso } }
    }
    if (id.startsWith('funzione:')) {
      const f = this.db.prepare('select z.nome, z.spiega, z.citazione, z.citazione_valida, a.nome as area from funzione z left join area a on a.id = z.area_id where z.id = ?').get(id) as { nome: string; spiega: string; citazione: string | null; citazione_valida: number | null; area: string | null } | undefined
      if (!f) return null
      const p = this.db.prepare('select pr.autore, pr.certezza, pr.fonte, v.commit_hash from provenienza pr join versione v on v.id = pr.versione_id where pr.oggetto = ?').get(id) as { autore: string; certezza: string; fonte: string; commit_hash: string | null } | undefined
      const flussi = this.flussiDi(id).length
      const provenienza = p?.certezza === 'non-disponibile'
        ? { certezza: 'non-disponibile' as const, testo: p.fonte }
        : { certezza: 'dedotto' as const, testo: t('obj.writtenBy', { author: p?.autore ?? 'Claude', commit: p?.commit_hash?.slice(0, 9) ?? t('obj.unknown') }) }
      return { ...base, tipo: 'funzione', titolo: f.nome, spiega: f.spiega, provenienza, dati: [...(f.area ? [[t('obj.area'), f.area] as [string, string]] : []), ...(f.citazione ? [[t('obj.citation'), `${f.citazione}${f.citazione_valida === 0 ? t('obj.invalidSuffix') : ''}`] as [string, string]] : []), [t('obj.flows'), String(flussi)]], destinazione: { t: 'funzione', id } }
    }
    if (id.startsWith('attivita:')) {
      const a = this.db.prepare('select titolo from attivita where id = ?').get(id) as { titolo: string } | undefined
      return a ? { ...base, tipo: 'attivita', titolo: a.titolo, provenienza: certo(t('obj.writtenInHub')), dati: [], destinazione: null } : null
    }
    return null
  }

  vociDi(file: string): { riga: number; testo: string; tipo: string }[] {
    return (this.db.prepare('select riga, testo, tipo from voce where file = ? order by riga').all(file) as unknown) as { riga: number; testo: string; tipo: string }[]
  }

  // Solo impostazioni di questa repo: password e chiavi non passano mai di qui.
  preferenza<T>(chiave: string, predefinito: T): T {
    const r = this.db.prepare('select valore from preferenza where chiave = ?').get(chiave) as { valore: string } | undefined
    return r ? (JSON.parse(r.valore) as T) : predefinito
  }

  scriviPreferenza(chiave: string, valore: unknown): void {
    this.db.prepare('insert or replace into preferenza (chiave, valore) values (?, ?)').run(chiave, JSON.stringify(valore))
  }

  impostaWorkspace(percorso: string, nome: string): void {
    this.db.prepare("insert into workspace (id, percorso, nome) values ('workspace', ?, ?) on conflict(id) do update set percorso = excluded.percorso, nome = excluded.nome").run(percorso, nome)
  }

  private registraVersione(v: Versione): string {
    const id = idVersione(v)
    this.db.prepare('insert or ignore into versione (id, commit_hash, impronta, modifiche) values (?, ?, ?, ?)').run(id, v.commit, v.impronta, v.modifiche)
    return id
  }

  private provenienza(oggetto: string, versione: string, autore: string, certezza = 'dedotto'): void {
    this.db.prepare("insert into provenienza (oggetto, fonte, certezza, versione_id, autore) values (?, 'deduzione', ?, ?, ?)").run(oggetto, certezza, versione, autore)
  }

  aggiungiArea(versione: Versione, area: { nome: string; spiega: string }, autore: string): string {
    return this.transazione(() => {
      const id = `area:${randomUUID()}`
      this.db.prepare('insert into area (id, nome, spiega) values (?, ?, ?)').run(id, area.nome, area.spiega)
      this.provenienza(id, this.registraVersione(versione), autore)
      return id
    })
  }

  // Un nuovo livello sostituisce aree e funzioni. Quelle con un flusso già ricavato restano, perché rifarle costa, e si riagganciano per nome.
  salvaLivello(versione: Versione, dati: LivelloDati, autore: string, copertura: unknown, nonValidate: ReadonlySet<string> = new Set()): void {
    this.transazione(() => {
      const v = this.registraVersione(versione)
      this.db.exec('delete from funzione where id not in (select funzione_id from flusso)')
      this.db.exec('delete from area')
      const conFlusso = new Map((this.db.prepare('select id, nome from funzione').all() as { id: string; nome: string }[]).map((f) => [f.nome, f.id]))
      for (const a of dati.aree) {
        const area = `area:${randomUUID()}`
        this.db.prepare('insert into area (id, nome, spiega) values (?, ?, ?)').run(area, a.nome, a.spiega)
        this.provenienza(area, v, autore)
        for (const f of a.funzioni) {
          const esistente = conFlusso.get(f.nome)
          if (esistente) {
            this.db.prepare('update funzione set area_id = ?, spiega = ?, citazione = ?, citazione_valida = ? where id = ?').run(area, f.spiega, f.fonte.testo, nonValidate.has(f.nome) ? 0 : 1, esistente)
            continue
          }
          const id = `funzione:${randomUUID()}`
          this.db.prepare('insert into funzione (id, nome, spiega, versione_id, area_id, citazione, citazione_valida) values (?, ?, ?, ?, ?, ?, ?)').run(id, f.nome, f.spiega, v, area, f.fonte.testo, nonValidate.has(f.nome) ? 0 : 1)
          this.provenienza(id, v, autore)
        }
      }
      this.db.prepare("insert or replace into stato_mappa (id, titolo, versione_id, autore, copertura, quando) values ('mappa', ?, ?, ?, ?, ?)").run(dati.titolo, v, autore, JSON.stringify(copertura), Date.now())
    })
  }

  mappa(): { stato: StatoMappa | null; aree: AreaMappa[]; funzioni: FunzioneMappa[] } {
    const s = this.db.prepare('select titolo, versione_id, autore, copertura, quando from stato_mappa').get() as (Omit<StatoMappa, 'copertura'> & { copertura: string }) | undefined
    return {
      stato: s ? { titolo: s.titolo, versione_id: s.versione_id, autore: s.autore, quando: s.quando, copertura: JSON.parse(s.copertura) } : null,
      aree: (this.db.prepare('select id, nome, spiega from area order by rowid').all() as unknown) as AreaMappa[],
      funzioni: (this.db.prepare('select id, nome, spiega, area_id, citazione, citazione_valida from funzione order by rowid').all() as unknown) as FunzioneMappa[]
    }
  }

  funzione(id: string): FunzioneMappa | null {
    return ((this.db.prepare('select id, nome, spiega, area_id, citazione, citazione_valida from funzione where id = ?').get(id) as unknown) as FunzioneMappa | undefined) ?? null
  }

  tuttiFlussi(): { id: string; funzione_id: string; titolo: string }[] {
    return (this.db.prepare('select id, funzione_id, titolo from flusso order by rowid').all() as unknown) as { id: string; funzione_id: string; titolo: string }[]
  }

  commitMappa(): string | null {
    return (this.db.prepare('select v.commit_hash as c from stato_mappa s join versione v on v.id = s.versione_id').get()?.c as string | null | undefined) ?? null
  }

  nonDisponibile(funzione: string): string | null {
    return (this.db.prepare("select fonte from provenienza where oggetto = ? and certezza = 'non-disponibile'").get(funzione)?.fonte as string | undefined) ?? null
  }

  // Stabile fra un ricavo e l'altro finché funzione, passo e file restano quelli; la frase può cambiare.
  private chiavePasso(funzione: string, passo: string, file: string): string {
    return createHash('sha256').update(`${funzione}\0${passo}\0${file}`).digest('hex').slice(0, 24)
  }

  private nuovaSegnalazione(d: { tipo: string; testo: string; chiave?: string; funzione?: string; frase?: string; file?: string; commit: string | null }): string {
    const id = `segnalazione:${randomUUID()}`
    this.db.prepare('insert into segnalazione (id, tipo, testo, chiave, funzione, frase, file, commit_hash, quando) values (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, d.tipo, d.testo, d.chiave ?? null, d.funzione ?? null, d.frase ?? null, d.file ?? null, d.commit, Date.now())
    return id
  }

  // Le segnalazioni non hanno legami con i passi, che cambiano a ogni ricavo: restano e si riconoscono dalla chiave.
  // Cosa si segnala lo dice l'archivio, non l'interfaccia, così non si può attribuire a un passo la frase di un altro.
  segnalaPasso(passo: string, testo: string): string {
    const p = this.db.prepare('select p.nome, p.spiega, r.file, z.nome as funzione, v.commit_hash from passo p join riferimento r on r.passo_id = p.id join versione v on v.id = r.versione_id join flusso f on f.id = p.flusso_id join funzione z on z.id = f.funzione_id where p.id = ?').get(passo) as { nome: string; spiega: string; file: string; funzione: string; commit_hash: string | null } | undefined
    if (!p) throw new Error(t('arch.unknownStep'))
    return this.nuovaSegnalazione({ tipo: 'spiegazione', testo, chiave: this.chiavePasso(p.funzione, p.nome, p.file), funzione: p.funzione, frase: p.spiega, file: p.file, commit: p.commit_hash })
  }

  segnalaMancante(testo: string): string {
    return this.nuovaSegnalazione({ tipo: 'mancante', testo, commit: this.commitMappa() })
  }

  segnalazioni(): Segnalazione[] {
    return (this.db.prepare('select * from segnalazione order by quando desc, rowid desc').all() as unknown) as Segnalazione[]
  }

  async flussoCompleto(flusso: string, percorso: string): Promise<FlussoCompleto> {
    const f = this.db.prepare('select fl.titolo, z.nome as funzione from flusso fl join funzione z on z.id = fl.funzione_id where fl.id = ?').get(flusso) as { titolo: string; funzione: string } | undefined
    if (!f) throw new Error(t('arch.unknownFlow'))
    const stato = await this.statoFlusso(flusso, percorso)
    const passi = this.db.prepare('select p.id, p.nome, p.spiega, p.tipo, d.nome as da, a.nome as a, r.inizio, r.riga as riga_citata, r.versione_id, v.commit_hash from passo p join riferimento r on r.passo_id = p.id join versione v on v.id = r.versione_id left join nodo d on d.id = p.da_nodo left join nodo a on a.id = p.a_nodo where p.flusso_id = ? order by p.ordine').all(flusso) as { id: string; nome: string; spiega: string; tipo: string | null; da: string; a: string; inizio: number; riga_citata: number; commit_hash: string | null }[]
    const segnalate = this.db.prepare('select chiave, frase, testo from segnalazione where chiave is not null order by quando desc').all() as { chiave: string; frase: string | null; testo: string }[]
    const completi = stato.riferimenti.map((r): PassoCompleto => {
      const p = passi.find((x) => x.id === r.passo)!
      const chiave = this.chiavePasso(f.funzione, p.nome, r.file)
      const stesse = segnalate.filter((s) => s.chiave === chiave)
      return { ...r, chiave, nome: p.nome, spiega: p.spiega, tipo: p.tipo, da: p.da, a: p.a, inizio: p.inizio, rigaCitata: p.riga_citata, segnalato: stesse.some((s) => s.frase === p.spiega) ? 'questa' : stesse.length ? 'precedente' : null, motivoSegnalazione: stesse[0]?.testo ?? null }
    })
    return { id: flusso, titolo: f.titolo, funzione: f.funzione, commit: passi[0]?.commit_hash ?? null, versione: stato.versione, superato: stato.riferimenti.some((r) => r.forseVecchia), passi: completi }
  }

  flussiDi(funzione: string): { id: string; titolo: string }[] {
    return (this.db.prepare('select id, titolo from flusso where funzione_id = ?').all(funzione) as unknown) as { id: string; titolo: string }[]
  }

  funzioneNonTrovata(id: string, versione: Versione, motivo: string, autore: string): void {
    this.transazione(() => {
      const v = this.registraVersione(versione)
      this.db.prepare("insert or replace into provenienza (oggetto, fonte, certezza, versione_id, autore) values (?, ?, 'non-disponibile', ?, ?)").run(id, t('arch.notFound', { reason: motivo }), v, autore)
    })
  }

  salvaFlusso(versione: Versione, funzione: { id?: string; nome: string; spiega: string; area?: string }, flusso: FlussoDati, autore: string): { funzione: string; flusso: string } {
    return this.transazione(() => {
      const v = this.registraVersione(versione)
      const idFunzione = funzione.id ?? `funzione:${randomUUID()}`
      const idFlusso = `flusso:${randomUUID()}`
      if (funzione.id) {
        // Rifare il flusso di una funzione lo sostituisce.
        this.db.prepare('delete from flusso where funzione_id = ?').run(funzione.id)
        this.db.prepare('update provenienza set versione_id = ?, autore = ? where oggetto = ?').run(v, autore, funzione.id)
      } else {
        this.db.prepare('insert into funzione (id, nome, spiega, versione_id, area_id) values (?, ?, ?, ?, ?)').run(idFunzione, funzione.nome, funzione.spiega, v, funzione.area ?? null)
        this.provenienza(idFunzione, v, autore)
      }
      this.db.prepare('insert into flusso (id, funzione_id, titolo) values (?, ?, ?)').run(idFlusso, idFunzione, flusso.titolo)
      this.provenienza(idFlusso, v, autore)
      const nodi = new Map<string, string>()
      for (const n of flusso.nodi) {
        const id = `nodo:${randomUUID()}`
        nodi.set(n.id, id)
        this.db.prepare('insert into nodo (id, flusso_id, chiave, zona, kind, nome, tec) values (?, ?, ?, ?, ?, ?, ?)').run(id, idFlusso, n.id, n.zona, n.kind, n.nome, n.tec)
        this.provenienza(id, v, autore)
      }
      flusso.passi.forEach((p, i) => {
        const da = nodi.get(p.da)
        const a = nodi.get(p.a)
        if (!da || !a) throw new Error(t('arch.unknownNode', { n: i + 1 }))
        const idPasso = `passo:${randomUUID()}`
        this.db.prepare('insert into passo (id, flusso_id, ordine, nome, spiega, certezza, da_nodo, a_nodo, tipo) values (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(idPasso, idFlusso, i, p.nome, p.spiega, p.fonte.certezza, da, a, p.tipo)
        // La certezza del passo dice solo se il brano mostra il collegamento: la spiegazione resta dedotta.
        this.provenienza(idPasso, v, autore)
        this.db.prepare('insert into riferimento (id, passo_id, versione_id, file, riga, inizio, brano, rotto) values (?, ?, ?, ?, ?, ?, ?, ?)').run(`riferimento:${randomUUID()}`, idPasso, v, p.ref.f, p.ref.l, p.ref.s, JSON.stringify(p.ref.righe), p.rotto ? 1 : 0)
      })
      return { funzione: idFunzione, flusso: idFlusso }
    })
  }

  aggiungiAttivita(titolo: string): string {
    const id = `attivita:${randomUUID()}`
    this.db.prepare('insert into attivita (id, titolo) values (?, ?)').run(id, titolo)
    return id
  }

  registraSessione(titolo: string, worktree: string | null, claudeId: string | null): string {
    const id = `sessione:${randomUUID()}`
    this.db.prepare('insert into sessione (id, claude_id, titolo, worktree_id) values (?, ?, ?, ?)').run(id, claudeId, titolo, worktree)
    return id
  }

  aggiungiLavoro(titolo: string, prompt: string, modello: string, tempoMassimo: number): string {
    const id = `lavoro:${randomUUID()}`
    this.db.prepare("insert into lavoro (id, titolo, prompt, modello, tempo_massimo, stato, creato) values (?, ?, ?, ?, ?, 'in-coda', ?)").run(id, titolo, prompt, modello, tempoMassimo, Date.now())
    return id
  }

  // I nomi delle colonne arrivano solo dal codice di Hub, mai dall'esterno.
  aggiornaLavoro(id: string, campi: Partial<Omit<Lavoro, 'id'>>): void {
    const nomi = Object.keys(campi)
    this.db.prepare(`update lavoro set ${nomi.map((n) => `${n} = ?`).join(', ')} where id = ?`).run(...(Object.values(campi) as (string | number | null)[]), id)
  }

  lavoro(id: string): Lavoro | null {
    return ((this.db.prepare('select * from lavoro where id = ?').get(id) as unknown) as Lavoro | undefined) ?? null
  }

  lavori(): Lavoro[] {
    return (this.db.prepare('select * from lavoro order by creato, rowid').all() as unknown) as Lavoro[]
  }

  eliminaFunzione(id: string): void {
    this.db.prepare('delete from funzione where id = ?').run(id)
  }

  eliminaArea(id: string): void {
    this.db.prepare('delete from area where id = ?').run(id)
  }

  collega(da: string, a: string, tipo: string, fonte: string, certezza: string): void {
    const ammesso = this.db.prepare('select da, a from tipo_legame where nome = ?').get(tipo) as { da: string; a: string } | undefined
    if (!ammesso || da.split(':')[0] !== ammesso.da || a.split(':')[0] !== ammesso.a) throw new Error(t('arch.linkNotAllowed', { type: tipo, from: da, to: a }))
    for (const id of [da, a]) {
      if (!this.db.prepare(`select 1 from ${PREFISSI[id.split(':')[0]]} where id = ?`).get(id)) throw new Error(t('arch.notExist', { id }))
    }
    this.db.prepare('insert or replace into legami (da, a, tipo, fonte, certezza) values (?, ?, ?, ?, ?)').run(da, a, tipo, fonte, certezza)
  }

  legamiDi(id: string): Legame[] {
    return (this.db.prepare("select a as altro, tipo, 'uscente' as verso, fonte, certezza from legami where da = ? union all select da, tipo, 'entrante', fonte, certezza from legami where a = ?").all(id, id) as unknown) as Legame[]
  }

  funzioniDi(area: string): { id: string; nome: string }[] {
    return (this.db.prepare('select id, nome from funzione where area_id = ?').all(area) as unknown) as { id: string; nome: string }[]
  }

  areaDi(funzione: string): string | null {
    return (this.db.prepare('select area_id from funzione where id = ?').get(funzione)?.area_id as string | null | undefined) ?? null
  }

  passiDi(flusso: string): { nome: string; da: string; a: string; tipo: string }[] {
    return (this.db.prepare('select p.nome, d.nome as da, a.nome as a, p.tipo from passo p join nodo d on d.id = p.da_nodo join nodo a on a.id = p.a_nodo where p.flusso_id = ? order by p.ordine').all(flusso) as unknown) as { nome: string; da: string; a: string; tipo: string }[]
  }

  provenienzaDi(oggetto: string): Provenienza | null {
    return ((this.db.prepare('select fonte, certezza, versione_id, autore from provenienza where oggetto = ?').get(oggetto) as unknown) as Provenienza | undefined) ?? null
  }

  conta(tabella: 'file' | 'voce' | 'legami' | 'passo' | 'riferimento' | 'flusso' | 'nodo' | 'provenienza' | 'commit_git' | 'ref_git' | 'worktree' | 'area' | 'sessione' | 'workspace'): number {
    return Number(this.db.prepare(`select count(*) as n from ${tabella}`).get()?.n)
  }

  // Lo stato non si salva: dipende dal worktree che si sta guardando e si ricalcola senza token.
  async statoFlusso(flusso: string, percorso: string): Promise<{ versione: Omit<Versione, 'impronta'>; riferimenti: StatoRiferimento[] }> {
    const [versione, stato, radice] = await Promise.all([statoVersione(percorso), statoGit(percorso), realpath(percorso)])
    const cambiati = stato.map((c) => c.path)
    const modificati = new Set(cambiati)
    // Il contenuto si legge solo se c'è da confrontarlo con una versione ricavata da codice non committato.
    let improntaAttuale: Promise<string | null> | null = null
    const uguale = (r: { commit_hash: string | null; impronta: string | null }): Promise<boolean> | boolean => {
      if (r.commit_hash !== versione.commit) return false
      if (!r.impronta) return versione.modifiche === 0
      improntaAttuale ??= improntaDi(percorso, stato)
      return improntaAttuale.then((i) => i === r.impronta)
    }
    const righe = this.db.prepare('select r.id, r.passo_id, r.file, r.riga, r.inizio, r.brano, r.versione_id, r.rotto, v.commit_hash, v.impronta from riferimento r join passo p on p.id = r.passo_id join versione v on v.id = r.versione_id where p.flusso_id = ? order by p.ordine').all(flusso) as { id: string; passo_id: string; file: string; riga: number; inizio: number; brano: string; versione_id: string; rotto: number; commit_hash: string | null; impronta: string | null }[]
    // Rispetto a ciascun commit di origine: file cambiati, committati e no. Null se quel commit qui non esiste.
    const cambiatiDa = new Map<string, Promise<Set<string> | null>>()
    const dalCommit = (commit: string): Promise<Set<string> | null> => {
      let c = cambiatiDa.get(commit)
      if (!c) {
        c = git(percorso, 'diff', '--name-only', '-z', commit).then((s) => new Set([...s.split('\0').filter(Boolean), ...cambiati]), () => null)
        cambiatiDa.set(commit, c)
      }
      return c
    }
    const riferimenti = await Promise.all(righe.map(async (r): Promise<StatoRiferimento> => {
      const stessa = await uguale(r)
      const diversi = stessa || r.impronta || !r.commit_hash ? null : await dalCommit(r.commit_hash)
      const forseVecchia = !stessa && (diversi === null || diversi.has(r.file))
      const base = { id: r.id, passo: r.passo_id, file: r.file, fileModificato: modificati.has(r.file), versioneUguale: stessa, forseVecchia, spiegazione: 'dedotta' as const }
      const testo = await leggiCitato(radice, r.file)
      const controllo: Controllo = testo === null ? { stato: 'non-valido', riga: null } : controllaBrano(testo, { l: r.riga, s: r.inizio, righe: JSON.parse(r.brano) })
      // Rotto quando è stato ricavato resta rotto finché non si ricava di nuovo, anche se per caso quel testo ora compare.
      return { ...base, ...controllo, etichetta: r.rotto || controllo.stato === 'non-valido' ? 'non-valido' : 'citazione-trovata' }
    }))
    return { versione, riferimenti }
  }
}

// Il percorso arriva da Claude: dopo aver seguito i collegamenti deve restare nel worktree e non essere un segreto.
async function leggiCitato(radice: string, file: string): Promise<string | null> {
  const vero = await dentroLaRepo(radice, file)
  if (!vero || SEGRETO.test(basename(vero))) return null
  return readFile(vero, 'utf8').catch(() => null)
}
