// Actions on a whole chat, used by the sidebar menu, the message buttons and the command palette.
import { useApp } from '../store'
import { api } from './api'
import { REMOTE } from './platform'

/** An error from the main process, without Electron's "Error invoking remote method …" in front. */
export const errorText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

/**
 * Save a chat as a file the person picks (Markdown to read, JSON with everything). The phone app has no
 * file dialog, so there the Markdown goes to the clipboard instead.
 */
export async function exportChat(id: string, format: 'md' | 'json'): Promise<void> {
  const s = useApp.getState()
  try {
    const { name, content } = await api.conv.exportChat(id, REMOTE ? 'md' : format)
    if (REMOTE) {
      await navigator.clipboard.writeText(content)
      s.announce('The chat is copied as Markdown')
      return
    }
    const saved = await api.files.saveText(name, content)
    if (saved) s.announce(`Saved ${saved}`)
  } catch (e) {
    useApp.setState({ error: `Could not export the chat: ${errorText(e)}` })
  }
}

/** A new chat with the messages up to this one, opened right away. */
export async function branchFrom(messageId: string): Promise<void> {
  const s = useApp.getState()
  try {
    const c = await api.conv.branch(messageId)
    // The event that adds it to the list may come a moment later; open() needs it there for the mode.
    useApp.setState((st) => ({ conversations: st.conversations.some((x) => x.id === c.id) ? st.conversations : [c, ...st.conversations] }))
    await s.open(c.id)
    s.announce('Opened a branch of the chat')
  } catch (e) {
    useApp.setState({ error: `Could not branch the chat: ${errorText(e)}` })
  }
}
