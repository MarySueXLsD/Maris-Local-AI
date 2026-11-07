// Plain-language explanations of technical words. Used by <Term> hovers and the Glossary help article.

// The computer's OS from the preload bridge (absent in unit tests, which describe Windows).
const HOST = (globalThis as { maris?: { platform?: string } }).maris?.platform ?? 'win32'
const IS_WIN = HOST === 'win32'
const IS_MAC = HOST === 'darwin'
const DEVICE = IS_MAC ? 'Mac' : 'PC'
const OS_NAME = IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux'
const SHELL_NAME = IS_WIN ? 'PowerShell' : IS_MAC ? 'zsh' : 'bash'

export interface GlossaryEntry {
  term: string
  short: string
  /** Help article with more detail. */
  article?: string
}

export const GLOSSARY: Record<string, GlossaryEntry> = {
  gpu: {
    term: 'GPU (graphics card)',
    short: 'The chip that draws your screen. It is also by far the fastest place to run AI models, because it can do thousands of small calculations at once.',
    article: 'your-pc'
  },
  vram: {
    term: 'VRAM (video memory)',
    short: 'The graphics card’s own memory. A model that fits completely in VRAM answers fast; one that does not fit has to use slower system RAM.',
    article: 'your-pc'
  },
  ram: {
    term: 'RAM (system memory)',
    short: `Your ${DEVICE}’s main working memory. Models can run from RAM too, but more slowly than from VRAM.`,
    article: 'your-pc'
  },
  cpu: {
    term: 'CPU (processor)',
    short: `The ${DEVICE}’s main chip. It can run AI models without a graphics card, just more slowly.`,
    article: 'your-pc'
  },
  model: {
    term: 'Model',
    short: 'The “brain” that writes answers or makes pictures. Bigger models are usually smarter but slower and need more memory.',
    article: 'models'
  },
  params: {
    term: 'Parameters (B)',
    short: 'A rough measure of a model’s size: 9B means nine billion numbers. More usually means smarter, slower and more memory.',
    article: 'models'
  },
  quant: {
    term: 'Quantisation (Q3, Q4…)',
    short: 'A way of shrinking a model by storing its numbers with less precision. Q4 is a good balance; Q3 is smaller with a little less quality.',
    article: 'models'
  },
  moe: {
    term: 'Mixture of experts',
    short: 'A big model that only uses a small part of itself for each word, so it stays fast even when it runs partly from RAM or on the CPU.',
    article: 'models'
  },
  tokens: {
    term: 'Tokens',
    short: 'The pieces models read and write: roughly three quarters of a word each.',
    article: 'models'
  },
  tps: {
    term: 'Tokens per second',
    short: 'How fast a model writes. About 10 feels like fast reading speed; 40 or more feels instant.',
    article: 'models'
  },
  context: {
    term: 'Context window',
    short: 'How much of the conversation (and files, in Code mode) the model can keep in mind at once. Bigger windows remember more but need more memory. The ring next to the send button shows how full it is.',
    article: 'context'
  },
  thinking: {
    term: 'Thinking',
    short: 'Some models can reason step by step before they answer. It gives better answers to hard questions and takes a little longer.',
    article: 'chatting'
  },
  embedding: {
    term: 'Embedding model',
    short: 'A small helper model that turns text into numbers, so Maris can find memories that mean the same thing even when the words differ.',
    article: 'memory'
  },
  ollama: {
    term: 'Ollama',
    short: `The free engine that runs language models on your ${DEVICE}. Maris starts it for you.`,
    article: 'your-pc'
  },
  comfyui: {
    term: 'ComfyUI',
    short: 'The free engine that runs image and video models. Maris installs and starts it for you when you first make a picture.',
    article: 'studio'
  },
  approval: {
    term: 'Approval',
    short: `Maris asks before it changes anything on your ${DEVICE}. Nothing happens until you press Approve.`,
    article: 'approvals'
  },
  compaction: {
    term: 'Compacting',
    short: 'When a conversation gets very long, Maris summarises the older part so the model can keep going without forgetting what happened.',
    article: 'context'
  },
  diff: {
    term: 'Change (diff)',
    short: 'A before-and-after view of a file: green lines were added, red lines were removed.',
    article: 'code-mode'
  },
  command: {
    term: 'Command',
    short: `An instruction typed into ${OS_NAME} (${SHELL_NAME}), for example to build a program or run its tests.`,
    article: 'code-mode'
  },
  prompt: {
    term: 'Prompt',
    short: 'What you ask for, in your own words. For pictures, describe the subject, style, lighting and mood.',
    article: 'studio'
  },
  negative: {
    term: 'Negative prompt',
    short: 'Things you do not want in a picture, such as “blurry, text, watermark”.',
    article: 'studio'
  },
  seed: {
    term: 'Seed',
    short: 'The random starting point of a picture. The same seed and prompt give the same picture again.',
    article: 'studio'
  },
  lora: {
    term: 'LoRA',
    short: 'A small add-on that teaches a picture or video model a style or a speed-up trick.',
    article: 'studio'
  },
  temperature: {
    term: 'Temperature',
    short: 'How adventurous the model’s word choices are. Low is focused and predictable; high is creative and varied.',
    article: 'settings'
  },
  tier: {
    term: 'Fast, Balanced and Max',
    short: `Your three main models from small to large. Auto picks one for every message depending on how hard it is and how busy your ${DEVICE} is.`,
    article: 'auto'
  },
  skill: {
    term: 'Skill',
    short: 'Written instructions for one kind of task (a folder with a SKILL.md file). Maris reads a skill when your request matches it.',
    article: 'skills'
  },
  mcp: {
    term: 'Connector (MCP)',
    short: 'A link to another service, such as GitHub or Notion, through the Model Context Protocol. It gives Maris tools for that service; tools that change something ask first.',
    article: 'connectors'
  },
  processing: {
    term: 'GPU only, GPU + CPU, CPU only',
    short: 'Where models are allowed to run. GPU only is fastest; GPU + CPU allows bigger models that spill into RAM; CPU only needs no graphics card.',
    article: 'setup'
  }
}
