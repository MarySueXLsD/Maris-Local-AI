"""When does the approval request come on screen in the filmed frames, and when is it gone again?

capture.mjs notes the second it saw the request in the page and the second it clicked Approve; the
frames that show those things come a little before and a little after. The film puts both on beats,
so make-footage.mjs asks this script for the exact frames:
  landed  the first frame of the "work" film in which the request's own colour shows in the window
          (the request, or the bar that says Maris is waiting)
  gone    the first frame of the "after" film, from the click on, in which that colour has left

Usage: python landing.py <footage folder>   ->   prints {"landed": 8.03, "gone": 0.52}
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

footage = Path(sys.argv[1])
project = json.loads((footage / 'project.json').read_text(encoding='utf8'))
marks = project['marks']

# The request's fill colour, read from the still of it (3 pixels a point), well inside the panel.
panel = project['stills']['ask']['boxes']['panel']
still = np.asarray(Image.open(footage / 'project' / project['stills']['ask']['file']).convert('RGB')).astype(int)
colour = still[int((panel['y'] + panel['h'] * 0.42) * 3), int((panel['x'] + panel['w'] * 0.8) * 3)]


def share(file):
    """How much of a frame is the request's colour."""
    a = np.asarray(Image.open(footage / 'project' / file).convert('RGB').resize((192, 150))).astype(int)
    return float((np.abs(a - colour).sum(axis=2) < 14).mean())


landed = next((f['t'] for f in project['work']['frames'] if marks['asked'] - 2.5 <= f['t'] <= marks['asked'] + 0.5 and share(f['file']) > 0.025), None)
if landed is None:
    sys.exit('the request was not found in the frames around the time it was seen')
gone = next((f['t'] for f in project['after']['frames'] if f['t'] >= marks['clicked'] and share(f['file']) < 0.005), None)
if gone is None:
    sys.exit('the request never left the frames after the click')
print(json.dumps({'landed': landed, 'gone': gone}))
