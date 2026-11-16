## Appendix B — Scenario: KITE SL01 "Get paid for buying milk"

**Idea.** An ordinary purchase — milk — and a card that pays you for it. Three everyday spends follow one another: the checkout, the ride home, the morning coffee. Each spend is one live shot. The orange KITE field enters from a new side each time.

**Texts come from:** us (copy agent). **Status:** locked after the sketch loop.

The same scenario is also in machine-readable form: `examples/KITE/scenario.json`. The scenario says **what** happens and **how it moves**; positions come from the previews, durations and working windows are computed by plan and inspect (Appendix C).

### B.1 Variant sets

| Axis | Values | Count |
|---|---|---|
| Hook | H1, H2, H3 — each hook brings its own scene | 3 |
| CTA | C1, C2, C3 | 3 |
| Language | EN, DE, ES, FR | 4 |
| Format | 4:5, 9:16, 1:1, 16:9 | 4 |
| Length | 6, 12, 15 s | 3 |
| **Total** | | **432 files from 4 generated scenes** |

- **Naming:** `KITE_SL01_{hook}_{cta}_{lang}_{format}_{length}s_v1`.
- **Scenario code:** `SL01`. **Version:** 1.

### B.2 Beats

| Beat | Role | Scene | Preview | In 6 s | In 12 / 15 s | Copy slots |
|---|---|---|---|---|---|---|
| 1 | hook | by hook: SUPERMARKET (H1, H3) or TABLE (H2) | P0 | yes | yes | headline |
| 2 | problem | TRAM | P1 | — | yes | headline, answer |
| 3 | solution | CAFE | P2 | — | yes | answer, list |
| 4 | end | — | P3 | yes | yes | end sub-line, CTA, store badges |

The 6 s version is hook + end. The composition of each beat is read from its preview; the duration of each beat is set by plan from the reading rule, the recipe's module range and the clip's working window.

### B.3 Scenes

Each scene is generated once: one square static, then one 5 s clip from it.

**SUPERMARKET** — hooks H1, H3.

- **Content:** supermarket checkout, evening, over the shoulder. A hand in a beige coat sleeve holds the KITE card up. On the dark belt: a milk bottle with a blue cap, loose tomatoes, an egg tray, a paper bag, a bag of coffee beans. The cashier is visible from the shoulders down.
- **Key part:** the whole card.
- **Action:**
  - 0.0–0.6 s the card settles into the held position;
  - then the card is held steady with a slight natural sway;
  - the cashier moves out of focus behind.
- **Camera:** locked-off, 35 mm, eye level.
- **Light:** warm, soft overhead store light.
- **Preview:** `inputs/previews/P0_hook_supermarket.png`. **Static:** `outputs/statics/static_SUPERMARKET.jpg`.
- **Watch:** the cashier stands behind the card. Frame her from the shoulders down; her face must not enter any format crop.

**TABLE** — hook H2.

- **Content:** a wooden table seen from above near a window. The KITE card lies on a folded receipt; a milk carton, a crumpled bakery bag and a takeaway coffee cup stand around it.
- **Key part:** the card.
- **Action:** static scene; soft daylight shifts slightly, the camera breathes.
- **Camera:** top-down at 60°, 50 mm.
- **Light:** soft window light from the left.
- **Preview:** not supplied. The approved static stands in for it (AD decision).
- **Static:** `outputs/statics/static_TABLE.jpg`.
- **Open issue:** readable generic words ("MILK", bakery stamp, receipt text) — a warning for the AD.

**TRAM** — problem beat.

- **Content:** a tram seat by the window, overcast day. A canvas tote bag with a baguette, kale, eggs, apples and a jar of sauce; the KITE card sits in the front pocket. A passenger in an olive jacket is visible as arm and knee only.
- **Key part:** the bag with the card in its pocket.
- **Action:** the tram sways gently; the street passes, blurred.
- **Camera:** locked-off, seat height, 35 mm.
- **Light:** soft diffuse daylight from the window.
- **Preview:** `inputs/previews/P1_problem_tram.png`. **Static:** `outputs/statics/static_TRAM.jpg`.

**CAFE** — solution beat.

- **Content:** a café counter. A hand holds the KITE card above a card terminal; a cappuccino cup on a saucer stands behind.
- **Key part:** the card logo and the point where the card meets the terminal.
- **Action:**
  - 0.0–1.2 s the card lowers toward the reader;
  - 1.2–1.6 s the card touches the reader;
  - then it rests there.
- **Camera:** locked-off, close-up from above at 45°, 50 mm.
- **Light:** warm morning window light from the right.
- **Preview:** `inputs/previews/P2_solution_cafe.png`. **Static:** `outputs/statics/static_CAFE.jpg`.

**End frame** — field only.

- **Preview:** `inputs/previews/P3_end.png`.

### B.4 Copy

**Hooks** (each line of a slot is separated by /)

| Hook | Scene | EN | DE | ES | FR |
| --- | --- | --- | --- | --- | --- |
| H1 | SUPERMARKET | Get paid / for buying milk | Geld zurück / für jede Milch | Cobra por / comprar leche | Payé pour / acheter du lait |
| H2 | TABLE | Breakfast that / pays you back | Frühstück, das / dich bezahlt | Un desayuno / que te paga | Le petit-déj / qui te paie |
| H3 | SUPERMARKET | 5% back / on every shop | 5 % zurück / bei jedem Einkauf | 5 % de vuelta / en cada compra | 5 % remboursés / à chaque course |

**CTAs**

| CTA | EN | DE | ES | FR |
| --- | --- | --- | --- | --- |
| C1 | GET IT NOW | JETZT HOLEN | CONSÍGUELA YA | OBTIENS-LA |
| C2 | GET THE CARD | KARTE HOLEN | PIDE TU TARJETA | PRENDS TA CARTE |
| C3 | GET KITE | KITE HOLEN | CONSIGUE KITE | PRENDS KITE |

**Fixed copy**

| Slot | EN | DE | ES | FR |
| --- | --- | --- | --- | --- |
| `problem.headline` | Your card doesn’t / pay you on food | Deine Karte zahlt / dir nichts fürs Essen | Tu tarjeta no te paga / por la comida | Ta carte ne te paie / pas tes courses |
| `problem.answer` | KITE does | KITE schon | KITE sí | KITE, si |
| `solution.answer` | KITE pays / 5% back | KITE zahlt / 5 % zurück | KITE paga / el 5 % | KITE rend / 5 % |
| `solution.list` | Groceries / Transport / Coffee | Lebensmittel / Nahverkehr / Kaffee | Súper / Transporte / Café | Courses / Transport / Café |
| `end.sub` | Free card. 3 minutes / no fee · no minimum | Gratis-Karte. 3 Minuten / 0 € Gebühr · kein Minimum | Tarjeta gratis. 3 minutos / sin comisión · sin mínimo | Carte gratuite. 3 minutes / sans frais · sans minimum |

Text fit is measured by plan for every slot × language × format (Appendix C.3).

### B.5 References

- **Product reference:** `inputs/references/kite_card_reference.jpg`. It is cut from the approved TABLE static; replace it with a clean product render when one exists.
- **Object lock:** see A.7.

### B.6 Motion

The recipe (split-screen) gives the grammar: how a panel leaves and enters, the change frame, the curves and the timings (section 5.2). The scenario says how each beat uses it. Nothing here is measured from a video.

**Per beat**

| Beat | Enters | Text | Brand device | Video | Leaves |
|---|---|---|---|---|---|
| hook | does not enter: frame 0 is the complete hook frame | headline on plaques, static from frame 0 | tab visible from frame 0 | clip plays from the start of its working window | panel leaves through its outer edge (bottom), 0.16 s, ease-in; the tab goes on the first exit frame; the text stays |
| problem | field-only frame 0.04 s with a hard text swap; panel enters from its outer edge (top), 0.25 s, ease-out | headline on plaques rides in with the panel, then static; answer "KITE does" types on word by word, 0.2 s after the panel settles, 0.125 s per word | tab appears whole 0.05 s after the panel settles | clip starts at the beat start | panel leaves through the top, 0.16 s |
| solution | field-only frame 0.04 s; panel enters from the left, 0.25 s | answer and list appear with the text swap; the list rides with the split; both static | tab appears 0.05 s after the panel settles | clip starts at the beat start, so the card touches the reader at about 0.5 s of the beat | panel leaves through the left, 0.16 s |
| end | the large logo drops 5u into place in 0.15 s, fading in | the sub-line types on word by word from 0.05 s, 0.125 s per word; 0.1 s after the last word the CTA and the store badges rise 8u in 0.25 s | — | — | holds at least 2.0 s after the CTA settles |

**Motion cues per text slot** (read by plan into the engine config)

| Slot | Cue |
|---|---|
| `hook.headline`, `problem.headline`, `solution.answer`, `solution.list` | static (appear with the text swap) |
| `problem.answer`, `end.sub` | type on, word by word |
| `end.cta` + badges | rise |

**Text riding.** Text that sits against the split (hook headline, problem headline, solution list) moves with the panel while it enters. Text placed from the frame edge or stacked under the logo (all 9:16 text) does not move.

**Never animated:** the corner logo, plaques after they appear, store badges after they settle. **Not allowed:** dissolves, blur, scene zoom, 3D, glitch.

