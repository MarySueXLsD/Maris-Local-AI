"""Icons for macOS, Linux and Android, made from resources/icon.png (the 512 px Maris mark).

    python scripts/make-platform-icons.py

Writes resources/icon.icns (macOS app), resources/trayTemplate.png and @2x (macOS menu bar: black
"template" images the system tints), and, when the Android project exists, its launcher icons.
Needs Pillow.
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / 'resources'
src = Image.open(RES / 'icon.png').convert('RGBA')

# ---------------------------------------------------------------- macOS app icon
src.save(RES / 'icon.icns', sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])


# ---------------------------------------------------------------- macOS menu bar template
def template(size: int) -> Image.Image:
    """Dark parts of the mark become black, light parts (the label, the star, the pins) see-through."""
    big = src.copy()
    px = big.load()
    w, h = big.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
            px[x, y] = (0, 0, 0, a if lum < 0.6 else 0)
    # Crop to the drawn area so the glyph fills the menu bar height.
    box = big.getbbox()
    if box:
        big = big.crop(box)
    side = max(big.size)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.paste(big, ((side - big.width) // 2, (side - big.height) // 2))
    return square.resize((size, size), Image.LANCZOS)


template(16).save(RES / 'trayTemplate.png')
template(32).save(RES / 'trayTemplate@2x.png')

# ---------------------------------------------------------------- Android launcher icons
android_res = ROOT / 'mobile' / 'android' / 'app' / 'src' / 'main' / 'res'
if android_res.exists():
    densities = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
    bg = (24, 20, 38, 255)  # the dark violet of the Maris theme
    for name, scale in densities.items():
        d = android_res / f'mipmap-{name}'
        d.mkdir(parents=True, exist_ok=True)
        # Legacy square/round icons: 48 dp.
        legacy = round(48 * scale)
        icon = Image.new('RGBA', (legacy, legacy), bg)
        mark = src.resize((round(legacy * 0.86), round(legacy * 0.86)), Image.LANCZOS)
        icon.alpha_composite(mark, ((legacy - mark.width) // 2, (legacy - mark.height) // 2))
        icon.save(d / 'ic_launcher.png')
        mask = Image.new('L', (legacy, legacy), 0)
        from PIL import ImageDraw

        ImageDraw.Draw(mask).ellipse((0, 0, legacy - 1, legacy - 1), fill=255)
        rnd = Image.new('RGBA', (legacy, legacy), (0, 0, 0, 0))
        rnd.paste(icon, (0, 0), mask)
        rnd.save(d / 'ic_launcher_round.png')
        # Adaptive icon foreground: 108 dp with the mark inside the 66 dp safe zone.
        fg_size = round(108 * scale)
        fg = Image.new('RGBA', (fg_size, fg_size), (0, 0, 0, 0))
        mark = src.resize((round(fg_size * 0.62), round(fg_size * 0.62)), Image.LANCZOS)
        fg.alpha_composite(mark, ((fg_size - mark.width) // 2, (fg_size - mark.height) // 2))
        fg.save(d / 'ic_launcher_foreground.png')
    # Adaptive icon background and the launch screen: Maris's dark violet with the mark in the middle.
    (android_res / 'values' / 'ic_launcher_background.xml').write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#181426</color>\n</resources>\n',
        encoding='utf-8',
    )
    for splash in android_res.glob('drawable*/splash.png'):
        w, h = Image.open(splash).size
        img = Image.new('RGBA', (w, h), bg)
        side = round(min(w, h) * 0.28)
        mark = src.resize((side, side), Image.LANCZOS)
        img.alpha_composite(mark, ((w - side) // 2, (h - side) // 2))
        img.convert('RGB').save(splash)
    print('android icons written')

print('icons written to', RES)
