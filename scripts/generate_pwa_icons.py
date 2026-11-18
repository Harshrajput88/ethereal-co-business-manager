"""Generate Ethereal Co. PWA icons (no external network or fonts required).

Usage: python scripts/generate_pwa_icons.py

Draws a gold water droplet on the workspace's deep-forest gradient. Renders at
4x and downsamples so edges stay smooth without an SVG renderer.
"""

from pathlib import Path

from PIL import Image, ImageDraw

PUBLIC = Path(__file__).resolve().parent.parent / "public"
SCALE = 4
DEEP = (0, 51, 38)
FOREST = (7, 83, 51)
GOLD_LIGHT = (246, 231, 200)
GOLD = (185, 134, 63)


def vertical_gradient(size, top, bottom):
    image = Image.new("RGB", (1, size), top)
    pixels = image.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        pixels[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return image.resize((size, size), Image.Resampling.NEAREST)


def droplet_mask(size, scale, inset=0.0):
    """Return an L-mode mask of a smooth teardrop with tangent shoulders."""
    import math

    s = size * scale
    cx = s / 2
    # Safe-area inset shrinks the mark for maskable icons.
    body_r = s * (0.205 - inset * 0.3)
    body_y = s * (0.605 + inset * 0.05)
    apex_y = s * (0.225 + inset * 0.25)
    distance = body_y - apex_y
    ratio = body_r / distance
    spread = math.sqrt(max(1 - ratio * ratio, 0))
    # Where the straight sides touch the body circle.
    tx = body_r * spread
    ty = -body_r * ratio

    def bezier(t):
        # Quadratic curve from the apex, pivoting on the apex itself, so the
        # curve meets the context of the circle along its tangent.
        x = (1 - t) ** 2 * cx + 2 * (1 - t) * t * cx + t**2 * (cx + tx)
        y = (1 - t) ** 2 * apex_y + 2 * (1 - t) * t * apex_y + t**2 * (body_y + ty)
        return x, y

    points = [bezier(i / 40) for i in range(41)]
    start = math.atan2(ty, tx)
    end = math.pi - start
    for i in range(1, 81):
        angle = start + (end - start) * i / 80
        points.append((cx + body_r * math.cos(angle), body_y + body_r * math.sin(angle)))
    points += [(2 * cx - x, y) for x, y in reversed(points[:41])]

    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask


def render(size, rounded=True, inset=0.0):
    s = size * SCALE
    base = vertical_gradient(s, DEEP, FOREST).convert("RGBA")

    # Soft gold halo behind the droplet.
    halo = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(halo).ellipse(
        [s * 0.16, s * 0.16, s * 0.84, s * 0.84],
        fill=GOLD + (36,),
    )
    base = Image.alpha_composite(base, halo)

    mask = droplet_mask(size, SCALE, inset)
    gradient = vertical_gradient(s, GOLD_LIGHT, GOLD).convert("RGBA")
    base.paste(gradient, (0, 0), mask)

    # Small highlight on the droplet's shoulder.
    glass = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(glass).ellipse(
        [s * 0.405, s * 0.46, s * 0.465, s * 0.53],
        fill=(255, 255, 255, 90),
    )
    base = Image.alpha_composite(base, Image.composite(glass, Image.new("RGBA", (s, s), (0, 0, 0, 0)), mask))

    if rounded:
        corner = Image.new("L", (s, s), 0)
        ImageDraw.Draw(corner).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=255)
        base.putalpha(corner)

    return base.resize((size, size), Image.Resampling.LANCZOS)


def main():
    PUBLIC.mkdir(parents=True, exist_ok=True)
    render(192).save(PUBLIC / "pwa-192.png", optimize=True)
    render(512).save(PUBLIC / "pwa-512.png", optimize=True)
    render(512, rounded=False, inset=0.12).save(PUBLIC / "pwa-maskable-512.png", optimize=True)
    render(180).save(PUBLIC / "apple-touch-icon.png", optimize=True)
    print("Wrote pwa-192.png, pwa-512.png, pwa-maskable-512.png, apple-touch-icon.png")


if __name__ == "__main__":
    main()
