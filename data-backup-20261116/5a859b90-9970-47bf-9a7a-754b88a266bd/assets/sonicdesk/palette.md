# sonicdesk. — palette (hex)

Converted from the design system's OKLCH tokens (Lime theme, the brand default; landing and promo always use these values).
Ads use the always-dark promo set `sd-*`; the app set is for product depictions inside an ad. The two sets are never mixed.

## Promo set (ads, landing)

| token | hex | source | usage |
|---|---|---|---|
| `sd-bg` | #070707 | oklch(0.13 0 0) | Landing and promo canvas. Always dark: neither the system preference nor an app theme repaints it. |
| `sd-surface` | #0d0d0d | oklch(0.16 0 0) | Landing panels and cards. |
| `sd-fg` | #e8e8e8 | oklch(0.93 0 0) | Landing text on sd-bg and sd-surface. |
| `sd-mute` | #9e9e9e | oklch(0.7 0 0) | Landing small mono text (.sd-k keys) on sd-bg; a step brighter than the app grey so it stays AA. |
| `sd-line` | #242424 | oklch(0.26 0 0) | Landing hairlines. |
| `sd-accent` | #dfff00 | #dfff00 | Landing lime: playhead, current section, primary CTA, the value line. One lime thing per frame. |
| `sd-on-accent` | #070707 | oklch(0.13 0 0) | Text on sd-accent (the CTA). |

## App set (product screens shown inside an ad)

| token | hex | source | usage |
|---|---|---|---|
| `background` | #000000 | oklch(0 0 0) | Canvas: page, rows, card cells. The ground every other surface sits on. Lime theme is pure black; the landing and promo always use the lime values. |
| `surface` | #0d0d0d | oklch(0.16 0 0) | Panels, hover row, hero band, menus inside a card. One step up from background. |
| `surface-2` | #141414 | oklch(0.19 0 0) | Inset and pressed: empty meter and timeline tracks, the play and menu buttons at rest. |
| `foreground` | #e8e8e8 | oklch(0.93 0 0) | Primary text, names, numbers on background, surface, surface-2, card and popover. |
| `border` | #242424 | oklch(0.26 0 0) | Every hairline: dividers, outlines, card cells, ghost buttons at rest. Hairlines are 1.3-1.45:1 against background in every theme: dividers, not affordances. Controls get their meaning from the label text, and hover turns their border lime. |
| `chart-1` | #dfff00 | #dfff00 | Activity: applied versions (lime family). |
| `chart-2` | #61d46a | oklch(0.78 0.18 145) | Activity: uploads (green). |
| `chart-3` | #19affe | oklch(0.72 0.16 240) | Activity: versions (blue). |
| `chart-4` | #ebb600 | oklch(0.80 0.18 90) | Amber: structure, resources, metadata activity, and stalls ("No movement for 12 weeks"). Always paired with words. In Blush Light the dot is 2.5:1 on background; flagged. |
| `chart-5` | #cc67e3 | oklch(0.68 0.20 320) | Activity: comments (magenta). |
| `grid` | #1b1b1b | oklch(0.22 0 0) | Bar grid, tact columns and the 16px grid background of the mixer timeline. |
| `muted-foreground` | #7a7a7a | oklch(0.58 0 0) | Meta, labels and everything the product writes about the content, on background, surface and card. Kept off surface-2 (4.3:1 there). |
| `lime` | #dfff00 | #dfff00 | The signature accent: the one action or current state per screen (play, the current section, the playhead, the chord sounding now). Never colours data. Each theme swaps its hue; the name stays. |
| `lime-soft` | #dfff001f | #dfff001f | Accent wash behind a current item (current section, selected row). |
| `primary-foreground` | #070707 | oklch(0.13 0 0) | Text and icons on primary and lime fills (dark in lime, light in the pink and indigo themes). Source pair misses 4.5:1 in Blush Dark (2.6:1) and Studio Paper Dark (3.6:1); kept exact, flagged. |
| `destructive` | #ed3345 | oklch(0.62 0.22 22) | Errors, deletes, storage above 90%. Nothing else. |
| `online` | #61d46a | oklch(0.78 0.18 145) | Online, ready, valid input, the SYS OK pulse. |
| `compare-b` | #907bff | oklch(0.68 0.22 285) | Side B in A/B compare only. Side A is lime. |

## Type

- Display: **Archivo** 700 / 800 — names, headlines (ads: `landing-hero`, 800, UPPERCASE, leading 0.85, a lime full stop may close the line).
- Mono: **JetBrains Mono** 400 / 500 / 700 — body, meta, keys and values, timecodes.
- Font files: `fonts/` (OFL, from Google Fonts via Fontsource).
