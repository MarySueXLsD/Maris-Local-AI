"""Runs the video-director skill's checks (qa_video.py) on a render of the trailer.

  python scripts/trailer/qa.py [film.mp4] [--out folder] [more qa_video.py options]

qa_video.py wants ffmpeg and ffprobe on the PATH. This computer has ffmpeg only as the binary the
imageio-ffmpeg package brings, and no ffprobe, so this wrapper puts that ffmpeg on the PATH under its
plain name and answers the one question the checks ask of ffprobe (size, frame rate, length, audio)
from what ffmpeg itself prints. Set QA_VIDEO to the path of qa_video.py if the skill lives elsewhere.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
skill = Path(os.environ.get('QA_VIDEO', Path.home() / '.claude' / 'skills' / 'video-director' / 'scripts' / 'qa_video.py'))
if not skill.exists():
    sys.exit(f'{skill} was not found: set QA_VIDEO to where qa_video.py is')

if not shutil.which('ffmpeg'):
    import imageio_ffmpeg

    shim = Path(tempfile.gettempdir()) / 'maris-trailer-ffmpeg'
    shim.mkdir(exist_ok=True)
    plain = shim / ('ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
    if not plain.exists():
        shutil.copy2(imageio_ffmpeg.get_ffmpeg_exe(), plain)
    os.environ['PATH'] = str(shim) + os.pathsep + os.environ['PATH']

sys.path.insert(0, str(skill.parent))
import qa_video  # noqa: E402


def probe(path):
    text = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(path)], capture_output=True, text=True).stderr
    video = re.search(r'Stream #.*Video:.*?, (\d{2,5})x(\d{2,5})[ ,\[].*?([\d.]+) fps, ([\d.]+) tbr', text)
    length = re.search(r'Duration: (\d+):(\d+):([\d.]+)', text)
    if not video:
        raise RuntimeError('no video stream')
    if not length:
        raise RuntimeError('the file reports no duration')
    average, nominal = float(video.group(3)), float(video.group(4))
    h, m, s = length.groups()
    return {'w': int(video.group(1)), 'h': int(video.group(2)), 'fps': nominal or average, 'dur': int(h) * 3600 + int(m) * 60 + float(s),
            'vfr': abs(nominal - average) / nominal > 0.01, 'avg_fps': round(average, 3), 'audio': bool(re.search(r'Stream #.*Audio:', text))}


if not shutil.which('ffprobe'):
    qa_video.probe = probe

args = sys.argv[1:]
if not args or args[0].startswith('--'):
    args.insert(0, str(HERE / 'out' / 'maris-trailer.mp4'))
if '--out' not in args:
    args += ['--out', str(HERE / 'out' / 'qa')]
if '--beats' not in args:
    args += ['--beats', str(HERE / 'timeline.json')]
sys.argv = [str(skill)] + args
qa_video.main()
