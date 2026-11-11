import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callFromJson, describeTool, historyAsText, looseJson, parseAnswer, TextToolStream, toolsAsText } from '../src/shared/textTools.ts'

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a text file from the user PC. For large files, read a range of lines with start_line/max_lines.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, max_lines: { type: 'integer' } }, required: ['path'] }
  },
  {
    name: 'write_files',
    description: 'Create several files at once.',
    parameters: {
      type: 'object',
      properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }, folders: { type: 'array', items: { type: 'string' } } },
      required: ['files']
    }
  },
  { name: 'search_files', description: 'Find files.', parameters: { type: 'object', properties: { root: { type: 'string' }, sort: { type: 'string', enum: ['found', 'largest'] } }, required: ['root'] } }
]
const NAMES = TOOLS.map((t) => t.name)

test('a tool is described on one line, required arguments first, with types where they are not text', () => {
  assert.equal(describeTool(TOOLS[0]!, true), '- read_file(path, start_line?: int, max_lines?: int): Read a text file from the user PC.')
  assert.match(describeTool(TOOLS[1]!), /write_files\(files: \[\{path, content\}\], folders\?: \[string\]\)/)
  assert.match(describeTool(TOOLS[2]!), /sort\?: "found"\|"largest"/)
})

test('the tool guide teaches the call block and lists every tool', () => {
  const guide = toolsAsText(TOOLS, { brief: true })
  assert.match(guide, /<tool_call>/)
  for (const n of NAMES) assert.ok(guide.includes(`- ${n}(`), n)
  assert.equal(toolsAsText([]), '')
})

test('JSON as small models write it is still read', () => {
  assert.deepEqual(looseJson('{"a": 1,}'), { a: 1 })
  assert.deepEqual(looseJson('```json\n{"a": [1, 2,]}\n```'), { a: [1, 2] })
  // A raw line break inside a string, as when a model writes a file's content.
  assert.deepEqual(looseJson('{"path": "a.txt", "content": "line one\nline two"}'), { path: 'a.txt', content: 'line one\nline two' })
  // Cut off before it was closed.
  assert.deepEqual(looseJson('{"name": "read_file", "arguments": {"path": "C:\\\\Users\\\\me\\\\a.txt"'), { name: 'read_file', arguments: { path: 'C:\\Users\\me\\a.txt' } })
  assert.deepEqual(looseJson('Here you go: {"x": true} hope that helps'), { x: true })
  assert.equal(looseJson('no json here'), undefined)
})

test('a call is recognised in every shape models use for it', () => {
  assert.deepEqual(callFromJson({ name: 'read_file', arguments: { path: 'a' } }), { name: 'read_file', arguments: { path: 'a' } })
  assert.deepEqual(callFromJson({ tool: 'read_file', args: { path: 'a' } }), { name: 'read_file', arguments: { path: 'a' } })
  assert.deepEqual(callFromJson({ function: { name: 'read_file', arguments: '{"path": "a"}' } }), { name: 'read_file', arguments: { path: 'a' } })
  assert.deepEqual(callFromJson({ name: 'read_file', parameters: { path: 'a' } }), { name: 'read_file', arguments: { path: 'a' } })
  assert.deepEqual(callFromJson({ name: 'read_file', path: 'a' }), { name: 'read_file', arguments: { path: 'a' } })
  assert.deepEqual(callFromJson([{ name: 'read_file', arguments: {} }]), { name: 'read_file', arguments: {} })
  assert.equal(callFromJson({ title: 'not a call' }), undefined)
  assert.equal(callFromJson('text'), undefined)
})

test('a tagged call is taken out of the answer, with the text before it kept', () => {
  const r = parseAnswer('Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "notes.txt"}}\n</tool_call>', NAMES)
  assert.equal(r.text, 'Let me look.')
  assert.deepEqual(r.call, { name: 'read_file', arguments: { path: 'notes.txt' } })
})

test('a call whose closing tag never came (generation stops at it) is still read', () => {
  const r = parseAnswer('<tool_call>\n{"name": "search_files", "arguments": {"root": "~", "sort": "largest"}}\n', NAMES)
  assert.deepEqual(r.call, { name: 'search_files', arguments: { root: '~', sort: 'largest' } })
})

test('other call formats: Llama, Mistral, a fenced block, ReAct, bare JSON', () => {
  assert.deepEqual(parseAnswer('<function=read_file>{"path": "a.txt"}</function>', NAMES).call, { name: 'read_file', arguments: { path: 'a.txt' } })
  assert.deepEqual(parseAnswer('[TOOL_CALLS] [{"name": "read_file", "arguments": {"path": "a.txt"}}]', NAMES).call, { name: 'read_file', arguments: { path: 'a.txt' } })
  assert.deepEqual(parseAnswer('```json\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```', NAMES).call, { name: 'read_file', arguments: { path: 'a.txt' } })
  assert.deepEqual(parseAnswer('Thought: I need the file.\nAction: read_file\nAction Input: {"path": "a.txt"}', NAMES).call, { name: 'read_file', arguments: { path: 'a.txt' } })
  assert.deepEqual(parseAnswer('{"name": "read_file", "parameters": {"path": "a.txt"}}', NAMES).call, { name: 'read_file', arguments: { path: 'a.txt' } })
})

test('JSON that is an answer, not a call, stays an answer', () => {
  const answer = '```json\n{"name": "Ada", "age": 36}\n```'
  assert.equal(parseAnswer(answer, NAMES).call, undefined)
  assert.equal(parseAnswer(answer, NAMES).text, answer)
  // Untagged JSON never counts for a model that has tool calling of its own.
  assert.equal(parseAnswer('{"name": "read_file", "arguments": {"path": "a"}}', NAMES, { tagsOnly: true }).call, undefined)
})

test('a call block with unreadable JSON is reported, not guessed at', () => {
  const r = parseAnswer('<tool_call>read the file notes.txt please</tool_call>', NAMES)
  assert.equal(r.call, undefined)
  assert.equal(r.broken, 'read the file notes.txt please')
})

test('streaming: text is shown as it comes, and the call block never is', () => {
  const s = new TextToolStream(NAMES)
  const pieces = ['I will ', 'check that.\n', '<tool', '_call>\n{"name": "read_', 'file", "arguments": {"path": "a.txt"}}\n</tool_call>']
  let shown = ''
  for (const p of pieces) shown += s.push(p)
  assert.equal(shown, 'I will check that.\n')
  assert.equal(s.complete, true)
  const end = s.finish()
  assert.deepEqual(end.call, { name: 'read_file', arguments: { path: 'a.txt' } })
})

test('streaming: a "<" that turns out to be ordinary text is shown after all', () => {
  const s = new TextToolStream(NAMES)
  let shown = s.push('Use a <')
  shown += s.push('b> tag for bold.')
  assert.equal(shown, 'Use a <b> tag for bold.')
  assert.equal(s.finish().held, '')
})

test('streaming: an answer that opens with a brace is held until it is known whether it is a call', () => {
  const call = new TextToolStream(NAMES)
  assert.equal(call.push('{"name": "read_file", '), '')
  assert.equal(call.push('"arguments": {"path": "a.txt"}}'), '')
  assert.deepEqual(call.finish().call, { name: 'read_file', arguments: { path: 'a.txt' } })

  const data = new TextToolStream(NAMES)
  assert.equal(data.push('{"city": "Lisbon"}'), '')
  const end = data.finish()
  assert.equal(end.call, undefined)
  assert.equal(end.held, '{"city": "Lisbon"}')

  // With tool calling of its own, a model's JSON answer streams straight through.
  const native = new TextToolStream(NAMES, { tagsOnly: true })
  assert.equal(native.push('{"city": "Lisbon"}'), '{"city": "Lisbon"}')
})

test('a conversation with tool calls reads as plain text for a model without tool calling', () => {
  const out = historyAsText([
    { role: 'system', content: 'You are Maris.' },
    { role: 'user', content: 'What is in notes.txt?' },
    { role: 'assistant', content: 'Let me look.', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'notes.txt' } } }] },
    { role: 'tool', tool_name: 'read_file', content: 'milk, eggs' },
    { role: 'user', content: 'A screenshot', images: ['abc'] },
    { role: 'assistant', content: 'It lists milk and eggs.' }
  ])
  assert.deepEqual(
    out.map((m) => m.role),
    ['system', 'user', 'assistant', 'user', 'assistant']
  )
  assert.match(out[2]!.content, /^Let me look\.\n<tool_call>\n\{"name":"read_file","arguments":\{"path":"notes\.txt"\}\}\n<\/tool_call>$/)
  // The result and the message after it are one user turn: some chat templates refuse two in a row.
  assert.match(out[3]!.content, /^<tool_result name="read_file">\nmilk, eggs\n<\/tool_result>\n\nA screenshot$/)
  assert.deepEqual(out[3]!.images, ['abc'])
})
