import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useApp } from './store'
import './styles.css'

void useApp.getState().init()
// Lets the end-to-end tests drive the UI state (renderer-only; no extra privileges).
;(window as unknown as { __marisStore: typeof useApp }).__marisStore = useApp

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
