# KITE SL01 — Get paid for buying milk

## 1. Brand
KITE v1

## 2. Idea
An ordinary purchase — milk — and a card that pays you for it. Three everyday spends follow one another: the checkout, the ride home, the morning coffee. Each spend is one live shot; the orange KITE field enters from a new side each time.

## 3. Formats and platforms
- 4:5 (master)
- 9:16: reels_9x16
- 1:1
- 16:9

## 4. Lengths
6, 12, 15

## 5. Languages
EN (source), DE, ES, FR
translate: no

## 6. Copy
### hook.headline (hook) style: headline
| variant | EN | DE | ES | FR |
|---|---|---|---|---|
| H1 | Get paid / for buying milk | Geld zurück / für jede Milch | Cobra por / comprar leche | Payé pour / acheter du lait |
| H2 | Breakfast that / pays you back | Frühstück, das / dich bezahlt | Un desayuno / que te paga | Le petit-déj / qui te paie |
| H3 | 5% back / on every shop | 5 % zurück / bei jedem Einkauf | 5 % de vuelta / en cada compra | 5 % remboursés / à chaque course |

### problem.headline style: headline
| EN | DE | ES | FR |
|---|---|---|---|
| Your card doesn’t / pay you on food | Deine Karte zahlt / dir nichts fürs Essen | Tu tarjeta no te paga / por la comida | Ta carte ne te paie / pas tes courses |

### problem.answer style: answer
| EN | DE | ES | FR |
|---|---|---|---|
| KITE does | KITE schon | KITE sí | KITE, si |

### solution.answer style: answer
| EN | DE | ES | FR |
|---|---|---|---|
| KITE pays / 5% back | KITE zahlt / 5 % zurück | KITE paga / el 5 % | KITE rend / 5 % |

### solution.list style: list
| EN | DE | ES | FR |
|---|---|---|---|
| Groceries / Transport / Coffee | Lebensmittel / Nahverkehr / Kaffee | Súper / Transporte / Café | Courses / Transport / Café |

### end.sub style: end_sub
| EN | DE | ES | FR |
|---|---|---|---|
| Free card. 3 minutes / no fee · no minimum | Gratis-Karte. 3 Minuten / 0 € Gebühr · kein Minimum | Tarjeta gratis. 3 minutos / sin comisión · sin mínimo | Carte gratuite. 3 minutes / sans frais · sans minimum |

### end.cta (cta) style: cta
| variant | EN | DE | ES | FR |
|---|---|---|---|---|
| C1 | GET IT NOW | JETZT HOLEN | CONSÍGUELA YA | OBTIENS-LA |
| C2 | GET THE CARD | KARTE HOLEN | PIDE TU TARJETA | PRENDS TA CARTE |
| C3 | GET KITE | KITE HOLEN | CONSIGUE KITE | PRENDS KITE |

## 7. Beats
| beat | role | sketch | 6 | 12 | 15 | what happens |
|---|---|---|---|---|---|---|
| hook | hook | P0_hook_supermarket.png | 3.0 | 2.9 | 3.3 | A hand holds the KITE card up at the checkout; the hook headline sits on plaques above the scene. |
| problem | problem | P1_problem_tram.png | — | 3.2 | 4.2 | The card rides home in a tote bag on the tram; the problem headline, then “KITE does” types on. |
| solution | solution | P2_solution_cafe.png | — | 3.1 | 3.8 | The card taps a café terminal; the answer and the list of categories. |
| end | end | P3_end.png | 3.0 | 2.8 | 3.7 | Field only: the large logo, the sub-line, the CTA and the store badges. |

## 8. Elements
| name | beat | what | source | key part | must not | variants |
|---|---|---|---|---|---|---|
| field | — | the orange KITE field behind everything | engine 2D | — | — | — |
| hook scene | hook | supermarket checkout (H1, H3) or a breakfast table from above (H2); a hand holds the KITE card | clip to generate | the whole card | faces; readable brands; cash | by hook: H1=SUPERMARKET, H2=TABLE, H3=SUPERMARKET |
| tram scene | problem | a canvas tote bag on a tram seat with the KITE card in its front pocket | clip to generate | the bag with the card in its pocket | faces; readable brands | — |
| cafe scene | solution | a hand lowers the KITE card onto a café card terminal, a cappuccino behind | clip to generate | the card logo and the point where the card meets the terminal | faces; readable brands | — |
| tab | hook, problem, solution | the brand tab poking from the field into the scene panel | engine 2D | — | — | — |
| store badge iOS | end | the App Store badge | engine 2D | — | — | — |
| store badge Android | end | the Google Play badge | engine 2D | — | — | — |

## 9. UI

## 10. Motion
### hook
- frame 0 is the complete hook frame: the panel does not enter
- the headline sits on plaques, static from frame 0
- the tab is visible from frame 0
- the clip plays from the start of its working window
- the panel leaves through its outer edge in 0.16 s, ease-in; the tab goes on the first exit frame; the text stays
### problem
- a field-only frame of 0.04 s with a hard text swap
- the panel enters from its outer edge in 0.25 s, ease-out; the headline rides in with the panel, then stays static
- the answer types on word by word, 0.2 s after the panel settles, 0.125 s per word
- the tab appears whole 0.05 s after the panel settles
- the panel leaves through its outer edge in 0.16 s
### solution
- a field-only frame of 0.04 s; the panel enters from its outer edge in 0.25 s
- the answer and the list appear with the text swap; the list rides with the split; both static
- the tab appears 0.05 s after the panel settles
- the panel leaves through its outer edge in 0.16 s
### end
- the large logo drops 5u into place in 0.15 s, fading in
- the sub-line types on word by word from 0.05 s, 0.125 s per word
- 0.1 s after the last word the CTA and the store badges rise 8u in 0.25 s
- the frame holds at least 2.0 s after the CTA settles
- never moves: the corner logo, plaques after they appear, store badges after they settle

## 11. Groups

## 12. References
- references/kite_card_reference.jpg — product reference for the KITE card
