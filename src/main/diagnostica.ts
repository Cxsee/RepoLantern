import { redact } from './review.ts'

export type DiagnosticInfo = { app: string; electron: string; node: string; os: string; language: string; git: string | null; claude: boolean; repos: number; errors: string[] }

// Meant to be pasted in a public issue: no paths, no repository names, no secrets.
export function sanitize(text: string, private_: string[]): string {
  let out = redact(text)
  const variants = private_.flatMap((p) => [p, p.replaceAll('\\', '/'), p.replaceAll('/', '\\')])
  for (const p of [...new Set(variants)].sort((a, b) => b.length - a.length)) if (p) out = out.split(p).join('<path>')
  return out.replace(/[A-Za-z]:[\\/][^\s"'`]+/g, '<path>').replace(/(^|\s)\/(home|Users)\/[^\s"'`]+/g, '$1<path>')
}

export function diagnosticReport(i: DiagnosticInfo, private_: string[]): string {
  return [
    '## RepoLantern diagnostic report',
    `Version: ${i.app} (Electron ${i.electron}, Node ${i.node})`,
    `System: ${i.os}, language ${i.language}`,
    `Git: ${i.git ?? 'not found'}`,
    `Claude Code CLI: ${i.claude ? 'found' : 'not found'}`,
    `Repositories added: ${i.repos}`,
    `Recent job errors: ${i.errors.length ? '' : 'none'}`,
    ...i.errors.slice(0, 10).map((e) => `- ${sanitize(e, private_).replace(/\s+/g, ' ').slice(0, 300)}`)
  ].join('\n')
}
