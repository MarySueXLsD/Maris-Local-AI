// Loaded only after window.maris exists, so the interface's modules see the phone's API.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import { useApp } from '../src/store'

export function bootApp(): void {
  void useApp.getState().init()
  ;(window as unknown as { __marisStore: typeof useApp }).__marisStore = useApp
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
