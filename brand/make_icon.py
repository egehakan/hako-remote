import sys
from PIL import Image, ImageDraw

out = sys.argv[1]
N = 1024
TILE_R = 230
INK_TOP, INK_BOTTOM = (27, 30, 38), (14, 15, 20)
LID, LEFT, RIGHT = (246, 201, 132), (232, 146, 62), (176, 92, 40)
CX, CY, DX, DY, LIFT = 512, 560, 250, 144, 64

top = (CX, CY - 2 * DY)
ur, ul = (CX + DX, CY - DY), (CX - DX, CY - DY)
c = (CX, CY)
lr, ll = (CX + DX, CY + DY), (CX - DX, CY + DY)
bottom = (CX, CY + 2 * DY)
lid = [(x, y - LIFT) for x, y in (top, ur, c, ul)]
left = [ul, c, bottom, ll]
right = [c, ur, lr, bottom]

def pts(p):
    return " ".join(f"{x},{y}" for x, y in p)

def rgb(col):
    return "#%02x%02x%02x" % col

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {N} {N}" role="img" aria-label="Hako">
  <defs>
    <linearGradient id="ink" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{rgb(INK_TOP)}"/>
      <stop offset="1" stop-color="{rgb(INK_BOTTOM)}"/>
    </linearGradient>
  </defs>
  <rect width="{N}" height="{N}" rx="{TILE_R}" fill="url(#ink)"/>
  <polygon points="{pts(left)}" fill="{rgb(LEFT)}"/>
  <polygon points="{pts(right)}" fill="{rgb(RIGHT)}"/>
  <polygon points="{pts(lid)}" fill="{rgb(LID)}"/>
</svg>
'''
open(f"{out}/hako-icon.svg", "w").write(svg)

mark = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="212 172 600 720" role="img" aria-label="Hako">
  <polygon points="{pts(left)}" fill="{rgb(LEFT)}"/>
  <polygon points="{pts(right)}" fill="{rgb(RIGHT)}"/>
  <polygon points="{pts(lid)}" fill="{rgb(LID)}"/>
</svg>
'''
open(f"{out}/hako-mark.svg", "w").write(mark)

K = 4
big = Image.new("RGBA", (N * K, N * K), (0, 0, 0, 0))
grad = Image.new("RGBA", (1, N * K))
for y in range(N * K):
    t = y / (N * K - 1)
    grad.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(INK_TOP, INK_BOTTOM)) + (255,))
grad = grad.resize((N * K, N * K))
mask = Image.new("L", (N * K, N * K), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, N * K - 1, N * K - 1], radius=TILE_R * K, fill=255)
big.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(big)
for poly, col in ((left, LEFT), (right, RIGHT), (lid, LID)):
    d.polygon([(x * K, y * K) for x, y in poly], fill=col + (255,))
for size in (1024, 512, 192, 180, 64, 32):
    big.resize((size, size), Image.LANCZOS).save(f"{out}/hako-icon-{size}.png")

# Full-bleed square (no rounded corners, no transparency) for iOS home screen, which applies its own mask.
sq = Image.new("RGBA", (N * K, N * K))
sq.paste(grad, (0, 0))
d = ImageDraw.Draw(sq)
for poly, col in ((left, LEFT), (right, RIGHT), (lid, LID)):
    d.polygon([(x * K, y * K) for x, y in poly], fill=col + (255,))
for size in (512, 180):
    sq.resize((size, size), Image.LANCZOS).convert("RGB").save(f"{out}/hako-icon-square-{size}.png")
print("ok")
