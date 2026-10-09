import './styles.css'
import { Workbench } from './workbench'

const host = document.getElementById('app')!

Workbench.start(host).catch((err: unknown) => {
  console.error(err)
  host.textContent = `some-ide failed to start: ${err instanceof Error ? err.message : String(err)}`
  host.classList.add('fatal')
})
