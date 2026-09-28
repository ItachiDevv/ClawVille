# ClawVille wood-sign SVG comparison

Run `python branding/logo-work/build_logo_svg.py` to rebuild every output from the canonical logo sources.

## Files

- `build_logo_svg.py`: deterministic builder, render loop, and measurement code.
- `candidate-a-constructed.svg`: source path letters, traced plank outline, vector gradients, grain, rim, and offset shadow.
- `candidate-b-traced.svg`: full-color vtracer output from the keyed large sign.
- `../assets/logos/clawville-logo-wood-large-transparent.png`: 1792×576 large sign with real alpha.
- `renders/`: reference at 1000 px, plus A and B at 32, 64, 120, 200, 600, and 1000 px.
- `metrics.json`: reproducible mask and RGB measurements.
- `compare.html`: static dark, light, and sky comparison.

## Metrics at 1000 px

| Candidate | File bytes | Paths | Letter-mask IoU | Silhouette IoU | Mean absolute RGB error |
|---|---:|---:|---:|---:|---:|
| A | 64,211 | 339 | 0.9470 | 0.9892 | 18.30 |
| B | 278,629 | 519 | 0.7803 | 0.9441 | 21.95 |

The letter mask uses HSV hue 16 to 37, saturation above 135, value above 175, and alpha at least 128. The silhouette mask uses alpha at least 128. Mean RGB error includes all pixels inside the reference silhouette.

## Differences and limits

- A keeps the original mono path letter geometry. Its fitted path mask reaches 0.9500 IoU. Its final rendered yellow mask reaches 0.9470; this misses the 0.95 rendered target by 0.0030.
- A has a smooth wood gradient and sparse vector grain. It omits the reference's dense photographic grain.
- B keeps more source color variation, but its 600 px trace input and speckle filter make the grain coarse. Its outer edge and letter registration differ from the reference.
- The large PNG has a baked checkerboard. The key uses the largest saturated connected shape, fills its interior, and blurs only alpha across a 3×3 edge. All RGB pixels remain byte-identical to the large source, including edge RGB pixels. The key excludes the gray outside area and some neutral soft shadow pixels.
- Both SVGs contain paths and gradients only. Neither SVG embeds a raster image.
