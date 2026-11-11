"""The trailer's sound, computed from timeline.json: nothing here holds a time of its own.

  python scripts/trailer/score.py            ->  scripts/trailer/out/score.wav (48 kHz, stereo)

Every sound is synthesized (numpy and scipy): a mallet riff, a warm pad, a bass, a small drum kit and a
handful of effects that sit on the picture's cues. The grid is the film's: 112.5 beats a minute, so a
beat is 32 frames. The shape follows the picture: it grows through the feature scenes, hangs on an
unresolved chord and falls away when the approval request lands, is silent while the film waits for
the OK (real silence: samples of zero), and its loudest moment is the click, which is also where the
harmony comes home. Mastered to -14 LUFS with true peaks low enough to stay under -1 dB once encoded
(measured with ffmpeg's ebur128, as the checks do).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.ndimage import minimum_filter1d, uniform_filter1d

HERE = Path(__file__).resolve().parent
OUT = HERE / 'out'
SR = 48000
TL = json.loads((HERE / 'timeline.json').read_text(encoding='utf8'))
BEAT = TL['meta']['beat']
DUR = TL['meta']['dur']
SCENES = {s['id']: s for s in TL['scenes']}
N = int(round(DUR * SR))
rng = np.random.default_rng(20261111)


def at(ref):
    """The second of a named beat: at('halt.ask')."""
    scene, name = ref.split('.')
    return SCENES[scene]['beats'][name]


def b(beats):
    """Seconds, for a count of beats."""
    return beats * BEAT


# ------------------------------------------------------------------ building blocks
def sos(kind, freq, order=2):
    return signal.butter(order, freq, kind, fs=SR, output='sos')


def lowpass(x, f, order=2):
    return signal.sosfilt(sos('lowpass', f, order), x)


def highpass(x, f, order=2):
    return signal.sosfilt(sos('highpass', f, order), x)


def bandpass(x, lo, hi, order=2):
    return signal.sosfilt(sos('bandpass', [lo, hi], order), x)


def noise(n):
    return rng.standard_normal(n)


def ramp(n, attack=0.002, release=0.0):
    """A gain curve: up over `attack`, flat, down over `release` (seconds)."""
    g = np.ones(n)
    a = min(n, int(attack * SR))
    if a > 0:
        g[:a] = np.linspace(0, 1, a)
    r = min(n, int(release * SR))
    if r > 0:
        g[-r:] *= np.linspace(1, 0, r)
    return g


class Bus:
    """A stereo track the length of the film."""

    def __init__(self):
        self.x = np.zeros((N, 2))

    def add(self, sound, t, gain=1.0, pan=0.0):
        """Put a sound with its first sample at second t. pan: -1 left .. 1 right (equal power)."""
        i = int(round(t * SR))
        if i >= N or i + len(sound) <= 0:
            return
        if i < 0:
            sound, i = sound[-i:], 0
        sound = sound[: N - i]
        if sound.ndim == 2:
            self.x[i : i + len(sound)] += sound * gain
            return
        angle = (pan + 1) * np.pi / 4
        self.x[i : i + len(sound), 0] += sound * gain * np.cos(angle) * np.sqrt(2)
        self.x[i : i + len(sound), 1] += sound * gain * np.sin(angle) * np.sqrt(2)


def hz(name):
    """'A4' -> 440.0, 'C#5', 'F#2' ..."""
    names = {'C': -9, 'C#': -8, 'D': -7, 'D#': -6, 'E': -5, 'F': -4, 'F#': -3, 'G': -2, 'G#': -1, 'A': 0, 'A#': 1, 'B': 2}
    return 440.0 * 2 ** ((names[name[:-1]] + 12 * (int(name[-1]) - 4)) / 12)


# ------------------------------------------------------------------ the instruments
def kick(big=False):
    n = int((0.62 if big else 0.4) * SR)
    t = np.arange(n) / SR
    f = 44 + 86 * np.exp(-t / 0.03)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (0.26 if big else 0.15))
    click = highpass(noise(n), 2500) * np.exp(-t / 0.003) * 0.3
    return np.tanh(1.5 * (body + click)) * ramp(n, 0.0005, 0.02)


def clap(soft=1.0):
    n = int(0.26 * SR)
    t = np.arange(n) / SR
    env = np.zeros(n)
    for d, a in ((0.0, 0.8), (0.010, 0.7), (0.021, 1.0)):
        i = int(d * SR)
        env[i:] = np.maximum(env[i:], a * np.exp(-(t[: n - i]) / (0.007 if d < 0.02 else 0.07)))
    return bandpass(noise(n), 900, 4200) * env * soft


def hat(open_=False):
    n = int((0.22 if open_ else 0.06) * SR)
    t = np.arange(n) / SR
    return highpass(noise(n), 7500, 4) * np.exp(-t / (0.07 if open_ else 0.014))


def shaker():
    n = int(0.09 * SR)
    t = np.arange(n) / SR
    return bandpass(noise(n), 4500, 9500) * np.minimum(t / 0.012, 1) * np.exp(-t / 0.028)


def mallet(freq, length=0.9, bright=1.0):
    """A soft wooden bar: the note, a quick fourth partial and a faint knock."""
    n = int(length * SR)
    t = np.arange(n) / SR
    tone = np.sin(2 * np.pi * freq * t) * np.exp(-t / (0.34 * length / 0.9))
    tone += 0.42 * bright * np.sin(2 * np.pi * freq * 4.0 * t) * np.exp(-t / 0.08)
    tone += 0.18 * bright * np.sin(2 * np.pi * freq * 9.2 * t) * np.exp(-t / 0.03)
    knock = bandpass(noise(n), 900, 6000) * np.exp(-t / 0.007) * 0.3
    return (tone + knock) * ramp(n, 0.002, 0.03)


def bass(freq, length):
    n = int(length * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(4 * np.pi * freq * t) + 0.12 * np.sin(6 * np.pi * freq * t)
    env = (0.72 + 0.28 * np.exp(-t / 0.12)) * ramp(n, 0.008, min(0.07, length / 3))
    return np.tanh(1.3 * x) * env


def pad(freqs, length, cutoff, attack=0.35, release=0.45, seed=0):
    """Detuned saws through a low-pass: one chord, as two slightly different channels."""
    n = int(length * SR)
    t = np.arange(n) / SR
    local = np.random.default_rng(1000 + seed)
    out = np.zeros((n, 2))
    for f in freqs:
        for ch in (0, 1):
            for cents in (-7, 0, 7):
                detune = 2 ** ((cents + local.uniform(-2, 2)) / 1200)
                out[:, ch] += signal.sawtooth(2 * np.pi * f * detune * t + local.uniform(0, 6.28)) / 3
    out /= max(1, len(freqs))
    for ch in (0, 1):
        out[:, ch] = lowpass(out[:, ch], cutoff, 2)
    return out * ramp(n, attack, release)[:, None]


def tick(kind=0):
    """A key going down: a tiny click with a little plastic ring to it."""
    n = int(0.03 * SR)
    t = np.arange(n) / SR
    f = (2300, 2900, 2600)[kind % 3]
    return highpass(noise(n), 1800) * np.exp(-t / 0.0016) * 0.8 + np.sin(2 * np.pi * f * t) * np.exp(-t / 0.004) * 0.35


def pop(low=520.0, high=820.0):
    """A message leaving: a short rising blip."""
    n = int(0.09 * SR)
    t = np.arange(n) / SR
    f = low + (high - low) * (t / t[-1]) ** 0.6
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.028) * ramp(n, 0.002, 0.01)


def thunk():
    """Something heavy set down: the approval request arriving."""
    n = int(0.34 * SR)
    t = np.arange(n) / SR
    f = 58 + 46 * np.exp(-t / 0.035)
    low = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.11)
    wood = np.sin(2 * np.pi * 310 * t) * np.exp(-t / 0.018) * 0.4
    thud = lowpass(noise(n), 600) * np.exp(-t / 0.02) * 0.5
    return np.tanh(1.4 * (low + wood + thud)) * ramp(n, 0.001, 0.03)


def mouse_click():
    """A button of a mouse: down, and up 85 ms later."""
    n = int(0.13 * SR)
    x = np.zeros(n)
    for d, f, a in ((0.0, 3200, 1.0), (0.085, 2500, 0.6)):
        i = int(d * SR)
        m = n - i
        t = np.arange(m) / SR
        x[i:] += a * (highpass(noise(m), 1500) * np.exp(-t / 0.0012) + 0.5 * np.sin(2 * np.pi * f * t) * np.exp(-t / 0.003))
    return x


def latch():
    """The cartridge seating: two small metal clicks."""
    n = int(0.16 * SR)
    x = np.zeros(n)
    for d, f, a in ((0.0, 1900, 1.0), (0.062, 1350, 0.75)):
        i = int(d * SR)
        m = n - i
        t = np.arange(m) / SR
        x[i:] += a * (bandpass(noise(m), 1200, 6000) * np.exp(-t / 0.002) + 0.6 * np.sin(2 * np.pi * f * t) * np.exp(-t / 0.012))
    return x


def room(x, seconds=0.9, seed=5):
    """A small bright room: the sound through a decaying burst of noise."""
    local = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros_like(x)
    for ch in (0, 1):
        ir = highpass(local.standard_normal(n), 500) * np.exp(-t / (seconds / 5.5))
        ir[: int(0.012 * SR)] = 0
        ir /= np.sqrt((ir**2).sum())
        out[:, ch] = signal.fftconvolve(x[:, ch], ir)[:N]
    return out


# ------------------------------------------------------------------ the music
STOP = at('halt.stop')  # the music is gone from here ...
CLICK = at('payoff.click')  # ... until here
ASK = at('halt.ask')
SEND = at('chat.send')
BUILD = at('read.build')
MORPH = at('end.morph')
LAND = at('end.land')

CHORDS = {
    'D': (['D3', 'A3', 'C#4', 'E4', 'F#4'], 'D2'),
    'E': (['E3', 'B3', 'C#4', 'E4', 'G#4'], 'E2'),
    'C#m': (['C#3', 'G#3', 'B3', 'E4', 'G#4'], 'C#2'),
    'F#m': (['F#3', 'A3', 'C#4', 'E4', 'A4'], 'F#2'),
    'A': (['A2', 'E3', 'A3', 'B3', 'C#4', 'E4'], 'A2')
}
# Before the stop: one chord a bar, round and round, so the stop cuts a phrase short on a chord
# that wants to go on. From the click: home (A), a lift (D), and the chord that leads home again (E),
# held through the morph until the logo lands on A.
phrases = []  # (start, length, chord, the bar's number in its phrase)
for i, name in enumerate(['D', 'E', 'C#m', 'F#m'] * 8):
    if b(4 * i) >= STOP:
        break
    phrases.append((b(4 * i), b(4), name, i))
phrases += [(CLICK, b(4), 'A', 0), (CLICK + b(4), b(4), 'D', 1), (CLICK + b(8), LAND - CLICK - b(8), 'E', 2)]
RIFF = [['E5', None, 'C#5', 'E5', None, 'A4', 'C#5', None], ['F#5', None, 'E5', 'C#5', None, 'A4', 'B4', None]]

drums, low, keys, pads, fx = Bus(), Bus(), Bus(), Bus(), Bus()


def playing(t):
    """Is there music at second t? (Not while the film waits for the OK.)"""
    return not (STOP <= t < CLICK)


def energy(t):
    """How full the arrangement is: 0 pad and riff, 1 with bass and kick, 2 with hats, 3 and 4 everything."""
    if t < SEND:
        return 0
    if t < at('pictures.cut'):
        return 1
    if t < at('models.cut'):
        return 2
    if t < at('read.cut'):
        return 3
    if t < ASK:
        return 1.5  # the breath before the build
    if t < CLICK:
        return 0
    if t < MORPH:
        return 4
    return 0


for start, length, name, bar in phrases:
    notes, root = CHORDS[name]
    e = energy(start)
    cutoff = {0: 1300, 1: 1600, 2: 2200, 3: 2800, 1.5: 1700, 4: 4200}[e]
    pads.add(pad([hz(n) for n in notes], length + 0.3, cutoff, seed=int(start * 10)), start)
    eighths = int(round(length / BEAT * 2))
    for step in range(eighths):
        t = start + b(step / 2)
        if not playing(t) or t >= MORPH:
            continue
        e = energy(t)
        beat_in_bar = step % 8
        # A 3 + 3 + 2 bass under a 3 + 3 + 2 kick.
        if e >= 1 and beat_in_bar in (0, 3, 6) and t < ASK or e == 4 and beat_in_bar in (0, 3, 6):
            low.add(bass(hz(root), b({0: 1.3, 3: 1.1, 6: 0.85}[beat_in_bar])), t, 0.34)
        if (e in (1, 2, 3, 4) and beat_in_bar in (0, 3, 6)) or (e == 1.5 and beat_in_bar == 0):
            drums.add(kick(), t, 0.52)
        if e in (2, 3, 4) and beat_in_bar in (2, 6):
            drums.add(clap(), t, 0.5, 0.08)
        if e in (2, 3, 4) and beat_in_bar % 2 == 1:
            drums.add(hat(open_=(beat_in_bar == 7 and e >= 3)), t, 0.3 * (0.8 + 0.4 * rng.random()), -0.2)
        if e in (3, 4):  # shaker in sixteenths where the arrangement is full
            for k, accent in ((0, 0.55), (0.25, 1.0)):
                drums.add(shaker(), t + b(k), 0.17 * accent * (0.8 + 0.4 * rng.random()), 0.3)
        # the riff: eighths, an octave doubled after the click
        note = RIFF[bar % 2][beat_in_bar]
        if note is not None and not (BUILD <= t < CLICK):
            gain = {0: 0.27, 1: 0.32, 2: 0.35, 3: 0.36, 1.5: 0.27, 4: 0.4}[e]
            keys.add(mallet(hz(note)), t, gain, 0.25 if beat_in_bar % 2 else -0.15)
            if e == 4:
                keys.add(mallet(hz(note) * 2, 0.7, 0.7), t, 0.16, -0.3)

# the build: the riff's top notes in eighths, then sixteenths, then faster, with claps that halve their gap
beat = BUILD / BEAT
last = ASK / BEAT
k = 0
while beat < last - 1e-6:
    left = last - beat
    step = 0.5 if left > 2.01 else 0.25 if left > 0.76 else 0.125
    rise = 1 - left / (last - BUILD / BEAT)
    keys.add(mallet(hz(['E5', 'F#5', 'A5', 'F#5'][k % 4]), 0.5, 0.8 + rise), b(beat), 0.16 + 0.14 * rise, 0.3 * (-1) ** k)
    drums.add(clap(0.5 + 0.5 * rise), b(beat), 0.14 + 0.22 * rise, -0.1)
    beat += step
    k += 1
n = int((ASK - BUILD) * SR)
t = np.arange(n) / SR
sweep = np.zeros(n)
air = noise(n + 512)
block = 2048
for i in range(0, n, block):  # air that opens upward: a band of noise climbing two octaves
    p = i / n
    sweep[i : i + block] = bandpass(air[i : i + block + 512], 500 * 4**p, 1400 * 4**p)[: min(block, n - i)]
fx.add(sweep * (t / t[-1]) ** 2.2, BUILD, 0.2)

# ------------------------------------------------------------------ what the picture does
for times, level in ((TL['typing']['hook'], 0.34),):
    last_t = -1.0
    for i, t in enumerate(times):
        if i % 2 == 1 or t - last_t < 0.085:
            continue  # a tick for about every second character, never a rattle
        fx.add(tick(i // 2), t, level * (0.7 + 0.5 * rng.random()), 0.18 * (-1) ** i)
        last_t = t

fx.add(pop(), SEND, 0.32, 0.2)
for i, (name, note) in enumerate((('tile1', 'A4'), ('tile2', 'C#5'), ('tile3', 'E5'), ('tile4', 'F#5'), ('clip', 'A5'))):
    keys.add(mallet(hz(note), 0.8, 1.3), at(f'pictures.{name}'), 0.34, -0.3 + 0.15 * i)
    fx.add(pop(700 + 90 * i, 1000 + 120 * i), at(f'pictures.{name}'), 0.1, -0.3 + 0.15 * i)
fx.add(thunk(), ASK, 0.95)

# the OK: a mouse button, a kick with a long body, a low A, the home chord struck, and air
fx.add(mouse_click(), CLICK, 0.5, 0.1)
drums.add(kick(big=True), CLICK, 1.05)
n = int(0.9 * SR)
t = np.arange(n) / SR
low.add(np.sin(2 * np.pi * hz('A1') * t) * np.exp(-t / 0.3) * ramp(n, 0.004, 0.05), CLICK, 0.75)
for note, pan in (('A3', -0.4), ('E4', -0.2), ('A4', 0.0), ('C#5', 0.2), ('E5', 0.4), ('B5', 0.0)):
    keys.add(mallet(hz(note), 1.4, 1.5), CLICK, 0.36, pan)
drums.add(clap(), CLICK, 0.3)
n = int(1.6 * SR)
t = np.arange(n) / SR
fx.add(highpass(noise(n), 5000) * np.exp(-t / 0.4) * ramp(n, 0.002, 0.1), CLICK, 0.1)

# home: the cartridge seats, one soft note, the chord under it, and the tail
fx.add(latch(), LAND, 0.42, 0.15)
keys.add(mallet(hz('A4'), 3.2, 0.6), LAND, 0.34)
keys.add(mallet(hz('E5'), 2.6, 0.4), LAND + 0.02, 0.12, 0.3)
notes, _ = CHORDS['A']
# The last chord holds, and fades over the final second and a half, so the end is never dead air.
pads.add(pad([hz(n) for n in notes], DUR - LAND - 0.15, 1500, attack=0.05, release=1.6, seed=99), LAND, 1.25)
n = int(2.4 * SR)
t = np.arange(n) / SR
low.add(np.sin(2 * np.pi * hz('A2') * t) * np.exp(-t / 0.9) * ramp(n, 0.01, 0.4), LAND, 0.4)

# ------------------------------------------------------------------ the mix
# The pad and the bass duck under every kick; a little room on the mallets, the claps and the pad.
duck = np.ones(N)
for start, length, name, bar in phrases:
    for step in range(int(round(length / BEAT * 2))):
        t = start + b(step / 2)
        if playing(t) and t < MORPH and energy(t) in (1, 2, 3, 4) and step % 8 in (0, 3, 6):
            i = int(round(t * SR))
            m = min(N - i, int(0.22 * SR))
            duck[i : i + m] = np.minimum(duck[i : i + m], 1 - 0.45 * np.exp(-np.arange(m) / (0.07 * SR)))
pads.x *= duck[:, None]
low.x *= (0.5 + 0.5 * duck)[:, None]

mix = drums.x * 1.0 + low.x * 0.9 + keys.x * 1.0 + pads.x * 0.7 + fx.x * 1.0
mix += room(keys.x * 0.2 + drums.x * 0.05 + pads.x * 0.1 + fx.x * 0.08)

# The fall: from the request's arrival the music sinks (and darkens) to nothing by the stop.
i0, i1 = int(ASK * SR), int(STOP * SR)
fall = np.cos(np.linspace(0, np.pi / 2, i1 - i0)) ** 1.6
dark = np.stack([lowpass(mix[i0:i1, ch], 900, 2) for ch in (0, 1)], axis=1)
blend = np.linspace(0, 1, i1 - i0)[:, None] ** 0.5
keep = int(0.3 * SR)  # the thunk itself stays whole
mix[i0 + keep : i1] = (mix[i0 + keep : i1] * (1 - blend[keep:]) + dark[keep:] * blend[keep:]) * fall[keep:, None]
# The level of each part of the film: quieter under the hook, fullest after the click.
level = np.ones(N)
for t0, t1, g in ((0, SEND, 0.8), (SEND, ASK, 0.8), (CLICK, MORPH, 1.0), (MORPH, DUR, 0.78)):
    level[int(t0 * SR) : int(t1 * SR)] = g
level = uniform_filter1d(level, int(0.05 * SR))
level[int(CLICK * SR) - 2 : int(CLICK * SR) + int(0.5 * SR)] = 1.0  # nothing softens the click
mix *= level[:, None]
mix = np.stack([highpass(mix[:, ch], 28) for ch in (0, 1)], axis=1)  # nothing useful lives under 28 Hz
# Silence means silence: zeros from the stop to the click, with 12 ms to get there.
edge = int(0.012 * SR)
mix[i1 - edge : i1] *= np.linspace(1, 0, edge)[:, None]
mix[i1 : int(CLICK * SR)] = 0.0
# The first sound does not start on the very first sample, and the tail ends in silence.
mix[: int(0.02 * SR)] *= np.linspace(0, 1, int(0.02 * SR))[:, None]
tail = int(0.25 * SR)
mix[-tail:] *= (np.linspace(1, 0, tail) ** 2)[:, None]


# ------------------------------------------------------------------ master
def ffmpeg():
    for exe in (os.environ.get('FFMPEG'), shutil.which('ffmpeg')):
        if exe:
            return exe
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def write(path, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype('<i2')
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def measure(path):
    """Integrated loudness (LUFS) and true peak (dB) of a file, as ffmpeg's ebur128 reads them."""
    r = subprocess.run([ffmpeg(), '-nostats', '-i', str(path), '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True)
    summary = r.stderr[r.stderr.rfind('Summary:') :]
    return float(re.search(r'I:\s+(-?[\d.]+) LUFS', summary).group(1)), float(re.search(r'Peak:\s+(-?[\d.]+) dBFS', summary).group(1))


def limit(x, ceiling):
    """Hold peaks under `ceiling`: the gain dips 4 ms ahead of a peak and recovers over about 80 ms."""
    up = signal.resample_poly(x, 4, 1, axis=0)
    peak = np.abs(up).max(axis=1).reshape(-1, 4).max(axis=1)[: len(x)]
    need = np.minimum(1.0, ceiling / np.maximum(peak, 1e-9))
    look = int(0.004 * SR)
    g = minimum_filter1d(need, 2 * look + 1)
    g = uniform_filter1d(g, look)
    out = np.empty_like(g)
    a = np.exp(-1 / (0.08 * SR))
    cur = 1.0
    for i, v in enumerate(g):  # instant down, slow up
        cur = v if v < cur else a * cur + (1 - a) * v
        out[i] = cur
    return x * out[:, None]


OUT.mkdir(exist_ok=True)
# The ceiling leaves room for what the AAC encoder adds to the peaks (about 1 dB on this material).
target, ceiling = -14.0, 10 ** (-2.9 / 20)
mix = np.tanh(mix / np.abs(mix).max() * 1.1) / np.tanh(1.1) * 0.7
tmp = OUT / 'score-tmp.wav'
for _ in range(5):
    write(tmp, mix)
    loud, peak = measure(tmp)
    if abs(loud - target) < 0.15 and peak <= -2.6:
        break
    mix = limit(mix * 10 ** ((target - loud) / 20), ceiling)
write(OUT / 'score.wav', mix)
tmp.unlink()
loud, peak = measure(OUT / 'score.wav')

# What the checks look for, said here too: the loudest tenth of a second, and the silence.
win = int(0.1 * SR)
power = uniform_filter1d((mix**2).mean(axis=1), win)
loudest = (int(np.argmax(power)) - win // 2) / SR
quiet = np.abs(mix[int((STOP + 0.02) * SR) : int(CLICK * SR)]).max()
print(f'score: {DUR:.3f} s, {loud:.1f} LUFS, true peak {peak:.1f} dB, loudest 100 ms starts at {max(0, loudest):.3f} s (the click is at {CLICK:.3f}), silence {STOP:.3f}-{CLICK:.3f} peak {quiet:.6f}')
if not (abs(loud - target) <= 0.5 and peak <= -2.0):
    sys.exit('the master missed its target')
