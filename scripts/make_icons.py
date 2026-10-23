"""Rebuild every OpenAqua Harness icon from the canonical brand logo.

The teal-to-blue OpenAqua artwork in ``build/logo.png`` remains the source of
truth. This script removes its white canvas and places the resulting transparent
mark on a bright aqua-white application tile; it never recolors the artwork.

Outputs:
  build/icon.png        1024x1024 app icon
  build/icon.ico        multi-size Windows icon
  build/icon.iconset/   macOS iconset (iconutil -c icns -> build/icon.icns)
  build/logo-256.png    transparent mark for in-UI branding

Run:  uv run --with pillow,numpy python3 scripts/make_icons.py && iconutil -c icns build/icon.iconset -o build/icon.icns
"""

import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
RADIUS = 225
LOGO_SCALE = 0.72  # symbol diameter as a fraction of the icon size
PANEL_TOP = np.array([250.0, 255.0, 254.0])
PANEL_BOTTOM = np.array([225.0, 243.0, 250.0])
PANEL_MINT = np.array([216.0, 248.0, 239.0])
PANEL_BLUE = np.array([218.0, 237.0, 252.0])
PANEL_BORDER = (58, 174, 184, 205)
PANEL_HIGHLIGHT = (255, 255, 255, 210)
MARK_SHADOW = (31, 107, 137)
HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, '..', 'build')
LOGO = os.path.join(OUT, 'logo.png')


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new('L', (size * 4, size * 4), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size * 4, size * 4], radius=radius * 4, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def remove_white(img: Image.Image, cutoff: int = 4) -> Image.Image:
    """Remove the white canvas without changing the visible logo palette.

    Interior pixels keep the RGB values supplied by the designer. Only the
    anti-aliased edge is decontaminated from white so the mark remains faithful
    and crisp on both porcelain and navy surfaces.
    """
    rgb = np.asarray(img.convert('RGB')).astype(np.float32)
    distance = 255.0 - np.min(rgb, axis=2)
    alpha = np.clip(distance * 3.0, 0.0, 255.0)
    alpha = np.where(distance <= cutoff, 0.0, alpha)
    a = alpha[..., None] / 255.0
    recovered = np.zeros_like(rgb)
    np.divide(rgb - 255.0 * (1.0 - a), a, out=recovered, where=a > 0.0)
    edge = (a > 0.0) & (a < 1.0)
    foreground = np.where(edge, recovered, rgb)
    out = np.dstack([np.clip(foreground, 0.0, 255.0), alpha]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def tight_bbox(img: Image.Image) -> Image.Image:
    bbox = img.getchannel('A').point(lambda px: 255 if px > 12 else 0).getbbox()
    return img.crop(bbox) if bbox else img


def symbol_only(img: Image.Image) -> Image.Image:
    """Drop the small wordmark below the standalone OpenAqua symbol."""
    alpha = np.asarray(img.getchannel('A'))
    row_counts = (alpha > 12).sum(axis=1)
    start = int(img.height * 0.55)
    for row in range(start, img.height - 2):
        if row_counts[row] == row_counts[row + 1] == row_counts[row + 2] == 0:
            return img.crop((0, 0, img.width, row))
    return img


def resized_to_fit(img: Image.Image, target: int) -> Image.Image:
    ratio = min(target / img.width, target / img.height)
    width = max(1, round(img.width * ratio))
    height = max(1, round(img.height * ratio))
    resized = img.resize((width, height), Image.LANCZOS)
    if ratio > 1.0:
        radius = min(1.6, max(0.6, ratio * 0.28))
        resized = resized.filter(ImageFilter.UnsharpMask(radius=radius, percent=125, threshold=2))
    return resized


def bright_canvas(size: int) -> Image.Image:
    """Create a luminous aqua-white field derived from the canonical logo."""
    yy, xx = np.mgrid[0:size, 0:size]
    nx = xx / max(1, size - 1)
    ny = yy / max(1, size - 1)
    base = PANEL_TOP * (1.0 - ny[..., None]) + PANEL_BOTTOM * ny[..., None]

    mint = np.exp(-(((nx - 0.16) / 0.62) ** 2 + ((ny - 0.12) / 0.58) ** 2)) * 0.5
    blue = np.exp(-(((nx - 0.88) / 0.58) ** 2 + ((ny - 0.86) / 0.62) ** 2)) * 0.46
    rgb = base * (1.0 - mint[..., None]) + PANEL_MINT * mint[..., None]
    rgb = rgb * (1.0 - blue[..., None]) + PANEL_BLUE * blue[..., None]

    center = np.exp(-(((nx - 0.5) / 0.55) ** 2 + ((ny - 0.43) / 0.58) ** 2)) * 0.18
    rgb = rgb * (1.0 - center[..., None]) + 255.0 * center[..., None]
    alpha = np.full((size, size, 1), 255, dtype=np.uint8)
    return Image.fromarray(
        np.concatenate([np.clip(rgb, 0.0, 255.0).astype(np.uint8), alpha], axis=2),
        'RGBA',
    )


def fit_on_canvas(logo: Image.Image, size: int, scale: float) -> Image.Image:
    canvas = bright_canvas(size)
    target = int(size * scale)
    logo = resized_to_fit(logo, target)
    x = (size - logo.width) // 2
    y = (size - logo.height) // 2

    shadow_alpha = logo.getchannel('A').filter(
        ImageFilter.GaussianBlur(radius=max(2, round(size * 0.014)))
    )
    shadow_alpha = shadow_alpha.point(lambda value: round(value * 0.24))
    shadow = Image.new('RGBA', logo.size, (*MARK_SHADOW, 0))
    shadow.putalpha(shadow_alpha)
    canvas.alpha_composite(shadow, (x, y + round(size * 0.018)))
    canvas.alpha_composite(logo, (x, y))

    draw = ImageDraw.Draw(canvas)
    inset = max(2, round(size * 0.027))
    radius = round(size * 0.195)
    draw.rounded_rectangle(
        [inset, inset, size - inset - 1, size - inset - 1],
        radius=radius,
        outline=PANEL_BORDER,
        width=max(2, round(size / 384)),
    )
    highlight_inset = inset + max(3, round(size * 0.006))
    draw.rounded_rectangle(
        [
            highlight_inset,
            highlight_inset,
            size - highlight_inset - 1,
            size - highlight_inset - 1,
        ],
        radius=max(1, radius - (highlight_inset - inset)),
        outline=PANEL_HIGHLIGHT,
        width=max(1, round(size / 768)),
    )
    return canvas


def main() -> None:
    source = symbol_only(tight_bbox(remove_white(Image.open(LOGO))))

    # Transparent standalone mark used by README, onboarding, sidebar and hero.
    mark = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
    small_mark = resized_to_fit(source.copy(), 224)
    mark.alpha_composite(
        small_mark,
        ((256 - small_mark.width) // 2, (256 - small_mark.height) // 2),
    )
    mark.save(os.path.join(OUT, 'logo-256.png'))

    # Bright aqua-white app tile using the same, unmodified teal-to-blue mark.
    icon_rgba = fit_on_canvas(source.copy(), SIZE, LOGO_SCALE)
    final = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    final.paste(icon_rgba, (0, 0), rounded_mask(SIZE, RADIUS))

    final.save(os.path.join(OUT, 'icon.png'))
    final.save(
        os.path.join(OUT, 'icon.ico'),
        sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
    )

    iconset = os.path.join(OUT, 'icon.iconset')
    os.makedirs(iconset, exist_ok=True)
    for s in (16, 32, 128, 256, 512):
        final.resize((s, s), Image.LANCZOS).save(os.path.join(iconset, f'icon_{s}x{s}.png'))
        final.resize((s * 2, s * 2), Image.LANCZOS).save(os.path.join(iconset, f'icon_{s}x{s}@2x.png'))
    print('icons rebuilt from', LOGO, '(canonical OpenAqua brand artwork preserved)')


if __name__ == '__main__':
    main()
