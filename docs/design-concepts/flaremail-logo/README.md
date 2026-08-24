# FlareMail logo source record

This directory preserves the original image-generation inputs and outputs that informed the
production FlareMail logo. The generated PNGs are concept records, not shipping assets.

## Production assets

- [`../../../static/brand/flaremail-mark.svg`](../../../static/brand/flaremail-mark.svg): standalone
  product mark.
- [`../../../static/brand/flaremail-logo.svg`](../../../static/brand/flaremail-logo.svg): horizontal
  logo lockup.
- [`../../../static/favicon.svg`](../../../static/favicon.svg): favicon derived from the product
  mark.

The production SVGs were redrawn from the selected flame-and-envelope direction so they remain
flat, transparent, scalable, and legible at 32 px. They deliberately do not reproduce the glow,
gradient, or baked checkerboard found in the generated concept images.

## Original generated outputs

- [`imagegen-concept-v1.png`](./imagegen-concept-v1.png): first built-in imagegen result.
- [`imagegen-refinement-v2.png`](./imagegen-refinement-v2.png): targeted flat/transparent
  refinement request. The checkerboard is baked into the RGB image rather than stored as alpha.

## Original prompt — concept v1

Submitted verbatim to the built-in imagegen tool on 2026-08-24:

```text
Use case: logo-brand
Asset type: primary brand logo for the FlareMail email workspace, suitable for app header, login screen, website, favicon derivation, and product documentation
Primary request: Design one refined, original horizontal logo lockup for FlareMail. Create a memorable geometric symbol that fuses an upward flare or flame with the folded flap of an envelope in one unified silhouette, then pair it with the exact wordmark "FlareMail". The symbol must feel like a purpose-built technology product mark, not a generic stock flame or generic mail icon.
Scene/backdrop: genuinely transparent background with generous clean padding
Subject: compact symbol on the left, exact wordmark "FlareMail" on the right
Style/medium: flat vector-style brand design, minimal, precise, mature, contemporary, strong silhouette, carefully balanced negative space, optical geometry, clean edges
Composition/framing: centered horizontal lockup; symbol and wordmark aligned on a shared visual center; icon should also remain recognizable at 16–32 px; no presentation board, no mockup, no extra variants
Color palette: FlareMail orange #F48120 as the signature color, deep graphite #1D1D1F for the wordmark; small optional use of deep blue #0055DC only if essential, otherwise keep to orange and graphite; flat solid colors only
Typography: custom-looking modern humanist geometric sans serif, medium-bold, slightly tight tracking, friendly but operational; render the product name exactly as "FlareMail" with capital F and capital M
Text (verbatim): "FlareMail"
Constraints: independent product identity; scalable; simple enough to recreate as SVG; visually balanced in both light and dark UI contexts; genuinely transparent background; exact spelling; no gradients, no shadows, no outlines around the whole lockup, no tiny details
Avoid: Cloudflare logo, clouds, copied vendor shapes, Lucide-style generic flame, Gmail resemblance, Firefox resemblance, literal fire illustration, swooshes, lightning bolts, paper planes, glossy 3D, glassmorphism, badges, rounded-square app tile, taglines, extra text, watermark
```

## Original prompt — refinement v2

Submitted verbatim to the built-in imagegen tool with the concept v1 image as the edit target:

```text
Use case: logo-brand
Asset type: final primary brand logo for FlareMail
Input images: Image 1 is the edit target and the approved geometric direction
Primary request: Refine Image 1 into a strict flat vector-style logo. Preserve the core idea and overall geometry: the orange upward flare nested into an envelope shape on the left and the exact wordmark "FlareMail" on the right. Change only the rendering and optical cleanup.
Required changes: remove the entire black or dark background; make the background genuinely transparent; remove every glow, shadow, bloom, gradient, haze, texture, lighting effect, and dimensional effect; render the symbol as clean flat solid #F48120; render the wordmark as clean flat solid #1D1D1F; simplify any hairline seams so the mark stays legible at 16–32 px; give the symbol and wordmark crisp antialiased edges and balanced spacing.
Typography: retain the modern geometric humanist sans feel; render exactly "FlareMail" with capital F and capital M, no extra characters
Composition: centered horizontal lockup with generous transparent padding; no mockup, no presentation board, no variants
Constraints: flat solid colors only; no outline around the lockup; independent product identity; simple enough to recreate as SVG
Avoid: background of any color, glow, gradient, shadow, Cloudflare logo, cloud shape, Gmail resemblance, Firefox resemblance, app tile, badge, tagline, extra text, watermark
```
