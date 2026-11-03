import { createRoot } from 'react-dom/client'
import { setLingua } from '../../shared/i18n.ts'
import { App } from './App'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'

void window.hub.lingua.get().then((l) => {
  setLingua(l)
  document.documentElement.lang = l
  createRoot(document.getElementById('root')!).render(<App />)
})
