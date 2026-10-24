"""White-background removal for line-art characters: flood fill from the borders only, so white
areas enclosed by outlines (shirt, sneakers) stay opaque; soft alpha on the 2-px edge band.

Turns src/assets/source/<name>.jpeg into src/assets/<name>.webp, cropped to the hips (1150 px of
a 2262 px full-body picture). Run from apps/overlay:

  docker run --rm -v "$PWD/src/assets:/assets" -v "$PWD/scripts:/scripts:ro" python:3.12-slim \\
    sh -c 'pip install -q pillow==11.0.0 numpy==2.1.3 scipy==1.14.1 &&
           python -I /scripts/cutout.py /assets/source/yandere.jpeg /assets/yandere.webp 1150'

Check the result on a dark and a bright background before committing: hair gaps that are not
pure white, or a character with pure-white clothing, may need the thresholds below adjusted."""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

src, dst, crop_height = sys.argv[1], sys.argv[2], int(sys.argv[3])
rgb = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
low = rgb.min(axis=2)
print(src, "corners:", [tuple(rgb[y, x].astype(int)) for y, x in ((0, 0), (0, -1), (-1, 0), (-1, -1))])

near_white = low >= 236
labels, _ = ndimage.label(near_white)
border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
background = np.isin(labels, border[border > 0])
# Gaps between hair strands are background enclosed by outlines. They are pure, colourless white;
# eye whites are greyer, and catchlights are tiny, so both survive this rule.
for index, region in enumerate(ndimage.find_objects(labels), start=1):
    if region is None or index in border:
        continue
    mask = labels[region] == index
    pixels = rgb[region][mask]
    colourless = (pixels.max(axis=1) - pixels.min(axis=1)).mean() < 2
    if mask.sum() >= 100 and pixels.min(axis=1).mean() >= 250 and colourless:
        background[region] |= mask

alpha = np.where(background, 0.0, 1.0)
band = ndimage.binary_dilation(background, iterations=2) & ~background
# Anti-aliased edge pixels are a blend of ink and white: alpha from darkness, colour un-blended.
edge_alpha = np.clip((255.0 - low) / 255.0 * 1.6, 0.0, 1.0)
alpha[band] = edge_alpha[band]
out = rgb.copy()
safe = np.maximum(alpha, 1e-3)[..., None]
unblended = np.clip((rgb - (1.0 - alpha[..., None]) * 255.0) / safe, 0, 255)
out[band] = unblended[band]

rgba = np.dstack([out, alpha * 255.0]).astype(np.uint8)
ys, xs = np.nonzero(rgba[..., 3] > 8)
x0, x1, y0 = xs.min(), xs.max() + 1, ys.min()
image = Image.fromarray(rgba).crop((x0, y0, x1, min(y0 + crop_height, rgba.shape[0])))
image.save(dst, "WEBP", quality=88, method=6)
print(dst, image.size, f"background {background.mean():.0%}")
