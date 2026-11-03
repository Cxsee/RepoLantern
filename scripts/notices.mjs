// Writes THIRD-PARTY-NOTICES.txt from the production dependencies. Run it after changing dependencies.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const voci = Object.entries(lock.packages).filter(([k, v]) => k && !v.dev && !v.optional && existsSync(k)).sort(([a], [b]) => a.localeCompare(b))
const testo = voci.map(([k, v]) => {
  const nome = k.replace(/^.*node_modules\//, '')
  const file = readdirSync(k).find((f) => /^(licen[sc]e|copying|notice)/i.test(f))
  const licenza = file ? readFileSync(join(k, file), 'utf8').trim() : `License: ${JSON.parse(readFileSync(join(k, 'package.json'), 'utf8')).license}`
  return `${nome} ${v.version}\n\n${licenza}`
}).join(`\n\n${'-'.repeat(72)}\n\n`)
writeFileSync('THIRD-PARTY-NOTICES.txt', `RepoLantern includes the following third-party software.\n\n${testo}\n`)
console.log(`${voci.length} packages`)
