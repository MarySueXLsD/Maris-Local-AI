"""Make a small preview of a generated clip: H.264 at a lower width, plus a poster picture of the first frame.

    python shrink-video.py <in.mp4> <out.mp4> <poster.jpg> [width=640] [crf=30]

Runs with ComfyUI's own Python (it has PyAV and Pillow); used by scripts/make-previews.mjs.
"""
import sys

import av

src, dst, poster = sys.argv[1], sys.argv[2], sys.argv[3]
width = int(sys.argv[4]) if len(sys.argv) > 4 else 640
crf = sys.argv[5] if len(sys.argv) > 5 else "30"

with av.open(src) as inp:
    vin = inp.streams.video[0]
    rate = vin.average_rate or 24
    height = int(round(vin.height * width / vin.width / 2) * 2)
    with av.open(dst, "w") as out:
        vout = out.add_stream("libx264", rate=rate)
        vout.width, vout.height = width, height
        vout.pix_fmt = "yuv420p"
        vout.options = {"crf": crf, "preset": "slow", "movflags": "+faststart"}
        first = True
        for frame in inp.decode(vin):
            small = frame.reformat(width=width, height=height, format="yuv420p")
            if first:
                small.to_image().save(poster, quality=84)
                first = False
            for packet in vout.encode(small):
                out.mux(packet)
        for packet in vout.encode():
            out.mux(packet)
print(f"{dst} {width}x{height}")
