# The Maris trailer

A 37-second film made in code: the real app is filmed, and a web page whose every frame is a function of time puts the film together. `TREATMENT.md` says what it is and why, `FACTS.md` where every claim on screen comes from.

## Make it

```bash
npm run dist:dir
```

```bash
node scripts/trailer/capture.mjs
```

```bash
node scripts/trailer/build.mjs
```

1. `capture.mjs` films the packaged app with a throwaway profile (a chat answered by a model in Ollama, a project task with its approval request, the Models page, setup on a simulated old laptop). It needs Ollama with the models Maris recommends, a screen of at least 1536×1200, and a few minutes: a model answers differently every time, so scenes are shot again until a take suits the film. The footage goes to `footage/` (not in git). After a new shoot, read `FACTS.md` again: the figures it quotes from the footage (lines changed, seconds cut) belong to the take that was filmed.
2. `build.mjs` makes everything else: the timeline, the list of footage, the score, the picture (Chrome or Edge, headless, frame by frame), the film with its sound, and the checks. The result is `out/maris-trailer.mp4`.

It needs Node, Python with `numpy`, `scipy`, `pillow` and `imageio-ffmpeg` (or ffmpeg on the PATH), and Chrome or Edge.

## The parts

| File | What it does |
| --- | --- |
| `make-timeline.mjs` | The one timeline, written in beats (112.5 BPM, a beat is 32 frames). Writes `timeline.json` and `film/timeline.js`. Change a time here and the picture, the sound and the checks all move. |
| `capture.mjs` | Films the app. |
| `make-footage.mjs`, `landing.py` | Turn the footage into the list the page reads, and find the frame in which the approval request appears. |
| `film/` | The film as a page: `seek(t)` draws any moment. Open `film/index.html` in a browser to watch it (space pauses, arrow keys step, `?t=20` starts at a time). |
| `render.mjs` | Photographs the page: the whole film, `--draft`, or `--stills 1.5,24.6` and `--strip 24.3,24.8,0.05` to look at moments. |
| `score.py` | The sound, synthesized from the timeline and mastered to −14 LUFS. |
| `qa.py` | Runs the video-director skill's checks on a render (it needs that skill's `qa_video.py`). |

To change the wording, edit the texts in `make-timeline.mjs` (and the headline's line breaks in `film/film.js`), then run `build.mjs`. `build.mjs --sound` redoes only the sound.
