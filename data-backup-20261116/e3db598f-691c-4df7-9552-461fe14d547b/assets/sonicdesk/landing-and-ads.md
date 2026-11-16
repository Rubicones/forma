# Landing & ads

## The page is a song

The landing is structured like a track: every block is a section of a song, scroll is the playhead, and the transport at the bottom shows where you are. It runs at **142 BPM** — durations and staggers are beats and note values, so the page moves in time.

| # | Section | Topic | Bars |
|---|---|---|---|
| 01 | Intro | The workspace | 8 |
| 02 | Verse | Versions | 20 |
| 03 | Chorus | Features | 12 |
| 04 | Bridge | Rehearsal | 16 |
| 05 | Breakdown | Philosophy | 22 |
| 06 | Outro | Plans & FAQ | 42 |

## Tokens and layout

The landing uses its own always-dark set: `sd-bg` canvas, `sd-surface` panels, `sd-fg` text, `sd-mute` small mono text, `sd-line` hairlines, `sd-accent` lime, `sd-on-accent` text on lime. Components never name a colour, and the app tokens and `sd-*` tokens are never mixed. Only product depictions inside the page may show another app theme. If a light version is ever made, lime is only a fill with dark text there — never text or a hairline.

| Token | Phone | ≥ 992px |
|---|---|---|
| gutter | 16px | 32px |
| header | 48px | 56px |
| chapter strip | 32px | — |
| transport bar | — | 64px |
| map | — | 52px |

## Type

- Headline: `landing-hero` — Archivo 800, UPPERCASE, line-height 0.8–0.95, sized to the viewport; a lime full stop may close it ("REHEARSE FROM YOUR PHONE.").
- Lede: `lede` — Archivo 700, sentence case.
- Key / value: `landing-key` (mono 11px, 0.18em, uppercase, `sd-mute`) beside `landing-value` (mono 15px, `sd-fg`): "MASTER · V12 — 142 BPM · 3:47".

## Motion

Everything that moves with scroll or time is GSAP (ScrollTrigger, SplitText, DrawSVG, ScrambleText) over Lenis scrolling; hovers are CSS transforms on the same curve. Durations are beats at 142 BPM; staggers are 1/8 or 1/16 notes. House ease: cubic-bezier(0.16, 1, 0.3, 1). Every scene has a reduced-motion branch, and nothing measured from content shifts the layout.

## Messages

**Versions — the four verbs**

- **BRANCH IT.** Try an idea in a copy. Master stays exactly as the band agreed.
- **BREAK IT.** Rewrite the bridge, re-record a take, change anything. Every version is kept.
- **COMPARE IT.** Play both, bar for bar. Only the bars that differ light up.
- **MERGE IT BACK.** Agree on it, and apply it. Master moves to its next version.

**Rehearsal** — "REHEARSE FROM YOUR PHONE." / "No laptop. No DAW. Just structure, chords, and a metronome you can trust."

**Primary CTA** — "+ Create my space".

**Feature pads — the full, honest feature list (16).** Comments on bars · Chord detection · Song structure · A/B compare · Lossless audio (up to 192 kHz, downloads as WAV) · Record a take · Themes · Lyrics · MIDI editor · Roadmap · Checklist · Chat (per space and per song, with @mentions) · Resources · Activity feed · Role tags · Export & share. An ad may claim any of these and nothing beyond them.

## Ads & promo rules

- **Show the product, not a mood.** Every ad depicts a real surface: the mixer with its pill waveforms, a structure ribbon, the rehearsal chord screen on a phone, an A/B moment, a space card, a project row. Build it from these components — never invented UI.
- **One idea, one lime.** One message per frame, one lime element carrying it (the playhead, the current section, or the CTA). Dark canvas (`sd-bg` / Lime `background`), Archivo display headline in capitals, JetBrains Mono for meta.
- **Say it like a musician.** The four verbs, bars and takes — not features and items. Space, project, version, Master. CTA: "Create my space".
- **Motion in time.** Video and animated ads cut and move on the beat: pick a BPM, cut on bars, stagger on 1/8 notes. The playhead sweeping a waveform is the signature move.
- **Formats.** Keep the 16px / 32px gutters scaled to the format, a header-like top strip for the wordmark, and a single CTA at the bottom. Square and vertical crops lead with the phone rehearsal screen.
- **Never.** Competitor names (in copy, metadata or targeting keywords). Numbers the product can't back. Stock gradients, glow-heavy "AI" aesthetics, rounded bubbly UI, the wordmark in capitals or all lime.
