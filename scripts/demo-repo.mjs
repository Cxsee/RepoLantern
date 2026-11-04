// Creates a small fictional repository to try RepoLantern on, or to take screenshots from.
// Usage: node scripts/demo-repo.mjs <empty folder>
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const cartella = process.argv[2]
if (!cartella) throw new Error('Usage: node scripts/demo-repo.mjs <empty folder>')
if (existsSync(cartella) && readdirSync(cartella).length) throw new Error(`${cartella} is not empty`)
mkdirSync(cartella, { recursive: true })

const scrivi = (file, testo) => {
  mkdirSync(dirname(join(cartella, file)), { recursive: true })
  writeFileSync(join(cartella, file), testo)
}
const git = (...a) => execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', '-c', 'core.hooksPath=', ...a], { cwd: cartella, stdio: 'pipe' })
const commit = (messaggio) => {
  git('add', '.')
  git('commit', '-qm', messaggio)
}

git('init', '-q', '-b', 'main')
scrivi('README.md', '# Bookshelf\n\nTrack the books you lend to friends.\n\n## Getting started\n\nSet `DATABASE_URL` in your `.env`, then start the API and the web app.\n\n```sh\nnpm ci\ncp .env.example .env\nnpm run dev\n```\n\n## Testing\n\n```sh\nnpm test\n```\n')
scrivi('package.json', JSON.stringify({ name: 'bookshelf', private: true, workspaces: ['web', 'api'], scripts: { dev: 'npm run dev --workspaces', test: 'npm test --workspaces' } }, null, 2))
scrivi('package-lock.json', '{}\n')
scrivi('.env.example', 'DATABASE_URL=\nSESSION_SECRET=\n')
scrivi('docker-compose.yml', 'services:\n  db:\n    image: postgres:17\n')
scrivi('web/package.json', JSON.stringify({ name: 'web', scripts: { dev: 'vite', build: 'vite build', test: 'vitest' }, dependencies: { react: '19.0.0' }, devDependencies: { vite: '7.0.0', vitest: '3.0.0' } }, null, 2))
scrivi('api/package.json', JSON.stringify({ name: 'api', scripts: { dev: 'node --watch src/server.js', test: 'node --test' } }, null, 2))
scrivi('api/src/loans.js', 'export function createLoan(book, friend) {\n  if (book.lentTo) throw new Error(`Already lent to ${book.lentTo}`)\n  return { ...book, lentTo: friend, since: new Date() }\n}\n')
commit('Add the first version of loans')
scrivi('api/src/server.js', "import { createServer } from 'node:http'\nimport { createLoan } from './loans.js'\n\ncreateServer((req, res) => res.end(String(createLoan))).listen(3000)\n")
scrivi('api/src/loans.test.js', "import assert from 'node:assert'\nimport test from 'node:test'\nimport { createLoan } from './loans.js'\n\ntest('a lent book cannot be lent twice', () => {\n  assert.throws(() => createLoan({ lentTo: 'Sam' }, 'Alex'))\n})\n")
commit('Serve the API and test double loans')
scrivi('web/src/LoanList.jsx', "export const LoanList = ({ loans }) => <ul>{loans.map((l) => <li key={l.id}>{l.title}: {l.lentTo}</li>)}</ul>\n")
scrivi('docs/roadmap.md', '# Roadmap\n\n- [ ] Remind friends when a loan is overdue\n- [x] Show the list of loans\n')
commit('Show the list of loans')
git('checkout', '-qb', 'feature/reminders')
scrivi('api/src/reminders.js', 'export const isOverdue = (loan, days = 30) => Date.now() - loan.since > days * 86400000\n')
commit('Find overdue loans')
// A deliberate flaw on this branch, so the Review section has something real to find.
scrivi('api/src/friends.js', "export const loansOf = (db, friend) => db.query(\"SELECT * FROM loans WHERE friend = '\" + friend + \"'\")\n")
commit('Add loans by friend')
git('checkout', '-q', 'main')
scrivi('web/src/LoanList.jsx', "export const LoanList = ({ loans }) => <ul className=\"loans\">{loans.map((l) => <li key={l.id}>{l.title}: {l.lentTo}</li>)}</ul>\n")
console.log(`Demo repository ready in ${cartella}. Add it to RepoLantern with "Add repo".`)
