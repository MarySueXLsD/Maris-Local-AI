# Privacy policy

Maris is a private assistant that runs on your own computer. This page says exactly what stays on your
computer, what goes over the network and when, and what is never collected.

## What stays on your computer

- **Your chats, projects and tasks**, in a database in your Maris profile folder
  (Windows: `%APPDATA%\Maris`; macOS: `~/Library/Application Support/Maris`; Linux: `~/.config/Maris`).
- **What Maris remembers about you** (Memory), in the same database. You can see, edit and delete every
  memory on the Memory page.
- **Pictures and videos you make**, in your data folder (Settings → Data).
- **The AI models**, which run on your computer through Ollama (language) and ComfyUI (pictures and
  video). Your messages, files and pictures are processed by them locally and are not sent anywhere.
  The one exception is a model you add yourself through an API key; see "API models" below.
- **Keys and tokens** you give Maris (API keys, connectors, the admin token, a search key) are encrypted
  with your system's keychain and never shown again.
- **The record of what your API models used and cost**, per day and model, in the same database.
  Models → API shows it and can clear it; Settings → Engine turns it off.

## When Maris uses the network

Only for these things, and only when they happen:

| What | Where it connects | When |
| --- | --- | --- |
| Downloading models | The Ollama library, Hugging Face | When you install a model |
| Setting up the engines | ollama.com, GitHub (ComfyUI releases) | When setup installs them |
| Web search and reading pages | DuckDuckGo, Bing, Brave Search or your own SearXNG, and the pages it reads | Only while web access is on for that chat |
| Updates and news | GitHub (the Maris-Local-AI repository) | When Maris checks for a new version or posts (Settings → Updates) |
| Skills | The git repository or address you paste | When you install or update a skill |
| Connectors | The service you connected (GitHub, Notion, …) | When Maris uses one of its tools for you |
| API models | The service whose key you added (Anthropic, OpenAI, Google, OpenRouter, …) | When a chat is answered by one of that service's models, and when Maris reads its list of models (on adding it, on Refresh and once a day) |
| List prices of API models | openrouter.ai (its public list of models and prices) | Once a day, only while a service on the internet is set up and Settings → Engine → "Look up list prices" is on. A plain download: no key, nothing about you or your chats |
| Phone link | Your phone, on your own network only, encrypted | When you pair a phone and use it |
| Phone link from anywhere | The Maris relay (a Cloudflare Worker, see [relay/README.md](../relay/README.md)), which passes the phone's messages on, end-to-end encrypted: it cannot read them, but sees when and how much is sent and from which addresses | Only while Settings → Phone → "Connect from anywhere" is on |

What Maris sends in a web search is the search words for that question. Connectors send what a tool
needs (for example the name of a repository); anything that changes something in a service waits for
your approval first.

## API models

Maris works without any of this. If you add a model service under Models → API, then:

- A chat that is answered by one of its models is **sent to that service**: your messages in that chat,
  the instructions Maris gives the model, and what Maris reads for the task (file contents, command
  output, web pages, the memories that fit the question, and pictures you attach). The service's own
  privacy terms apply to it, and the service bills your account.
- That happens only when you **pick such a model for a chat** or **give it a role** (Models → Text →
  Roles), or when no model is installed on your computer at all. Otherwise Auto never chooses it. Chats
  that go to a service are marked with a cloud, and the line under the message box says where a message
  will be sent before you send it.
- Reading a service's list of models sends only your key to that service, nothing about you or your chats.
- A model server on your own computer or home network (LM Studio, llama.cpp and the like) is marked
  "On this computer"; what is sent to it does not leave your network.
- Your key is sent only to its own service. Removing the service in Maris deletes the key.

## What is never collected

- No account, no sign-in, no tracking or analytics, no crash reports sent anywhere.
- Nothing from your computer is sent to the makers of Maris.

## Changes on your computer

Maris can read your files and look at your computer to answer questions, but it changes nothing (files,
settings, programs) until you approve that change, unless you turned on "Always approve" for a kind of
change yourself. You can see and switch off every such rule above the message box and in the status bar.

## Removing Maris

Uninstalling removes the program and everything the installer added (the maris command, the folder
menu entry, the startup entry, shortcuts). Your profile folder and data folder stay, so a reinstall
keeps your chats; delete those two folders to remove everything.
