// Help articles, written for people who are not technical. Links like [text](help:approvals) open another article.
import { accelLabel, DEVICE, IS_MAC, IS_WIN, keys, OS_NAME, TRASH } from '../lib/platform'
import { GLOSSARY } from './glossary'

export interface Article {
  id: string
  title: string
  category: string
  summary: string
  keywords: string
  body: string
}

export const CATEGORIES = ['Getting started', 'Using Maris', 'Code mode', 'Images and video', `Your ${DEVICE} and models`, 'Settings', 'Help and privacy']

const glossaryBody = (): string =>
  Object.values(GLOSSARY)
    .sort((a, b) => a.term.localeCompare(b.term))
    .map((g) => `**${g.term}**  \n${g.short}${g.article ? ` [More](help:${g.article})` : ''}`)
    .join('\n\n')

export const ARTICLES: Article[] = [
  {
    id: 'welcome',
    title: 'Welcome to Maris',
    category: 'Getting started',
    summary: 'What Maris is, what it can do, and how to start.',
    keywords: 'start introduction overview what is',
    body: `Maris is an AI assistant that runs **on your own ${DEVICE}**. Your conversations, files and pictures stay on it, unless you ask Maris to search the web or choose to answer with a model at an API service (see [Claude, GPT and other API models](help:api-models)).

## What you can do

- **Chat**: ask questions, write and translate texts, get explanations, brainstorm.
- **Work on your ${DEVICE}**: “find my largest files”, “what is slowing my ${DEVICE} down?”, “rename these photos by date”. Maris looks around freely but **asks before it changes anything**. See [Maris asks before changing anything](help:approvals).
- **Code mode**: open a project folder and let Maris build, fix and test it. See [Working on projects in Code mode](help:code-mode).
- **Pictures and videos**: pick **Image** or **Video** next to the globe in the message box and describe what you want. See [Making pictures and videos](help:studio).
- **Memory**: Maris remembers your preferences between chats. See [What Maris remembers](help:memory).
- **Skills and connectors**: teach Maris new kinds of tasks, and link it to services such as GitHub or Notion. See [Skills](help:skills) and [Connectors](help:connectors).
- **Other models and your phone**: answer with Claude, GPT and others through your own key ([API models](help:api-models)), and use Maris from an Android phone ([Maris on your phone](help:phone)).

## Ask Maris about Maris

You do not have to search this help. Ask in a chat: “how do I connect Claude?”, “can you make videos?”, “which models do I have?”, “how do I use you on my phone?”. Maris reads these articles and looks at what is set up on your ${DEVICE}, then answers with a link to the right page.

## Your first minute

1. Type a message at the bottom and press **Enter**.
2. Under each answer you can see which model answered. Point at it to see why.
3. Use the thumbs up and down to tell Maris what you liked; it learns from that.

Lost? Press **F1** any time to open this help.`
  },
  {
    id: 'chatting',
    title: 'Chatting with Maris',
    category: 'Getting started',
    summary: 'Writing messages, attaching files, thinking, web access, fixing answers, branching and exporting chats.',
    keywords: 'message send attach file image paste think web regenerate edit copy feedback thumbs branch fork export save markdown json undo go anywhere ctrl+k',
    body: `## Sending messages

Type in the box at the bottom and press **Enter**. **Shift+Enter** starts a new line. (You can switch to ${keys('Enter')} in Settings → Assistant.)

## Adding files and pictures

- Click the **paperclip**, drag files onto the window, or paste a screenshot with **${keys('V')}**.
- Pictures: models that “see” can describe them, read text in them or answer questions about them.
- Text and code files are read straight into the conversation.

## The buttons under the message box

- **Think: auto / on / off**: with *auto*, Maris thinks step by step only for harder questions. *On* always thinks first (better for puzzles, maths and planning, a little slower).
- **Globe**: lets Maris search the web for this chat. Turn it off for fully offline answers.
- **Text, Image, Video**: what the message makes. *Text* is an answer in words (the usual). *Image* and *Video* make a picture or a clip from your description, with controls for the model, shape, number and length. See [Making pictures and videos](help:studio).
- **The ring with a percentage**: how full the chat's memory span (its *context*) is. Click it to see what fills it. See [How much a chat can keep in mind](help:context).

## Paths in answers

When Maris names a folder or file on your ${DEVICE} in an answer, the path is underlined: click it to open the folder in ${DEVICE === 'Mac' ? 'Finder' : 'Explorer'} (for a file, its folder opens with the file selected).

## New answers in other chats

A chat that finished an answer while you were elsewhere gets a dot at the right of its name. In Code mode the dot also shows on a folded project, and on the **Chat** or **Code** switch at the top when the new answer is in the other mode.

## Fixing an answer

Point at an answer to see its buttons:

- **Copy** the text.
- **Try again** (the circular arrows): ask again, ask with more thinking, or ask a different model.
- **Undo changes** (the curved arrow, only on answers that changed files): puts those files back the way they were. You see the list first. See [Maris asks before changing anything](help:approvals).
- **Branch from here** (the forking line): a new chat with the messages up to this answer, to try another direction while this chat stays as it is.
- **Thumbs up / down**: tell Maris what worked. With thumbs down you can write what to do differently, and Maris remembers it.

Point at your own message and click the **pencil** to edit and resend it.

## Keeping and sharing a chat

Point at a chat in the sidebar, click **…** and choose **Export**: **Markdown** is a tidy text file to read or share, **JSON** keeps everything (for a backup or other programs). In the phone app the menu has **Copy as Markdown** instead.

## Going anywhere

Press **${keys('K')}** (or click **${keys('K')}** in the sidebar's search box) and type: chat titles, settings (“dark”, “timeout”), help articles and words from old messages show up as you type, along with actions such as a new chat or exporting this one. **Enter** opens the one that is highlighted.`
  },
  {
    id: 'approvals',
    title: 'Maris asks before changing anything',
    category: 'Getting started',
    summary: 'What Maris may do freely, what needs your OK, and how to undo changes.',
    keywords: 'approve deny always allow permission safety undo backup recycle bin auto approve session everything',
    body: `Maris can **look** at anything on your ${DEVICE} (files, folders, running programs, system information, the web) without asking. Anything that **changes** something waits for you.

## Needs your approval

- Creating, editing, moving or deleting files
- Running commands that change things (installing software, building programs)
- Opening or closing programs
- Copying text to your clipboard, forgetting memories
- Actions in services you connected, such as creating an issue on GitHub (see [Connectors](help:connectors))

When Maris wants to do one of these, a yellow box appears with **Approve** and **Deny**. Nothing happens until you choose. If you deny, Maris stops and asks what you would prefer. **Deny and say why** lets you write what to do instead (“put it in the notes folder”), and Maris goes on from there. When Maris planned several changes at once, the ones after a denied change are not run. When the change installs software, the box also says how much it downloads and how much disk space it needs.

## Safety nets

- Deleted files go to the **${TRASH}**.
- Edited files are **backed up** first. In Code mode the **Changes** tab can undo any edit with one click.
- **Undo changes** under an answer puts back everything that answer did to files: edited files return to their backup, new files and copies go to the ${TRASH}, moved things move back. You see the list first, the versions it replaces are backed up too, and Maris is told, so later answers know. Commands it ran and actions in other programs cannot be undone this way.

## Fewer questions (optional)

Every approval box has **Always approve**. Tick it before you press **Approve**, and pick in the menu next to it how far it goes:

- **This kind of request**, for example *creating and editing files* or *running commands*: from then on, in every chat. Changes in system folders still ask.
- **A command in this project** (Code mode), for example \`cargo test\`: only that command, only in that project.
- **Everything in this session**: every change in this chat, until you close Maris.
- **Everything, everywhere**: every change in every chat, until you turn it off. Only choose this when you trust everything Maris reads, because a web page or file could talk it into a change you would not have approved.

In Code mode there is also **Auto-approve edits**, a switch at the top of the chat: file edits *inside that project* happen without asking.

## Maris's own settings

You can ask Maris to change its settings ("switch to dark mode", "make the text bigger"). It looks the setting up and asks every time, even when you approve everything else automatically. What Maris may do without asking, full control, the phone link and where updates come from are only changed by you.

## Full control of this ${DEVICE}

Settings → ${DEVICE} access → **Full control of this ${DEVICE}** (off until you turn it on) lets Maris run things as administrator (${IS_WIN ? 'Windows asks with its permission prompt as well' : 'the system asks for your password as well'}) and use the mouse and keyboard in other programs: switching windows, clicking, typing, pressing keys. Each of these waits for your approval like any other change. When a task needs it and it is off, Maris shows a **Turn on full control** button in the chat.

## Seeing and changing what is approved

While anything is approved without asking, a bar above the message box says so (**Approving without asking: …**), and the status bar at the bottom shows it on every page. Click **Change** there (or the status bar item) to switch single rules off, or press **Ask before every change again**. The same switches are in Settings → ${DEVICE} access → **Approve without asking**.`
  },
  {
    id: 'auto',
    title: 'How Auto picks a model',
    category: 'Using Maris',
    summary: 'Fast, Balanced and Max, and why Maris sometimes uses a smaller model.',
    keywords: 'auto model choice router fast balanced max tier busy game battery',
    body: `Maris has three main models, from small to large: **Fast**, **Balanced** and **Max**. With **Auto** (the default in the model menu at the top), Maris picks one for every message:

- Small talk and quick questions go to **Fast**, which answers almost instantly.
- Everyday questions and writing go to **Balanced**.
- Hard problems, coding and multi-step work go to **Max**.

## When it steps down

Auto also looks at your ${DEVICE}:

- A game or a render is using the graphics card → a smaller model, so your game stays smooth.
- Images or video are being made → chat continues on the CPU.
- You are on battery → Max is avoided.

Point at the model name under any answer to see the reason.

## Teaching it

When you use **Try again → with Max** or rate answers, Maris learns which model you prefer for each kind of task. You can switch this off in Settings → Auto model choice.

## Choosing yourself

Open the model menu at the top of a chat and pick a model. That chat then always uses it.

## API models and Auto

A model you added through an API key (Claude, GPT and others) is used by Auto only when you **give it a role** on Models → Text → Roles, or when no model is installed on this ${DEVICE} at all. A chat that goes to such a model is marked with a small cloud. See [Claude, GPT and other API models](help:api-models).

## One model for everything

On a slow ${DEVICE} the setup assistant gives every role the same small model, so nothing has to be loaded in between. Auto then simply answers with that model. See [Maris on a slow or old computer](help:slow-pc).`
  },
  {
    id: 'closing',
    title: 'Closing Maris',
    category: 'Using Maris',
    summary: 'What happens when you close the window, and how to keep Maris in the tray instead.',
    keywords: 'close quit exit tray background vram memory ollama stop server shut down hotkey',
    body: `## Closing the window closes Maris

When you close the window, Maris closes **completely**:

- answers and pictures that are still being made are stopped;
- its models are taken out of memory, so the graphics card is free again;
- the **Ollama** server is stopped as well, and so is the picture engine if Maris started it.

The next time you open Maris, it starts what it needs again. The first answer then takes a little longer, because the model has to load.

## If something is still going on

If an answer is being written, a picture or video is being made, or a download is running, Maris **asks first**. **Keep Maris open** lets it finish; **Close anyway** stops it. What was written so far stays in the chat.

## Keeping Maris in the tray

Turn on **Settings → Window and startup → Keep running in the ${IS_MAC ? 'menu bar' : 'tray'} when closed**. Closing the window then only hides it: Maris stays in the ${IS_MAC ? 'menu bar' : 'tray'}, and **${accelLabel('Control+Shift+Space')}** brings it back from anywhere. After about a minute without work it still gives the graphics card’s memory back; models load again when you need them. **Quit Maris** in the ${IS_MAC ? 'menu bar' : 'tray'} menu closes it completely.

## Leaving Ollama running

If you use Ollama with other programs too, turn off **Settings → Engine → Stop Ollama when Maris closes**. Maris then only unloads its models and leaves the server alone.`
  },
  {
    id: 'code-mode',
    title: 'Working on projects in Code mode',
    category: 'Code mode',
    summary: 'Open a folder, ask for changes, see what Maris did, and undo anything.',
    keywords: 'code project folder build test run fix simple detailed commands hidden changes undo revert files tools',
    body: `Code mode turns Maris into a helper that works **on a whole project folder**: it reads the files, makes changes, builds the program and runs its tests.

## Getting started

1. Click **Code** at the top of the sidebar.
2. Press **New project**: give it a name and Maris makes its folder (with **Open a folder I already have** for an existing project). **Add** next to *Projects* opens an existing folder too.${IS_WIN ? ' (Or right-click a folder in File Explorer and choose **Open in Maris**, if you ticked that when installing.)' : ''}
3. Describe what you want: “add a dark mode”, “the save button crashes, fix it”, “make a small platform game”.

## Projects and tasks

The sidebar lists your projects with their tasks underneath; click a project to fold it open or closed. Point at a project for two buttons: **+** starts a new task in it, and **…** lets you rename it, open its folder, remove it from Maris (the files stay) or open **About this project**. There you can write what the project is about, for example *“A pixel-art platformer for a game jam; keep the 16×16 style and target the browser first”*. Maris reads that before every task in the project.

## Simple or Detailed

At the top of a Code-mode chat you can switch how Maris shows its work:

- **Simple** (default), for people who do not program: each stretch of work is one quiet line, like a thought. While Maris works it says what it is doing (*“Building the app…”*); afterwards *“Worked for 1 min · 9 steps”*. Click the line to read Maris's notes and the steps as plain sentences, such as *“Ran the tests — all 3 passed”*. No commands, code or diffs, and plans are written in everyday words.
- **Detailed**: every command, file and change in full, as developers like it.

Whatever the view, **anything that changes your ${DEVICE} still asks for your approval** first, in plain words, with the technical details one click away. For installs, the approval also says how much will be downloaded and how much disk space it needs.

## The project panel

The panel on the right has three tabs:

- **Files**: browse the project; each kind of file has its own icon and colour, and the list updates by itself whenever files change. Click a file to read it with line numbers. **Select some lines** and press **Mention lines** to add exactly that part to your message (as an attachment), or **Mention file** for the whole file.
- **Changes**: every file Maris added, changed, moved or deleted in this task, marked in colour, with how many lines were added (green) and removed (red), a preview of the change, the full before/after view with line numbers, and an **Undo** button.
- **Tools**: which programming tools are installed, one-click installers, running apps, and commands you chose to always allow.

## Long sessions

Maris keeps working until the task is done (there is no step limit unless you set one in Settings → ${DEVICE} access). If a step keeps failing the same way, Maris is told to try another way, and a stronger model takes over when one can run. When a conversation gets long, Maris summarises the older part automatically so it can keep working; the ring next to the send button shows how full the chat is, and **Summarise now** in it does it yourself. See [How much a chat can keep in mind](help:context).

More tips: [Getting good results in Code mode](help:code-tips).`
  },
  {
    id: 'code-tips',
    title: 'Getting good results in Code mode',
    category: 'Code mode',
    summary: 'How to ask, how to test, and what to do when something does not work.',
    keywords: 'tips ask prompt test build error fails languages haxeflixel rust python csharp cpp web',
    body: `## Ask for outcomes, not steps

“When I click Save, the list should be stored in a file and loaded next time” works better than describing the code. Maris figures out the how.

## Ask it to check its work

Add “and run the tests” or “build it and fix any errors”. Maris then keeps going until it works, or tells you what blocks it.

## One thing at a time

Big wishes work best as a few smaller requests in a row.

## If something goes wrong

- Read the summary under the answer: *Tests pass*, *Build has errors* and so on.
- Say what you saw: “the window opens but the player falls through the floor”.
- Every change can be undone in the project panel → **Changes**.

## Languages Maris knows well

C#, Rust, Python, JavaScript/TypeScript, HTML/CSS, C++ and HaxeFlixel games. If a tool is missing, Maris says so and offers to install it (with your approval), or use the **Tools** tab.`
  },
  {
    id: 'context',
    title: 'How much a chat can keep in mind',
    category: 'Using Maris',
    summary: 'The context ring next to the send button: what fills a chat, and summarising older messages.',
    keywords: 'context window tokens full memory span summarise compact ring percentage',
    body: `A model reads the whole chat every time it answers, but only up to a limit: its **context window**, counted in *tokens* (a token is about three quarters of a word). The ring next to the send button shows how full it is for this chat.

## What fills it

Click the ring to see:

- **Maris's instructions**: how Maris works, your name and folders, the date.
- **Tools**: descriptions of what Maris can do on your ${DEVICE}, and **Connected services** if you added connectors.
- **Skills**, **Memory** (what Maris remembers about you that fits this chat), and the **Project** in Code mode.
- **Messages**, **Tool results** (file contents, command output, web pages) and **Pictures**.
- **Free space**, and a part **kept for the answer**.

## A bigger or smaller window

Under **Window size** in the popover, pick how much the model keeps in view: 8K, 16K, 32K (the default), 64K, 128K and on **up to 1M or 2M tokens**, as far as the model supports. Point at a size to see what it means here:

- **Bigger** keeps more of the chat, files and tool results in view, so older messages are summarised later. It needs more memory, and every step takes a little longer to read.
- When the model and the window fit in video memory (green dot), answers come at full speed. When they do not (yellow dot), the part that does not fit runs from system memory, and writing gets slower; the popover estimates how much (for example *about 2.4× slower*).
- **Smaller** is faster and leaves video memory for games or other programs, but long tasks get summarised sooner.
- A size that needs more memory than this ${DEVICE} has (red dot) cannot be picked. A window of a million tokens takes tens of GB on your own ${DEVICE}, so the very large sizes are mostly for models at an API service.

The choice applies to the model role in use: Code mode, or the Fast, Balanced or Max model in chats. The same sizes are in Settings → Auto model choice → Context windows.

## Models at an API service

For Claude, GPT and other [API models](help:api-models) the size is a **budget**: how much of a long chat is sent with each message, from 16K up to 2M tokens (64K to begin with). A model never gets more than it takes, and Maris fills about four fifths of a model’s window with the chat, so the answer has room. A bigger budget keeps more in view and **costs more per message**, because a full window is sent again every time; services charge less for the part they have cached.

If a service says a chat is too long for its model, Maris leaves the oldest messages out of that request, tries again and remembers the model’s real size.

## When it gets full

Before the window runs out, Maris folds older messages into a short summary, so the chat can go on without forgetting what was decided. The popover says how much room is left before that happens. **Summarise now** does it straight away, for example before starting a big new step.

Long files and command output fill the window quickly. Starting a new chat (or a new task in Code mode) for a new topic keeps answers fast and focused.`
  },
  {
    id: 'studio',
    title: 'Making pictures and videos',
    category: 'Images and video',
    summary: 'The Image and Video modes, writing a good description, fast versus quality, and animating a picture.',
    keywords: 'image picture photo video clip generate draw studio prompt negative seed quality fast size animate mode',
    body: `In any chat, pick **Image** or **Video** next to the globe in the message box, describe what you want and press **Enter**. The picture engine starts warming up as soon as you pick the mode, so it is ready when you are. You can also simply ask in a normal message: “draw a cozy cabin in a snowy forest at dusk”.

## The controls

- **Model**: *let Maris pick*, or one of the models you installed.
- **Quality** (when Maris picks): *Fast* for ideas in seconds, *Best* for detail, *Auto* decides from your wording.
- **Shape**: square, portrait, landscape or wide.
- **How many** pictures, or the **length** of a clip.

The line under the controls says about how long it takes on your ${DEVICE}.

## Writing a good description

Describe the **subject**, the **style** (photo, oil painting, anime, 3D render), the **lighting** and the **mood**. For example: *“A red fox sitting in tall grass at sunrise, soft golden light, shallow depth of field, photograph.”*

Things you do not want go in **Avoid** (the negative prompt), such as *blurry, text, watermark*.

## Fast or quality

- **Fast** models make a picture in seconds; great for ideas.
- **Quality** models take longer and add detail.
- **Auto** chooses from your wording: “quick sketch” goes fast, “detailed poster” goes for quality.

## Video

Video takes minutes per clip. Pick the length. To **animate a picture**, attach it (paperclip, drag it in, or paste it) while Video is picked: the clip starts from that picture. Some video models only animate pictures; they say “needs a picture”.

## Choosing a model

**Models → Pictures** and **Models → Videos** list every model with **examples** made with that very model: click one to see it full size, and **Use this prompt** opens a new chat in Image or Video mode with that model and prompt ready. Each card also says what the model is good and less good at, how long one result takes **on your ${DEVICE}** (estimated from your hardware at first, then measured), what it needs from your graphics card, its files and its licence. **Roles** at the top choose which model Maris uses for quick and for best results.

## While it works

A picture or video in a chat shows which model is making it, how far along it is and about how long is left. **Stop** cancels it; the buttons below switch to another installed model (faster, or more detail) and start again with it.

While the graphics card is busy, other chats keep working: if the picture is nearly done they wait a few seconds for it, otherwise they answer on the processor (slower; quick questions use the small helper model) and say so.

## Where creations go

Everything you make stays in its chat, appears under **Your pictures** and **Your videos** in Models, and is saved in your data folder (Settings → Data and setup). **Animate** under a picture there starts a clip from it.

## The engine runs by itself

The picture engine (ComfyUI) starts when something is made and stops on its own after a quiet spell (20 minutes unless you change it in Settings → Images and video), so your graphics card is free for games. The very first picture after installing takes a few extra minutes while it sets itself up.`
  },
  {
    id: 'memory',
    title: 'What Maris remembers',
    category: 'Using Maris',
    summary: 'How memory works, how Maris learns, and how to edit or delete memories.',
    keywords: 'memory remember forget learn preferences facts privacy edit delete pin',
    body: `Maris keeps short notes about you between chats: preferences (“answer in Russian”), facts (“I use a 16 GB graphics card”), projects and useful know-how.

## How memories are made

- You ask: “remember that I prefer metric units”.
- Maris learns on its own: after a chat goes quiet, it picks out things worth keeping.
- Your thumbs-down notes become lessons.

## Seeing and changing them

Open **Memory** in the sidebar. You can edit any memory, **pin** important ones so they are always used, or delete them. The **Learning** list shows what Maris learned and when.

## Turning it off

Settings → Memory lets you stop using memories in chats, or stop learning automatically. Memories never leave your ${DEVICE}.`
  },
  {
    id: 'web',
    title: 'Searching the web',
    category: 'Using Maris',
    summary: 'When Maris goes online, which search engine it uses, and how to stay offline.',
    keywords: 'web internet search browse online offline duckduckgo brave searxng',
    body: `Maris can search the web and read pages when an answer needs current information: news, prices, documentation.

- The **globe** button under the message box turns web access on or off for a chat.
- Settings → Web turns it off everywhere, and lets you pick the search service: **DuckDuckGo** (no account needed), **Brave Search** (needs a free key) or your own **SearXNG**.

Pages are opened in a hidden, locked-down browser inside Maris. You see a small preview of each page it read. Maris lists its sources as links.

With web access off, nothing leaves your ${DEVICE}.`
  },
  {
    id: 'updates',
    title: 'Updates and news',
    category: 'Using Maris',
    summary: 'How Maris updates itself, and the news posts.',
    keywords: 'update new version upgrade install download release restart news posts blog announcements check badge markdown',
    body: `You install Maris once. After that it updates itself from inside the app: there is no second installer to download or click through.

While your ${DEVICE} is online, Maris looks for a new version and new posts a few times a day. When it finds a new version, it downloads it in the background and checks it against the fingerprint (SHA-256) published with the release; a download that does not match is thrown away.

## Installing an update

1. When the new version is ready, **Restart to update** appears at the bottom of the sidebar, and **Updates & news** shows it with **What is new**.
2. Press **Restart to update** (or **Restart and update** on the Updates & news page). ${IS_WIN ? 'Maris closes, updates itself in about a minute without any setup windows, and opens again. If Maris is installed for all users, Windows asks for permission once.' : IS_MAC ? 'The disk image opens: drag Maris into Applications, replacing the old copy, and start it again.' : 'Maris replaces its AppImage and restarts on the new version.'}
3. Your chats, memories, models and settings stay as they are. Updates & news says **Maris updated itself** when it is done.

If Maris is still writing an answer or making a picture, it asks before restarting. Nothing is installed until you press the button. To download only when you choose, turn off Settings → Updates and news → **Get new versions ready in the background**.

## News

Below the update box are posts from the people who make Maris: new features, tips and notes about updates. Posts you have not opened yet are marked **New**. Pictures are kept on your ${DEVICE}, so posts you have read also open offline.

The posts come from the **news** folder of Maris's repository on GitHub: the ones written on the Admin page, and any Markdown file (\`.md\`) put into that folder in git. A file's first heading becomes the post's title, the date at the start of its name (2026-11-05-name.md) its date, and its first paragraph the summary.

## Changing how often Maris looks

**Check now** at the top of the page looks right away. Settings → **Updates and news** sets how often Maris looks, and turns the update check or the news off. Looking only downloads the list of versions and posts; nothing about you or your chats is sent.`
  },
  {
    id: 'terminal',
    title: 'Using Maris from the terminal',
    category: 'Using Maris',
    summary: 'The maris command: chat, work on folders and make pictures from a terminal window.',
    keywords: 'terminal command line cmd powershell console maris path shell pipe bash zsh',
    body: `Type **maris** in a terminal window${IS_WIN ? ' (Terminal, PowerShell or Command Prompt)' : ''} to chat with Maris there. It uses the same models, memory and approvals as this window, and its chats show up in the sidebar with a small terminal mark.

## Turning it on

${IS_WIN ? 'The installer offers it on its **Extras** page. You can also turn it on or off in ' : 'Turn it on in '}Settings → Window and startup → **Terminal command**. Open a new terminal window afterwards.

## Examples

| Type | What happens |
| --- | --- |
| \`maris\` | A chat in the terminal. \`/help\` lists the commands. |
| \`maris "how much space is left on C:?"\` | Asks once and prints the answer. |
| \`maris code .\` | Works on the current folder in Code mode. |
| \`git diff \| maris "write a commit message"\` | Sends another command's output along with the question. |
| \`maris -f photo.jpg "what plant is this?"\` | Attaches a file or picture. |
| \`maris image "a red fox in fresh snow"\` | Makes a picture. |
| \`maris -c\` | Continues your last terminal chat. |
| \`maris open\` | Shows that chat in this window. |

## Approving changes

When Maris wants to change something, it asks in the terminal with single keys: **y** allow, **n** deny, **a** always allow this kind of request, **s** allow everything in this chat, **d** details. **Ctrl+C** stops an answer; **Ctrl+D** leaves.

If Maris is not running, the command starts it in the background first.`
  },
  {
    id: 'phone',
    title: 'Maris on your phone',
    category: 'Using Maris',
    summary: `The Android app: pairing it with this ${DEVICE}, what it can do, and how the link is protected.`,
    keywords: 'phone android mobile app link pair pairing qr code wifi remote tablet apk tailscale vpn firewall anywhere away relay cellular internet outside',
    body: `The **Android app** shows this Maris on your phone: the same chats, Code mode, approvals, pictures and settings. Everything still runs on this ${DEVICE}; the phone is a window onto it, so the ${DEVICE} has to be on with Maris open.

## Getting the app

Download **Maris-Link-…-Android.apk** from the same releases page the installer came from (github.com/MarySueXLsD/Maris-Local-AI/releases/latest) and install it on a phone with Android 7 or newer. There is no iPhone app.

## Pairing

1. On this ${DEVICE}, open **Settings → Phone** and turn on **Allow the phone app to connect**.
2. Press **Pair a phone**. A QR code, an address and a one-time code appear.
3. Open Maris on the phone, tap **Scan code** and point the camera at the QR code, or type the address and the code. Without **Connect from anywhere**, the phone must be on the same Wi-Fi as this ${DEVICE}.

Paired phones are listed under **Paired phones**; **Remove** next to one means it can no longer connect.

## Away from home

Turn on **Connect from anywhere** in Settings → Phone, and the phone reaches this ${DEVICE} on mobile data or any other Wi-Fi too, through the **Maris relay**. Nothing has to be set up on your router. At home the phone still connects directly; away it goes through the relay, and it switches back by itself.

Everything stays end-to-end encrypted with the key the phone and this ${DEVICE} agreed on when you paired them: the relay passes messages on and cannot read them. It does see that this ${DEVICE} and the phone are connected, when, and how much they send. Phones paired before you turned it on learn the way the next time they connect at home; a new phone can also pair from anywhere by scanning the code.

## What the phone may do

The phone can chat, work in Code mode, make pictures and change most settings. It cannot install updates, run the setup assistant, open folders or programs on this ${DEVICE}, change the link itself or the addresses Maris sends chats to. With **Approve changes from the phone** off, the phone shows what Maris wants to change, but you [approve](help:approvals) it at this ${DEVICE}, and the phone cannot install models, add connectors or turn on automatic approvals or full control either.

## How it is protected

The link is **off until you turn it on**. At home it only accepts devices on your own network (or a VPN such as Tailscale); away from home only through the relay. Pairing uses a one-time code that never travels over the network, and everything between the phone and this ${DEVICE} is encrypted, so neither the network nor the relay can read or change it.

## If the phone cannot connect

- At home: check that both are on the same Wi-Fi, and not on a guest network that keeps devices apart.
- Allow Maris through this ${DEVICE}’s firewall for private networks.
- Another program may already use the port: change **Network port** in Settings → Phone and pair again.
- Away from home: check that **Connect from anywhere** is on and Settings → Phone says Maris is connected to the relay.`
  },
  {
    id: 'skills',
    title: 'Skills: teaching Maris new tasks',
    category: 'Using Maris',
    summary: 'What a skill is, installing one from a git address or a folder, and turning skills off.',
    keywords: 'skills skill.md git github install teach instructions abilities anthropic repository folder',
    body: `A **skill** is a set of written instructions for one kind of task, for example *making a PowerPoint deck* or *writing release notes the way your team does*. It is a folder with a file called **SKILL.md**, sometimes with examples or scripts next to it. Many are shared on GitHub.

Maris knows the name and the one-line description of every skill you turned on. When your request matches one, it reads the full instructions first (the answer shows **Use the skill “…”**) and then follows them.

## Installing skills

1. Open **Skills** in the sidebar.
2. Paste a git address, such as \`https://github.com/anthropics/skills\` or simply \`owner/repository\`, and press **Install**. A GitHub link to one folder installs only that folder.
3. Or press **From a folder** to add skills that are already on your ${DEVICE}.

One repository can hold many skills: every folder in it with a SKILL.md becomes one.

## Managing skills

- Click the arrow next to a skill to read its instructions.
- The **On** box turns one skill on or off. **Let Maris use skills** at the top turns all of them off.
- **Update** downloads the newest version from the same address. **Remove** deletes Maris's copy.

## Safety

A skill can only tell Maris what to do. Anything that would change your ${DEVICE} still waits for your [approval](help:approvals), even when a skill asks for it. Install skills from people you trust, and read the instructions if you are unsure.`
  },
  {
    id: 'connectors',
    title: 'Connectors: linking Maris to other services',
    category: 'Using Maris',
    summary: 'Connect GitHub, Notion, Home Assistant and more, and what Maris may do there.',
    keywords: 'connectors connect services mcp model context protocol github notion hugging face brave home assistant context7 deepwiki stripe api key token integration node',
    body: `A **connector** lets Maris use another service: look through issues on GitHub, read your Notion pages, switch the lights in Home Assistant. Connectors use the **Model Context Protocol (MCP)**, an open standard that many services support.

## Adding a connector

1. Open **Connectors** in the sidebar and pick a service.
2. Most services need a key or token. **Where do I get this?** opens the page where you create one.
3. Press **Connect**. When it works, the connector says **Connected** and how many tools it brings.

Ready to pick: **GitHub**, **Notion**, **Hugging Face**, **Brave Search**, **Home Assistant**, **Context7**, **DeepWiki** and **Stripe**. **Other service** connects any MCP server by its web address, or one that runs as a program on your ${DEVICE}.

Notion and Brave Search run a small program with **Node.js**. If Maris says Node.js is missing, install it from nodejs.org and press **Reconnect**.

## What Maris may do

Click the arrow next to a connector to see its tools. Tools marked **reads** only look things up and run freely. Tools marked **asks first** can change something in that service, such as creating an issue, so they wait for your [approval](help:approvals) just like changes on your ${DEVICE}. To let them run without asking, choose **Always approve** → *actions in connected services*.

## Keys and privacy

Keys and tokens are stored encrypted on your ${DEVICE}. When Maris uses a connector, its request goes to that service, so the service sees what Maris asks it. **Remove** deletes a connector with its key; **Let Maris use connectors** at the top turns them all off.`
  },
  {
    id: 'your-pc',
    title: `Your ${DEVICE} explained: GPU, VRAM, RAM and CPU`,
    category: `Your ${DEVICE} and models`,
    summary: `What the parts of your ${DEVICE} do for AI, in plain words.`,
    keywords: 'gpu vram ram cpu graphics card memory processor hardware nvidia amd intel ollama kv cache flash attention context memory compact',
    body: `AI models need two things: **memory** to hold them and **chips** to run them.

| Part | What it does for Maris |
| --- | --- |
| **GPU** (graphics card) | Runs models very fast. The most important part. |
| **VRAM** (the graphics card’s memory) | Holds the model while the GPU runs it. Its size decides how big a model can run at full speed. |
| **RAM** (system memory) | Can hold models too, but they run several times slower from there. |
| **CPU** (processor) | Can run models without a graphics card; slower, but it works. |

## A rule of thumb

- A model that fits **completely in VRAM** answers fast.
- If it is a bit too big, part of it runs from **RAM**: it still works, more slowly.
- Without a supported graphics card, everything runs on the **CPU**. Small models and “mixture of experts” models still feel quick.

## The conversation needs VRAM too

Besides the model itself, the graphics card holds what the model is reading: the conversation, files and results. The longer the [context window](help:context), the more VRAM that takes. Settings → Engine → **Context window memory** stores it more compactly: *Compact* (the default) takes half the space of *Full* with practically the same answers, *Smallest* a quarter, with a little loss. Together with **Flash attention** this keeps bigger windows on the graphics card, so long chats stay fast.

## The engines

Maris uses two free engines in the background: **Ollama** for language models and **ComfyUI** for pictures and video. Maris installs and starts them for you.

The [setup assistant](help:setup) looks at your ${DEVICE} and picks models that fit.`
  },
  {
    id: 'models',
    title: 'Models explained: size, speed and context',
    category: `Your ${DEVICE} and models`,
    summary: 'What 9B, Q4, tokens per second and context window mean.',
    keywords: 'model size parameters billion quantization q3 q4 tokens speed context window moe mixture experts',
    body: `## Size

Model names include a size such as **4B** or **27B**: billions of parameters, the numbers that make up the model. Bigger usually means smarter, slower and hungrier for memory.

## Quantisation (Q3, Q4)

To fit on normal PCs, models are stored with less precise numbers. **Q4** is the usual sweet spot; **Q3** is smaller with slightly lower quality. A Q3 that fits entirely on your graphics card usually beats a Q4 that does not.

## Speed

Models write in **tokens** (about ¾ of a word). Speed is shown in tokens per second:

- 5–10: about reading speed
- 20–40: fast
- 100+: instant

## Context window

How much text the model can keep in mind: the conversation, attached files, project code. **16K** is roughly 12,000 words. Larger windows use more memory; Maris summarises long chats so they still fit.

## Mixture of experts

Some big models (marked **A3B**, **A4B**…) only use a small part of themselves for each word. They are much faster than their size suggests, even from RAM or on the CPU.

You can see your models, their roles and their sizes on the **Models** page.`
  },
  {
    id: 'api-models',
    title: 'Claude, GPT and other API models',
    category: `Your ${DEVICE} and models`,
    summary: `Adding a model service with an API key, picking its models, and what leaves your ${DEVICE}.`,
    keywords: 'api key claude anthropic sonnet opus haiku openai gpt chatgpt gemini google openrouter groq mistral deepseek grok xai lm studio llama.cpp cloud service remote provider connect add account subscription bill cost price pricing usage tokens spend money budget',
    body: `Besides the models on your ${DEVICE}, Maris can answer with models that run **somewhere else**: Claude, GPT, Gemini and many more. You need an account with the service and its **API key** (a long password meant for programs). This is optional: without it, nothing changes.

It is also a good way to get strong, fast answers on a ${DEVICE} that is too slow for big models.

## Adding a service

1. Open **Models → API**.
2. Click the service: Claude, OpenAI, Google Gemini, OpenRouter, Groq, Mistral, DeepSeek or xAI. **Where do I get a key?** opens the right page of that service.
3. Paste the key and click **Connect**. Maris reads the service’s list of models, which also checks the key.

**LM Studio**, **llama.cpp server** and **Other service** are for a model server on your own ${DEVICE} or network, or any service with an OpenAI-compatible address. They take an address and often need no key.

## Picking models

Every service lists its models with a checkbox. Ticked models appear in the **model menu** at the top of each chat, under the service’s name.

Maris reads the list from the service itself, so **new models show up without a new version of Maris**. **Refresh** reads it again; that also happens by itself once a day. Is a model missing? Type its id into the box under the list.

## Using them

- Pick the model in the model menu of a chat. That chat then always uses it, and a small cloud marks it.
- To let **Auto** use one, give it a role on **Models → Text → Roles** (Fast, Balanced, Max or Code).
- If no model is installed on this ${DEVICE} at all, Auto answers with one of your API models.

Everything else works as usual: tools, Code mode, memory, connectors. Maris still **asks before it changes anything**.

## What leaves your ${DEVICE}

A chat with an API model is **sent to that service**: your messages, and what Maris reads for the task (file contents, command output, the memories that fit). The service’s own terms apply, and it **bills your account** for what is sent and answered. The line under the message box says where a message will go before you send it.

Chats with models on your ${DEVICE} stay on your ${DEVICE}, as before. Services marked **On this computer** stay local too.

Keys are stored encrypted with the system keychain, are only ever sent to their own service, and are never shown again. **Remove** deletes a service together with its key.

## What it costs

A service charges your account for the **tokens** a model reads and writes (a token is about ¾ of a word), at a price per million tokens that differs from model to model.

- **Under each answer** from an API model Maris shows what it came to, for example **$0.012**. Point at it to see the tokens behind it.
- **Models → API → Use and cost** adds it up: today, this month and in all, and per model.
- **Next to each model** is its price, for example **$4 / $20**: dollars per million tokens read and written. The model menu of a chat shows it too.

The token counts are the service’s own. The prices come from the service where it lists them, otherwise from a public list of the makers’ prices that Maris looks up once a day (at openrouter.ai; nothing about you is sent, and Settings → Engine turns it off). So a new model is priced without a new version of Maris. Click a price to set **your own**: for a model the list does not know, or a rate you agreed with the service.

All of this is an **estimate**; what the service bills you is what counts. A long chat is sent again with every message, so its messages cost more as it grows. Services charge much less for the part they have cached.

**A monthly guide.** Settings → Engine → *Monthly guide for API costs* takes an amount in dollars. Maris tells you in the chat when the month’s costs pass 80% of it, and again when they pass it. It never stops answering because of it.

The record stays on this ${DEVICE}. **Clear** on the same page empties it, and Settings → Engine → *Keep a record of API use* turns it off.

## When a model cannot do something

Models differ: some cannot use tools, see pictures or think step by step, and some services refuse certain options. Maris learns this from the service (its model list, or its first refusal), adapts the request and remembers. For a model without tool calling, for example, it describes the tools in plain text instead. There is nothing to set up.

Thinking differs too. Some newer models think by themselves unless told not to, and a few cannot be told. With **Think: off** Maris turns thinking off where the model allows it; where it does not, the thinking is shown rather than left running unseen. **Think: on** asks such a model for more effort.

## When an answer is declined or cut short

If a service declines a request or stops at its length limit, Maris says so under the answer and does not run a half-written action.`
  },
  {
    id: 'slow-pc',
    title: 'Maris on a slow or old computer',
    category: `Your ${DEVICE} and models`,
    summary: 'Low-power mode, small models, and how to get useful answers without a graphics card.',
    keywords: 'slow old computer laptop cpu only no gpu graphics card low-power lite small model 4 gb 8 gb ram weak',
    body: `Maris works without a graphics card, on processors that are more than ten years old, and with as little as 4 GB of memory. Everything is slower there, so Maris does less work for each answer.

## What the setup assistant picks

It measures the processor and the memory. On a slow ${DEVICE} it picks **one small model for every role**, so nothing is loaded twice, and gives it a small context window. For example:

| The computer | Model | Writing speed |
| --- | --- | --- |
| 4 GB memory, 2 old cores | Qwen3 0.6B | about reading speed |
| 4 GB memory, a newer processor | Qwen 2.5 1.5B | faster than you read |
| 8 GB memory, 4 cores | Phi-4 mini | about reading speed |

Small models are good at chatting, summarising, rewriting and simple tasks on your ${DEVICE}. They make more mistakes than big ones, most of all in long tasks with many steps. **Models → Text** lists more of them under “Small and older models for slow computers”.

## Low-power mode

On such a ${DEVICE} Maris turns on **low-power mode** by itself; the status bar then shows **Low-power**. In this mode Maris:

- sends the model short instructions and only the tools a request needs, so the answer starts much sooner;
- makes no extra model calls: the chat is named after your first words, and the request is not graded first;
- keeps the context window small and summarises older messages earlier;
- shows a plain window without blur and animations, and checks the system less often.

Change it under **Settings → Engine → Low-power mode**: Auto, On or Off.

## Models without tool calling

Very small and older models cannot call tools the way newer ones do. Maris then describes its tools in plain text and reads the model’s request back out of its answer. So even those models can list a folder, read a file or search the web, and Maris still asks before any change.

## Getting more out of it

- **Use an API model for the hard things.** With a key for Claude, GPT or another service, a strong model answers quickly on any ${DEVICE}. See [Claude, GPT and other API models](help:api-models).
- Start a new chat for a new topic: short chats are read much faster.
- Close the browser and other heavy programs while Maris answers.
- Pictures can be made on the processor with 8 GB of memory or more, at a few minutes each. Video needs a graphics card.`
  },
  {
    id: 'setup',
    title: 'The setup assistant and choosing models',
    category: `Your ${DEVICE} and models`,
    summary: `How the ${DEVICE} scan works, GPU only versus GPU + CPU, and running setup again.`,
    keywords: 'setup assistant scan recommend install download gpu only hybrid cpu only rerun',
    body: `The setup assistant opens the first time you start Maris. You can run it again any time: Settings → Data and setup → **Run setup**, or **Recommend for this ${DEVICE}** on the Models page.

## 1. Scan

Maris reads your graphics card, memory, processor and disks. Nothing is installed or changed.

## 2. Where models run

- **GPU only**: fastest. Every model fits fully on the graphics card.
- **GPU + CPU**: bigger, smarter models. The part that does not fit on the graphics card runs from RAM, so answers are slower.
- **CPU only**: no graphics card needed, and your GPU stays free for games.

Each option shows the strongest model you would get and how fast it writes.

## 3. Models

For every role (Fast, Balanced, Max, Code, images, video) you see the recommended model, a bar showing how it fits in **video memory** (violet) and **RAM** (gold), its speed and its download size. Change any of them with the menu.

## 4. Install

Downloads run one after another. You can start using Maris right away; models switch on as they finish.

## On a slow computer

Without a graphics card that can run models, and with little memory or an old processor, the assistant picks one small model for every role and turns on low-power mode. See [Maris on a slow or old computer](help:slow-pc). You can also skip the downloads and use [API models](help:api-models) only.`
  },
  {
    id: 'status-bar',
    title: 'Reading the status bar',
    category: `Your ${DEVICE} and models`,
    summary: 'What the numbers at the bottom of the window mean.',
    keywords: 'status bar cpu gpu vram ram temperature power load idle busy',
    body: `The thin bar at the bottom shows how hard your ${DEVICE} is working, all the time:

- **CPU**: how busy the processor is.
- **RAM**: system memory in use.
- **GPU**: how busy the graphics card is.
- **VRAM**: graphics memory in use. Point at it to see how much belongs to Maris and how much to other programs. When other programs fill half of it or more, it also lists the three that use the most, each with an **×** to end it (like End task in Task Manager). Maris asks before ending anything, and never offers to end parts of ${IS_WIN ? 'Windows' : 'the system'} itself.
- **Temperature** and **power** of the graphics card.
- On the right: whether Maris is **idle** or **working**, and which models are loaded. **Low-power** appears there when [low-power mode](help:slow-pc) is on, and **API models** when no model runs on this ${DEVICE} and answers come from a service.

Point at any part for details. You can hide parts in Settings → Status bar.

When other programs use the graphics card heavily (a game, a video export), the bar says **Heavy load** and Auto switches to smaller models.`
  },
  {
    id: 'themes',
    title: 'Themes and colours',
    category: 'Settings',
    summary: 'Neon, light and dark themes, your own custom theme, text size and accessibility.',
    keywords: 'theme colors neon purple pink sakura midnight forest ember daylight custom dark light accent font size contrast',
    body: `Open **Settings → Appearance**.

## Colour themes

Pick a card under **Colour theme**:

- **Maris**: violet and gold, light or dark (or matching ${OS_NAME}).
- **Neon Purple** and **Neon Pink**: dark themes with glowing buttons.
- **Sakura**: soft pink and light.
- **Midnight**, **Forest**, **Ember**: calm dark themes.
- **Daylight**: crisp and bright.
- **Custom**: choose your own background, panels, text, accent and highlight colours, and whether it glows. Use **Start from** to begin from any preset.

**Accent colour** further down changes just the accent of any theme.

## Easier to read

- **Text size** makes everything larger or smaller.
- **High contrast** uses solid backgrounds and stronger borders.
- **Reduce motion** turns off animations (and the neon glow).
- **Explain technical words** underlines terms like VRAM; point at them for a short explanation.`
  },
  {
    id: 'settings',
    title: 'Changing settings',
    category: 'Settings',
    summary: 'Finding a setting, resetting it, and saving your settings to a file.',
    keywords: 'settings search reset default export import backup temperature sampling generation',
    body: `Open **Settings** in the sidebar (or press **${keys(',')}**).

- **Search** at the top finds any of the 100+ settings, for example “VRAM”, “dark” or “timeout”.
- A **violet dot** next to a setting means you changed it; the **arrow** next to it puts it back.
- **Reset section** resets a whole page.
- **Data and setup** lets you export your settings to a file, import them on another ${DEVICE}, or reset everything. Your chats, memories and models are never touched by a reset.

## A few useful ones

- **Assistant → Answer length**: short, balanced or detailed answers.
- **Assistant → Explain things for**: plain language or technical.
- **Generation**: how creative each model is (temperature) and whether it runs on the GPU or CPU.
- **Engine → Where models run**: GPU only, GPU + CPU or CPU only.`
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    category: 'Settings',
    summary: 'Every shortcut in one place.',
    keywords: 'keyboard shortcuts hotkey keys ctrl enter escape f1 command palette go anywhere search ctrl+k',
    body: `| Keys | What it does |
| --- | --- |
| **Enter** | Send (Shift+Enter for a new line) |
| **Esc** | Stop the answer |
| **${keys('K')}** | Go anywhere: chats, settings, help articles, words in old messages and common actions |
| **${keys('N')}** | New chat (new task in Code mode) |
| **${keys(',')}** | Settings |
| **${keys('B')}** | Show or hide the sidebar |
| **F1** | Help |
| **${accelLabel('Control+Shift+Space')}** | Show Maris from anywhere in ${OS_NAME} (change it in Settings → Window and startup) |
| **${keys('V')}** | Paste a screenshot into the message |

Everything also works with the keyboard alone: **Tab** moves between controls and **Enter** or **Space** presses them.`
  },
  {
    id: 'troubleshooting',
    title: 'When something goes wrong',
    category: 'Help and privacy',
    summary: 'Slow answers, “Ollama is stopped”, antivirus warnings, and failed downloads.',
    keywords: 'problem error slow stopped ollama not responding antivirus norton download failed comfyui memory crash crashed closed unexpectedly stuck waiting next step',
    body: `## “Ollama is stopped”

Maris starts Ollama when it opens and stops it when it closes (see [Closing Maris](help:closing)), so this message means it could not be started or was closed by something else. Click the red message in the status bar to start it. If that does not work, run the [setup assistant](help:setup) again; it can reinstall Ollama.

## An API model gives an error

The message says what the service answered. The usual causes: the key was mistyped or revoked (**Models → API → Change the key or address**), the account is out of credit, the service is limiting requests for a moment, or the model was withdrawn (**Refresh** the service’s models and pick another). Chats with models on your ${DEVICE} keep working meanwhile.

## Answers are slow

- Check the status bar: is a game or another program using the graphics card? Auto already uses smaller models then.
- Pick a smaller model from the model menu, or switch **Settings → Engine → Where models run** to **GPU only**.
- No graphics card, or an old ${DEVICE}? See [Maris on a slow or old computer](help:slow-pc).
- The very first answer after starting loads the model and takes longer.

## Maris seems to do nothing between steps

After a step such as reading files or running a command, the model reads the results before it answers or takes the next step. A line with a timer (**Reading the results…**, then **Working on the next step…**) shows that it is still working. Long results and big models take longer; **Stop** ends it.

## “The model's process stopped unexpectedly”

The program that runs the model closed in the middle of an answer, usually because the graphics card ran out of memory or another program took it. Maris starts the step again once on its own; this message means it stopped a second time. Try again, close games or other programs that use the graphics card, or pick a smaller model.

## “The model did not start answering”

Big models can take a while to load the first time. Try again; if it keeps happening, raise the time limit in **Settings → Engine**.

## The first picture takes ages

The image engine sets itself up the first time (2–5 minutes). Later pictures take seconds.

## My antivirus blocked Maris

Some antivirus programs are suspicious of new apps that run commands. If Maris freezes or disappears, open your antivirus history and allow **${IS_WIN ? 'Maris.exe' : 'Maris'}**.

## A download stopped

Downloads resume where they stopped. Run the setup again or click **Install** again on the Models page (Text, Pictures or Videos).

Still stuck? The log file is in the app data folder (Settings → Data and setup → Open app data → logs).`
  },
  {
    id: 'privacy',
    title: `Privacy: what stays on your ${DEVICE}`,
    category: 'Help and privacy',
    summary: 'Where your data lives and the only times Maris goes online.',
    keywords: 'privacy data local offline online internet where stored delete',
    body: `Maris runs on your ${DEVICE}. Your conversations, files, memories and creations **stay on it**, with the exceptions listed here. Each of them is something you turn on yourself.

## When Maris goes online

- **Web search**, when you allow it (the globe button).
- **Downloading** models and engines, when you install them.
- **Looking for updates and news** a few times a day. Only the list of versions and posts is downloaded; nothing about you is sent. Turn it off in Settings → Updates and news.
- **Installing a skill** from a git address, once.
- **Connectors you add.** When Maris uses one, its request goes to that service.
- **API models you add** (Claude, GPT and others). A chat that uses one is sent to its service: your messages and what Maris reads for the task. This only happens when you pick such a model for a chat or give it a role, or when no model is installed on this ${DEVICE} at all. See [Claude, GPT and other API models](help:api-models).

That is all. Maris itself has no accounts, no tracking and no cloud of its own.

## Where things are stored

- Chats, memories and settings: the app data folder (Settings → Data and setup → Open app data). API keys are kept there too, encrypted with the system keychain.
- Models, the image engine and your pictures and videos: the data folder you chose in setup.

## Deleting things

- Delete a chat from its **…** menu in the sidebar.
- Delete memories on the **Memory** page.
- Remove models on the **Models** page: language models under Text, picture and video models under Pictures and Videos.`
  },
  {
    id: 'glossary',
    title: 'Glossary',
    category: 'Help and privacy',
    summary: 'Short explanations of the technical words you see in Maris.',
    keywords: 'glossary words terms meaning definitions jargon',
    body: ''
  }
]

// The glossary article is generated so it always matches the hover explanations.
ARTICLES.find((a) => a.id === 'glossary')!.body = `Point at an underlined word anywhere in Maris to see its explanation. Here they all are.\n\n${glossaryBody()}`

export const articleById = (id: string): Article | undefined => ARTICLES.find((a) => a.id === id)
