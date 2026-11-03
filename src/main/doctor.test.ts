import assert from 'node:assert/strict'
import test from 'node:test'
import { analizza, comandiCi, comandiGuida, inOrdine, pyprojectVero, involucro, nomiVariabili, serviziCompose, strumentoPresente, titoliGuida, visita } from './doctor.ts'

const leggi = (file: Record<string, string>) => async (f: string): Promise<string | null> => file[f] ?? null
const prova = (file: Record<string, string>) => analizza(Object.keys(file), leggi(file))

test('un progetto Node: stack, script dichiarati con la loro riga, installazione ipotizzata', async () => {
  const pk = '{\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest",\n    "pippo": "rm -rf /"\n  },\n  "dependencies": { "react": "1" },\n  "devDependencies": { "vite": "1", "typescript": "1" }\n}'
  const r = await prova({ 'package.json': pk, 'package-lock.json': '{}' })
  const p = r.parti[0]
  assert.deepEqual(p.stack, ['Node.js', 'React', 'Vite', 'TypeScript'])
  assert.deepEqual(p.comandi.map((c) => [c.tipo, c.comando, c.certezza, c.fonte.riga]), [['installa', 'npm ci', 'ipotizzato', 1], ['avvia', 'npm run dev', 'dichiarato', 3], ['test', 'npm run test', 'dichiarato', 4]])
  assert.match(p.comandi[0].nota!, /run code/)
  assert.deepEqual(r.strumenti.map((s) => s.nome), ['node', 'npm'])
})

test('il gestore si riconosce dal lockfile, e un package.json rotto non blocca', async () => {
  const r = await prova({ 'package.json': '{"scripts":{"dev":"x"}}', 'pnpm-lock.yaml': '' })
  assert.deepEqual(r.parti[0].comandi.map((c) => c.comando), ['pnpm install --frozen-lockfile', 'pnpm dev'])
  assert.deepEqual((await prova({ 'package.json': '{ rotto' })).parti[0].stack, ['Node.js'])
})

test('in un monorepo la sottocartella usa il gestore della radice e non si installa da sola', async () => {
  const r = await prova({ 'package.json': '{"scripts":{"test:coverage:watch":"x","test":"y"}}', 'yarn.lock': '', 'app/package.json': '{"scripts":{"start":"z"}}', 'pyproject.toml': '[build-system]\nx', 'uv.lock': '', 'api/pyproject.toml': '[build-system]\npytest', 'api/tests/a.py': '' })
  const [radice, api, app] = r.parti
  assert.deepEqual([radice.cartella, api.cartella, app.cartella], ['', 'api', 'app'])
  assert.deepEqual(app.comandi.map((c) => c.comando), ['yarn start'])
  assert.deepEqual(api.comandi.map((c) => c.comando), ['pytest'])
  assert.deepEqual(radice.comandi.map((c) => c.comando), ['uv sync', 'yarn test', 'yarn install', 'yarn test:coverage:watch'])
})

test('riconosce le parti di un progetto misto e ignora cartelle generate', async () => {
  const r = await prova({
    'app/pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n',
    'app/test/a_test.dart': '',
    'supabase/config.toml': 'x',
    'api/requirements.txt': 'fastapi\npytest\n',
    'api/manage.py': '',
    'node_modules/x/package.json': '{}',
    'build/go.mod': '',
    'a/b/c/d/e/Cargo.toml': '',
    'altro/config.toml': 'x'
  })
  assert.deepEqual(r.parti.map((p) => [p.cartella, p.stack]), [['api', ['Python', 'FastAPI', 'pytest', 'Django']], ['app', ['Flutter']], ['supabase', ['Supabase']]])
  assert.deepEqual(r.parti[1].comandi.map((c) => c.comando), ['flutter pub get', 'flutter run', 'flutter test'])
  assert.deepEqual(r.strumenti.map((s) => s.nome).sort(), ['docker', 'flutter', 'python', 'supabase'])
  assert.ok(r.parti.flatMap((p) => p.comandi).every((c) => c.certezza === 'ipotizzato'))
})

test('le cartelle native di Flutter e i moduli di Gradle non sono parti a sé', async () => {
  const r = await prova({ 'app/pubspec.yaml': 'flutter:\n', 'app/android/build.gradle.kts': '', 'app/android/app/build.gradle.kts': '', 'app/ios/Makefile': 'test:\n', 'srv/settings.gradle': '', 'srv/build.gradle': '', 'srv/mod/build.gradle': '', 'web/package.json': '{}' })
  assert.deepEqual(r.parti.map((p) => p.cartella), ['app', 'srv', 'web'])
  assert.deepEqual(r.strumenti.map((s) => s.nome), ['flutter', 'gradle', 'java', 'node', 'npm'])
})

test('altri linguaggi', async () => {
  const pile = async (f: string, t = ''): Promise<string[]> => (await prova({ [f]: t })).parti[0].stack
  assert.deepEqual(await pile('go.mod'), ['Go'])
  assert.deepEqual(await pile('Cargo.toml'), ['Rust'])
  assert.deepEqual(await pile('pom.xml'), ['Java', 'Maven'])
  assert.deepEqual(await pile('App.csproj'), ['.NET'])
  assert.deepEqual(await pile('Gemfile'), ['Ruby'])
  assert.deepEqual(await pile('composer.json'), ['PHP'])
  const g = involucro('gradlew')
  assert.deepEqual((await prova({ 'build.gradle.kts': '', gradlew: '' })).parti[0].comandi.map((c) => c.comando), [`${g} test`, `${g} build`])
  assert.deepEqual((await prova({ 'pom.xml': '', mvnw: '' })).strumenti.map((s) => s.nome), ['java'])
  assert.deepEqual([involucro('gradlew', 'linux'), involucro('gradlew', 'win32'), involucro('mvnw', 'win32')], ['./gradlew', '.\\gradlew.bat', '.\\mvnw.cmd'])
  assert.deepEqual((await prova({ Makefile: 'VAR := 1\ntest: dep\n\tgo test\nbuild:\nnascosto:\n' })).parti[0].comandi.map((c) => [c.comando, c.fonte.riga]), [['make test', 2], ['make build', 4]])
  assert.deepEqual((await prova({ 'README.txt': 'niente' })).parti, [])
})

test('delle variabili legge solo i nomi, e mai il vero .env', async () => {
  assert.deepEqual(nomiVariabili('# commento\nAPI_KEY=sk-vera\nexport DB_URL="x"\nAPI_KEY=doppia\nnon una variabile\n'), ['API_KEY', 'DB_URL'])
  const letti: string[] = []
  const file: Record<string, string> = { '.env': 'SEGRETO=1', '.env.local': 'SEGRETO=2', '.env.example': 'PUBBLICA=valore', 'package.json': '{}' }
  const r = await analizza(Object.keys(file), async (f) => (letti.push(f), file[f]))
  assert.deepEqual(r.parti[0].variabili, [{ fonte: { file: '.env.example', riga: 1 }, nomi: ['PUBBLICA'], citate: 0 }])
  assert.ok(!letti.includes('.env') && !letti.includes('.env.local'))
  assert.doesNotMatch(JSON.stringify(r), /valore/)
})

test('servizi da compose, comandi della CI, titoli delle guide', () => {
  assert.deepEqual(serviziCompose('c.yml', 'services:\n  db:\n    image: postgres:16\n  db2:\n    image: postgres:15\n  r:\n    image: redis\n  a:\n    image: mio/app\n').map((s) => [s.nome, s.fonte.riga]), [['PostgreSQL', 3], ['Redis', 7]])
  const ci = comandiCi('w.yml', 'jobs:\n  a:\n    steps:\n      - run: npm ci\n      - name: x\n        run: |\n          # nota\n          npm test\n          npm run build\n      - uses: y\n')
  assert.deepEqual(ci.map((c) => [c.tipo, c.comando, c.fonte.riga]), [['test', 'npm test', 8], ['build', 'npm run build', 9]])
  assert.deepEqual(comandiCi('w.yml', '- run: sudo apt-get install x\n- run: f=1\n- run: echo test\n- run: npm ci\n'), [])
  assert.ok(ci.every((c) => c.certezza === 'dichiarato'))
  assert.deepEqual(titoliGuida('r.md', '# Titolo\n## Installation\n```\n# Setup finto\n```\n## Licenza\n### Come avviare\n').map((t) => [t.titolo, t.fonte.riga]), [['Installation', 2], ['Come avviare', 7]])
})

test('i prerequisiti si cercano da un elenco fisso e fuori dal progetto', async () => {
  assert.equal(await strumentoPresente('cmd-inventato; calc'), null)
  const r = await visita(['package.json'], leggi({ 'package.json': '{}' }))
  assert.equal(r.prerequisiti.find((p) => p.nome === 'node')?.trovato, true)
  assert.ok(!('strumenti' in r))
})

test('i comandi della guida: ordine, cartella e sezione, solo sotto i titoli su come partire', () => {
  const guida = '# App\n\n## License\n\n```sh\nnpm run nonqui\n```\n\n## Getting started\n\n```sh\ncd maybe\ncp .env.local.example .env.local\n$ bin/setup\nbin/dev\nsome output\n```\n\n## Testing on Windows\n\n```\nyarn test\n```\n'
  const c = comandiGuida('README.md', guida)
  assert.deepEqual(c.map((x) => [x.comando, x.tipo]), [['cp .env.local.example .env.local', 'installa'], ['bin/setup', 'installa'], ['bin/dev', 'avvia'], ['yarn test', 'test']])
  assert.deepEqual(c[1].fonte, { file: 'README.md', riga: 14 })
  assert.match(c[1].nota!, /Getting started.*maybe/)
  assert.match(c[3].nota!, /Windows/)
  assert.ok(c.every((x) => x.certezza === 'guida'))
})

test('un pyproject di soli linter non fa del progetto un progetto Python', async () => {
  assert.equal(pyprojectVero('[project]\nname = "x"\n\n[dependency-groups]\nlint = ["ruff"]\n'), false)
  assert.equal(pyprojectVero('[project]\ndependencies = [\n  "flask",\n]\n'), true)
  assert.equal(pyprojectVero('[build-system]\nrequires = []\n'), true)
  const r = await prova({ 'pyproject.toml': '[project]\nname = "x"\n', 'uv.lock': '', 'go.mod': 'module x\n' })
  assert.deepEqual(r.parti[0].stack, ['Go'])
  assert.ok(!r.parti[0].comandi.some((c) => /uv|pytest/.test(c.comando)))
})

test('la guida e il Makefile vengono prima delle ipotesi, e ogni tipo ha il suo comando in testa', async () => {
  const r = await prova({ 'go.mod': 'module x\n', 'Makefile': 'deps:\n\ttrue\nwatch:\n\ttrue\ntest-backend:\n\ttrue\n', 'README.md': '## Install\n\n```\nmake deps\n```\n' })
  assert.deepEqual(r.dallaGuida.map((c) => c.comando), ['make deps'])
  assert.deepEqual(r.parti[0].comandi.slice(0, 3).map((c) => c.comando), ['make deps', 'make watch', 'make test-backend'])
  assert.equal(r.parti[0].comandi.at(-1)!.certezza, 'ipotizzato')
  const dichiara = (tipo: 'avvia' | 'test', comando: string) => ({ tipo, comando, certezza: 'dichiarato' as const, fonte: { file: 'a', riga: 1 } })
  assert.deepEqual(inOrdine([dichiara('avvia', 'yarn dev:a'), dichiara('avvia', 'yarn dev:b'), dichiara('test', 'yarn test')]).map((c) => c.comando), ['yarn dev:a', 'yarn test', 'yarn dev:b'])
})

test('il file e le variabili che la guida nomina vengono prima', async () => {
  const r = await prova({ '.env.example': 'ALTRA=1\n', '.env.local.example': 'PRIMA=1\nSECRET=1\n', 'package.json': '{}', 'README.md': '## Setup\n\nCopy `.env.local.example` and set `SECRET`.\n' })
  assert.deepEqual(r.parti[0].variabili.map((v) => [v.fonte.file, v.nomi, v.citate]), [['.env.local.example', ['SECRET', 'PRIMA'], 1], ['.env.example', ['ALTRA'], 0]])
})

test('la guida: sottosezioni, variabili davanti al comando, guide per sviluppatori, script del progetto', async () => {
  assert.deepEqual(comandiGuida('README.md', '## Local Development Setup\n\n### Requirements\n\n```sh\nbin/setup\n```\n\n## License\n\n```\nmake nonqui\n```\n').map((c) => c.comando), ['bin/setup'])
  assert.deepEqual(comandiGuida('README.md', '## Building\n\n```\nTAGS=a make build\n```\n').map((c) => c.comando), ['make build'])
  assert.deepEqual(comandiGuida('docs/DEVELOPMENT.md', '### macOS\n\n```\nbin/dev\n```\n').map((c) => c.comando), ['bin/dev'])
  const r = await prova({ 'Gemfile': '', 'bin/setup': '', 'bin/dev': '', 'bin/rspec': '', 'package.json': '{"scripts":{"e2e":"x","test":"y"}}', '.github/package.json': '{}', '.devcontainer/compose.yml': '' })
  assert.deepEqual(r.parti.map((p) => p.cartella), [''])
  assert.deepEqual(r.parti[0].comandi.slice(0, 3).map((c) => c.comando), ['bin/setup', 'bin/dev', 'bin/rspec'])
  assert.deepEqual(comandiCi('a.yml', '- run: gh release create x test\n- run: security create-keychain test\n- run: make test\n').map((c) => c.comando), ['make test'])
})
