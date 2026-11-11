# What the trailer claims, and where each claim comes from

| # | Claim as shown | Source | Quoted wording | Date |
|---|---|---|---|---|
| 1 | Private AI that runs on your PC. | README.md, banner and line 5 | "A private AI that runs on your PC." · "a private AI assistant for Windows, macOS and Linux" | 2026-11-11 |
| 2 | Ask it anything. | README.md, Features: Chat | "Chat: Markdown, code, math and tables, attachments, thinking…" (a tagline, not a measured claim) | 2026-11-11 |
| 3 | Answered on this PC. | the filmed answer itself | its chip reads "Auto: Balanced Qwen3.5 9B": a model in Ollama on the computer that was filmed | 2026-11-11 |
| 4 | Make pictures and video. | README.md, line 7 | "picture and video generation" | 2026-11-11 |
| 5 | Use any model. · Local, or with your own key. | README.md, line 9 and Screenshots | "The models run on your own machine through Ollama. If you want, Maris also answers with Claude, GPT, Gemini or any OpenAI-compatible service through your own API key" · "Any model: your own, or Claude, GPT and others with your key." | 2026-11-11 |
| 6 | Even on an old laptop. | README.md, line 11 and Screenshots | "down to an old laptop with 4 GB of memory and no graphics card at all" · "Old computers get one small model and low-power mode." | 2026-11-11 |
| 7 | It can read everything. | README.md, line 7 | "a PC assistant that can look at anything" (shown in the film as the step "Read forecast.py") | 2026-11-11 |
| 8 | It changes nothing without your OK. | README.md, line 7 and Screenshots | "changes nothing without your approval" · "Nothing changes without your OK." | 2026-11-11 |
| 9 | Undo any edit. · In Code mode. | README.md, Features: Code mode | "a list of changes with diffs and one-click revert" (edits to files, in Code mode: the film says so) | 2026-11-11 |
| 10 | Get it for Windows, macOS and Linux | README.md, Install | the table of installers for the three systems | 2026-11-11 |
| 11 | github.com/MarySueXLsD/Maris-Local-AI · github.com/MarySueXLsD · marysue.itch.io | the owner's request; the itch.io page was opened and is titled "MarySue - itch.io" | | 2026-11-11 |

## Values inside the filmed interface (nothing is typed over it)
| Value | What it is | File |
|---|---|---|
| "Auto: Balanced Qwen3.5 9B · Answered in 1.2 s" | the app's own chip and stopwatch for the filmed answer; the model had been loaded by asking the same question once before. The film enlarges the model's name, not the time | footage/chat |
| "Loading Qwen3.5 9B into memory (6.1 GB)…", "Read forecast.py", "Auto: Max Qwen3.5 9B", "+5 −0", the diff | the filmed project task, as the app showed it | footage/project |
| "4 GB DDR3" | the setup assistant's reading of the simulated laptop | footage/laptop |

## Illustrative, and labelled on screen
- The old laptop: Maris was started with `MARIS_FAKE_SCAN` describing a 2012 laptop (Core i5-3320M, 4 GB, no graphics card). On screen: "Simulated 2012 laptop."
- The four pictures and the clip: made on this computer by the app's own picture and video pipeline (`scripts/make-previews.mjs`, shipped as the Models page's examples), not made during filming. On screen: "Made locally in Maris."
- The ring, the glass and the pointer are drawn by the film. The glass shows the same pixels of the window, larger. The pointer's click is where the real click was made (Playwright pressed the real button; the frames after it are what the app did).

## How the footage was made, and what was cut
- Everything in the window is the real Maris 0.4.0 (the packaged build), filmed by `capture.mjs`; nothing is redrawn.
- The status bar at the foot of the window (processor and graphics-card readings) is out of frame in every shot. While filming, the graphics-card readings were stand-in values (`MARIS_TEST_GPU`); none of them is on screen.
- The chat answer plays in real time from the moment Enter is pressed.
- The project scene opens 0.12 s after the task was sent and plays half a second. Then about 3.7 s are cut (the model loading and reading its instructions), and the stretch from Maris's first words to its request (3.2 s) plays in 2.7 s, about 18% fast.
- Maris folds its steps into one row. That row was opened by a click the film does not show, so that "Read forecast.py" is on screen; it was folded again before the request was photographed.
- When the request appears, the film cuts to it as it is once the page has been scrolled to show all of it. The second or so before that (the request half under the message box, the scrolling) is left out.
- On the frame of the click the film is at the first frame in which the request is gone, 0.08 s after the real click.
- Takes were chosen: a model answers differently every time (see capture.mjs for the rules).

## Not claimed
- Speed: no figure is pointed at. The 1.2 s visible in the chat footage is one answer of a warm 9B model on an RTX 5070 Ti.
- That nothing ever leaves the computer: with an API model, or the web tools, something does, and the app says so.
- That everything can be undone: commands and opening programs cannot; the film says "any edit", "in Code mode".
- A licence, a price, or "open source".
