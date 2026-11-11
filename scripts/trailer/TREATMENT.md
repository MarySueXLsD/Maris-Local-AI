# Maris trailer: the film that waits for your OK

**Idea (one sentence):** Maris is an AI that runs on your own PC and does real work there, and it changes nothing until you press Approve, so the film itself stops and waits for that click.
**Promise (on screen from the first frame):** Private AI that runs on your PC.
**Hook (0–3 s, sound off):** "Private AI that runs on your PC." at 100 px, the name "Maris" at 76 px with the mark · CTA `github.com/MarySueXLsD/Maris-Local-AI` at 48 px · the real window beside it, a question being typed.
**Terms (shown):** Maris · Private AI · your PC
**Audience · channel · how it is watched:** people who would run a local model or want an assistant that does not phone home, and the author's followers · the repository page, itch.io, video sites and feeds · often muted, so type carries every beat.
**Spec:** 1920×1080, 60 fps, 36.8 s = 2208 frames · `out/maris-trailer.mp4`, `out/maris-trailer-720p.mp4` (small copy), `out/maris-trailer-picture.mp4` (no sound), `out/score.wav`.

## Benchmark
- A cartridge going into a console (the mark is a cartridge): learn one physical object, one seat, one sound, and that the thing runs once it is in · don't take any console's boot logo, chime or pixel type.
- The held beat before a title in film trailers: learn that the silence is the loudest thing and what follows it must be the most important sound · don't take the brass blast, the black frame or the flash cuts.
- Launch films for desktop apps (the genre's canon): learn the fixed window that only its content changes · don't take glass panels, type on gradients, or redrawn interface.

## Structures considered
1. A feature list cut on the beat, logo at the end.
2. One work session in one window, never leaving it.
3. A climb through what Maris does that halts, music and all, when a change needs approval, and resumes on the click.
**Chosen:** 3, because the approval gate is the one thing only Maris promises, and a film can do what a list cannot: wait. Rejected: 1 has no turn and is every AI app's promo; 2 cannot show other models or another computer.

## Dials
Clock: music grid, designed, 112.5 BPM (a beat is 32 frames) · Continuity: chaptered, one window in one place, cuts inside it on the beat
Register: clean, 60 fps, springs ζ 0.7–1.0, one overshoot (the cartridge seating) · Text policy: type as hero, one headline a scene with at most one small line under it
Constant the eye holds: the window (a card at x 720, 1152×861) · Accent: gold #f2b544 means your OK, used for "your OK.", "Approved." and the click, nowhere else · Type: Segoe UI Variable Display 700 / Text 500 / Cascadia Code (the app's own)

## Arc
Hook (0–3.2 s): promise, name, address, the window · Turn at 21.33 s: the request lands and the music falls away · Hero moment = payoff at 25.6 s (70%): the click, after 3.5 s of silence (the one native move: the film waits, as the app does)
Arc quantity: how close the camera is to the window = 1.5 in every scene, leaning to 1.55 while Maris works on the task, 2.3 through the silence, 1.5 again after the click
Ending answers the opening: the same layout returns (words left, the product right), the address comes back underlined as in the hook with two more under it, and the window has become the cartridge.
Actions that must be seen: a question typed and answered · pictures and a clip arriving · Maris reading a file ("Read forecast.py") · the request landing · the pointer pressing Approve · the change, and Undo.
Missing inputs and how they were handled: no track, so a designed grid and a synthesized score · no recorded sound, since downloading needs the owner's OK.

## Beat sheet
| # | t (s) | What happens | Reads | Cued to | Camera | Transition out | Sound | Guard |
|---|---|---|---|---|---|---|---|---|
| hook | 0–3.2 | Promise, name and address; in the window a question is typed | promise → address | frame 0; typing on its own rhythm | whole window, peeking from the right, gliding in over the first second | next step: Enter sends the question, the window moves to its place | pad, riff, key ticks | nothing fades in at frame 0 |
| chat | 3.2–8.0 | The answer writes itself at its real speed; a glass enlarges the chip that names the model | "Ask it anything." → the answer → "Qwen3.5 9B" → "Answered on this PC." | send on beat 6; glass on 9.5 | whole window | match on position | kick and bass enter; a pop on send | no retimed answer; no speed claim |
| pictures | 8.0–11.2 | Four pictures and a clip (a wave breaking over a lighthouse) arrive where the window stood | "Make pictures and video." → the pictures | tiles on 15, 15.5, 16, 16.5, 17 | none | match on position | five rising notes | real outputs only, labelled |
| models | 11.2–14.9 | The services page; the ring steps Claude, OpenAI, Gemini | "Use any model." → "Local, or with your own key." → names | hops on 22.5, 23.5, 24.5 | none | time cut | hats, claps | no logos, the page's own words; say whose key |
| laptop | 14.9–18.1 | The setup assistant on a 2012 laptop; the ring finds "4 GB DDR3" | "Even on an old laptop." → 4 GB | ring on 29 | none | time cut | full kit | labelled "Simulated" |
| read | 18.1–21.3 | A task has just been sent; Maris says it will look at the file, and its step shows: "Read forecast.py" (in the glass) | "It can read everything." → Read forecast.py | cut on 34 | 1.5 → 1.55 | cause → effect | half-time, then a build that halves its gaps | the reading is shown, not captioned; no dead wait |
| halt | 21.3–25.6 | The request lands, whole; the music falls away and stops; the camera closes in; the pointer goes to Approve | the request → "It changes nothing without your OK." → Approve | land on 40; stop on 41.5 | 1.55 → 2.3, at rest before the pointer moves | cause → effect | thunk, then silence | the camera is still for the click; no glyph cut at the card's edge |
| payoff | 25.6–30.4 | Click. The request is gone on that frame, work goes on; the change as a diff; Undo in the glass | "Approved." → "Undo any edit." "In Code mode." → Undo | click on 48 | still, then back to 1.5 | shape morph | click, kick, low A, the home chord: the loudest moment | no label stands in for the click; no flash |
| end | 30.4–36.8 | The window becomes the cartridge; name, promise, three addresses, the first one largest and underlined | name → repository → profile → itch.io | lands on 59 | none | (last frame is the poster) | latch, one note, the chord held to the end | 4 s completely still |

## Sound plan
Source: synthesized from the timeline (score.py) · Silence 22.13–25.6 s · Loudest hit at 25.6 s · Growth: pad and riff → kick and bass → hats and claps → full, a breath, a build → silence → home chord, full → one note over a held chord
SFX vocabulary: key ticks, a rising blip for a sent message, mallet notes for arriving pictures, a low thunk for the request, a mouse click, a two-part latch for the cartridge.

## Truth
See FACTS.md. Everything in the window is the real app, filmed. Labelled on screen: the simulated laptop, the sample pictures, the mode in which Undo is shown.

## Risks
The score is computed, not recorded, and nobody has heard it: it was only measured. The project scene shows the model's own words and steps, which differ from take to take.

## DECISIONS
- 16:9 at 1080p60 and about 37 s, because the app is a landscape desktop window and "small trailer" was the brief.
- The window is filmed at 768×600 with the sidebar closed and the Solid material, because its text is then large enough to read in a 1080p frame and its colours film true. Its status bar is kept out of frame.
- A real local model (Qwen3.5 9B in Ollama) answers; takes that wandered (a rewrite instead of an edit, a name in the answer, no read step) were shot again.
- Small words that carry proof (the model's name, "Read forecast.py", "Undo") are enlarged in a glass that shows the same pixels, instead of a caption saying so.
- Left out: memory, web browsing, the Android app, themes, skills and connectors, and the setup assistant's list of small models. One idea, not the feature list.
- No "free" or "open source" on screen: the repository states no licence.
- Sound is synthesized. Real recordings would need downloads, which were not asked for.

## After the independent review (one fix round)
- "Every change can be undone." became "Undo any edit." with "In Code mode." under it: the claim is now no wider than its source.
- The stand-in graphics-card figure is no longer on screen (the status bar is out of frame).
- The read scene shows the step "Read forecast.py" and has no dead wait; the request lands whole instead of half under the message box.
- "Use any model." now says whose key ("Local, or with your own key."); the ring makes three slow steps instead of six fast ones.
- The end card has one main address; its labels and the honesty labels are 34–36 px; the flash at the click is gone.
