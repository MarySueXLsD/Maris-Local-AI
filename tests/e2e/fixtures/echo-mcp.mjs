// A tiny MCP server for tests: one read-only tool and one that changes something (writes NOTE_FILE).
import { appendFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'maris-test-service', version: '1.0.0' })

server.registerTool(
  'get_secret_number',
  { title: 'Get the secret number', description: 'Returns the secret number stored in the test service.', inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: 'text', text: 'The secret number is 4217.' }] })
)

server.registerTool(
  'save_note',
  { title: 'Save a note', description: 'Saves a short note in the test service.', inputSchema: { text: z.string().describe('The note') }, annotations: { readOnlyHint: false } },
  async ({ text }) => {
    appendFileSync(process.env.NOTE_FILE ?? 'notes.txt', `${text}\n`)
    return { content: [{ type: 'text', text: 'Saved the note.' }] }
  }
)

await server.connect(new StdioServerTransport())
