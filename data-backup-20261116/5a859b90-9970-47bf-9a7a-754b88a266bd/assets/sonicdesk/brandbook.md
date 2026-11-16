# sonicdesk. — brand book

sonicdesk. is a workspace where a band keeps its songs: every take lossless, every version kept, comments on the exact bars. The interface is built like studio gear — black canvas, square corners, hairlines, mono labels, and one lime light that says what is happening now. Everything here mirrors the product's own UI kit (`/uikit`); when a component and a rule disagree, the rule wins.

## Principles

1. **One lime per screen.** `lime` marks the action to take or the state you are in — the play button, the current section, the playhead, the chord sounding now. It never colours data: BPM, keys, file types and counts stay `foreground` or `muted-foreground`. When two things are lime, neither is.
2. **One filled button.** `primary` (lime fill, `primary-foreground` text) is the one thing the screen is for. `solid` (foreground fill) is for Export only. Everything else is `ghost` (a `border` outline). `link` is for secondary actions inside dialogs. A whole row that opens something is clickable itself; it gets no "Open" button.
3. **Toggles are outlined, not filled.** A mode that is on gets a `foreground` outline at 50%, a `surface` fill and a pulsing lime dot — never a lime fill, so it cannot compete with the primary action.
4. **Names as typed.** Space, project, track, member and stage names are the user's words: Archivo bold (`card-name`, `row-name`, `small-name`), exactly as typed. Uppercase mono is only for labels the product writes.
5. **Every number once, zeros hidden.** A count in a tab is not repeated in the hero. Zero counts and unknown values are left out. Plurals agree: 1 track, 2 tracks.
6. **Destructive actions hide one step deep.** Delete lives in the ⋮ menu, in `destructive`, behind a confirmation; deleting a space or project asks for its name.
7. **Redesigns keep the motion.** A component that animated keeps its animation and interactions.

Before a screen ships: one lime element; one filled button; names as typed; every number once; hover-only controls stay visible on touch; touch targets ≥ 40px (`touch-target`); no text under 10px (9px only under numbers); `destructive` only for errors and deletes, `chart-4` amber for stalls; the copy uses the vocabulary below and promises nothing the product does not do.

## Content fundamentals

**Voice.** Direct, never decorative. Built by musicians, for musicians. Mechanical-confident, like good studio gear. Specific — bars, takes, versions, not "items". Never marketing-soft ("Unleash your creativity!"), never developer-speak, never alarmed (a slow song is not an error), never cute or promising what the product can't do.

**Vocabulary.**

| Say | Not |
|---|---|
| space | band |
| project | song (as the object), item |
| version | branch |
| Master | main |
| apply | merge |
| overlapping changes | conflicts |

The landing's four verbs are the one exception, a slogan written as musicians talk: **Branch it. Break it. Compare it. Merge it back.**

**Casing.** Product labels, meta and buttons are UPPERCASE mono with wide tracking (`meta`, `section-label`). Names, sentences, toasts and empty states are sentence case. The wordmark is always lowercase.

**Real copy.**

- Primary action (app): "New project" · landing CTA: "+ Create my space"
- Empty state: "No projects yet. Upload stems or start blank."
- Toasts: "Version applied." · "Couldn't save — retrying."
- Status: "No movement for 12 weeks" (amber dot, plain words — not "Stuck!")
- Confirmation: "Delete “Taking my dog”? This removes every version, track and comment. Type the project name to confirm."
- Meta line: "120 BPM · C · 3:47" then "4 TRACKS · 2 VERSIONS · 10D AGO"

**Music the way musicians write it.** Keys short: C, Em, F#m — spelled by the song's key (flats in flat keys: Bb, Eb; sharps in sharp keys: F#, C#). Positions as bar.beat (41.3), durations m:ss (3:47), relative time "10d ago · yesterday · just now", older dates "Oct 4", sizes "112.3 MB · 50 GB".

**Honesty.** No competitor names anywhere — copy, metadata or keywords. No numbers or promises the product can't back. No emoji in the UI.

## Visual foundations

**Colour.** Every colour is a semantic token, never a hex in a component. Back to front: `background` (the canvas — pure black in Lime), `surface` (panels, hover rows), `surface-2` (inset and pressed: meter tracks, resting play buttons), `popover` (menus, dialogs, toasts). Text is `foreground` for content and `muted-foreground` for everything the product writes about it. Meaning colours: `lime` = action / now; `destructive` = errors, deletes, storage over 90%; `chart-4` amber = stalls and warnings; `online` = online, ready, valid. The activity feed colours categories with `chart-1` applied, `chart-2` uploads, `chart-3` versions, `chart-4` structure and resources, `chart-5` comments. `compare-b` is only side B of an A/B compare. `track-1`…`track-10` identify tracks, members and spaces and never mean anything.

**Themes.** Lime is the default and the brand; every promo and the landing use it. Blush Dark / Blush Light swap lime for pink, Studio Dim / Studio Dim Light for teal, Studio Paper / Studio Paper Dark for indigo — the token named `lime` carries each theme's accent. The landing has its own always-dark set (`sd-bg`, `sd-fg`, `sd-mute`, `sd-line`, `sd-accent`, `sd-on-accent`); the two sets are never mixed.

**Type.** Two families. Archivo (`display`) for names, headings, numbers and primary buttons — bold, tight tracking (−0.02 to −0.05em). JetBrains Mono (`mono`) for everything else: body, meta, timecodes, BPM, file names. Use the styles as named: `greeting`, `page-name`, `card-name`, `row-name`, `small-name`, `dialog-title`, `big-number`, `body`, `small-body`, `meta`, `section-label`, `micro`. 10px is the floor for anything read; 9px (`micro`) only under a number or marker; nothing smaller. Landing and promo use `landing-hero` (Archivo 800 uppercase, leading 0.85), `display-xl/l/m`, `lede`, `landing-key`, `landing-value`.

**Shape.** Square by default (`radius-none`). Round (`radius-pill`) is reserved for waveform pills, status dots and the volume knob.

**Lines.** Hairlines are real 1px `border` lines (`border-r border-b` on grid cells, `divide-y` in lists) — a 1px gap over a coloured fill disappears on phones. Cards in a grid share hairlines; there are no gaps, no rounded cards and no coloured left borders.

**Elevation.** Nothing in the page flow casts a shadow. Overlays — menus, popovers, dialogs, drawers, toasts — use `popover` with a `border` and `shadow-overlay`. The stacking order is `z-footer` 40 < `z-header` 50 < `z-drawer` 200 < `z-popover` 6000 < `z-modal` 8000 < `z-toast` 9000 < `z-tooltip` 9999. Dialog and drawer backdrops are `background` at 70–80% with a small blur.

**Spacing & grid.** A 4px scale (`space-0-5` … `space-8`). Brand backgrounds sit on a 40px master grid (`grid-master`) with a 16px micro grid for bar lines, drawn in `grid`. Rows pad 12×16px, cards 20px, dialogs 24px; the header is 56px.

**Waveforms.** Pills, never rectangles: full-round bars with a 2px gap (3px on phones), height from the audio peaks with a 14–15% floor. Unplayed pills are the track colour (or `foreground`) at 15–25%; played pills turn `lime`. The playhead is a 1px `lime` line with a soft glow (`shadow-playhead`) and a small triangle on the ruler.

**States.** Hover: ghost controls turn their border and text `lime`; rows fill `surface` and draw a 2px lime rail down their left edge; primary buttons scale to 1.04 and press to 0.98. Focus: `ring` (lime) outline or a lime input border. Disabled: 50% opacity. On: outline + `surface` + pulsing dot. Hover-revealed controls exist only on devices with a real pointer (`can-hover`); on touch they are always shown.

**Motion.** Physical and quick: entrances use cubic-bezier(0.32, 0.72, 0, 1) — cards and rows slide in over 0.6s, staggered 40–50ms; waveform pills grow in over 0.7s, 3–6ms apart; drawers slide from the right in 0.25s over a 0.25s fade. Loops and pulses mean something is live (playing, recording, a mode on). Nothing shifts layout while loading — skeletons match what replaces them. Every animation has a `prefers-reduced-motion` fallback. The landing moves in time at 142 BPM with its own ease, cubic-bezier(0.16, 1, 0.3, 1).

**Surfaces for overlays.** Drawer for secondary panels (Quick peek, Plan). Dialog for confirmations and short forms. Popover for context on the timeline. Nothing pushes the mixer down.

## Iconography

Icons are lucide-react at 1.75px stroke, 16–20px, in `currentColor` so they follow the text token. Two product marks: `MetronomeIcon` (lucide Metronome) and `CountInMark`, the mono "1..2.." count-in. Menus use a three-dot vertical glyph (⋮); Quick peek is an eye on phones. Icon-only buttons carry an `aria-label`. No emoji anywhere in the UI.

## Logo

The wordmark is type, not a drawing: **sonicdesk** in Archivo bold, tight tracking, `foreground`, closed by a `lime` full stop — see the SonicdeskWordmark card. Never set it in capitals, never colour the whole word lime, never place it on a lime surface. The app icon (`assets/Logos/app-icon.svg`) is a lime pill (`#dfff00`) on a near-black square (`#0d0d0d`) — the waveform pill as a mark.

## Landing & ads

See the "Landing & ads" section: the page is a song, every ad shows the real product, one idea and one lime per frame.
