# ForgeSworn site design system

The six marketing sites should read as siblings. Today they don't: four different
typographic setups across six pages, one of which ships no webfont at all and one
of which has no display face. This is the shared skeleton. Each site keeps its own
palette — the colour *is* the product's identity — and adopts the same type system,
scale and rules.

Piloted on heartwood.forgesworn.dev. Nothing else has adopted it yet.

## Three faces, three jobs

| Face | Job | Never used for |
|---|---|---|
| **Fraunces** | Headings, hero lede, marginalia, figure captions, emphasis | Long body copy |
| **Inter** | Body copy, spec descriptions, steps, anything you actually read | Headings |
| **JetBrains Mono** | Labels, eyebrows, nav, buttons, code, figure numbers | Prose |

The rule that matters: **Fraunces carries the voice, Inter carries the argument.**

Fraunces is a display serif with high stroke contrast. On a near-black ground its
hairlines get eaten at reading sizes, and heartwood was setting ~3,000 words of
dense technical prose in it at 17px. It is a wonderful heading face and a poor
body face. Inter is the opposite and that is the point: it should disappear.

All three are SIL OFL 1.1 and self-hosted. No third-party requests — several of
these pages promise exactly that in the colophon, so a Google Fonts link would
make the page a liar.

## Type scale

Everything below the `h2` used to sit at one size. Three text sizes, minimum:

```css
--text-lede:   clamp(1.18rem, 1.5vw, 1.34rem);  /* introduces */
--text:        1.0625rem;                       /* argues     */
--text-detail: 0.98rem;                         /* supports   */
```

Rendered on heartwood: 80 / 38.4 / 21.4 / 17 / 15.7 px. It was 80 / 38.4 / 17 / 17 / 17.

Body copy gets `line-height: 1.7` and `letter-spacing: -0.003em`. Inter runs a
little loose by default at text sizes.

## Rules worth writing down

**Emphasis uses the display face.** Only a handful of words on any of these pages
are emphasised. Shipping a second Inter file for them is not worth ~50KB, and
without it the browser synthesises an oblique, which looks awful. Route `em` in
body copy to Fraunces italic at `1.06em` — Fraunces has the smaller x-height, so
it needs the nudge to sit level on the line.

**Continuous prose in two columns uses `column-count`, not a grid.** A grid pairs
paragraphs by index, so a short one beside a long one leaves half the row empty.
Columns balance the text regardless of how the paragraphs happen to divide. Set
`orphans: 3; widows: 3` and collapse to one column at 820px.

**Set Fraunces' `opsz` explicitly on every heading.** The optical-size axis runs
9–144 and **defaults to 9**, its caption cut. At hero size that renders as a
lurching, over-calligraphic version of the face that looks like a different and
much worse typeface — it reads as though the heading has been set in a synthetic
italic. `font-optical-sizing: auto` did not rescue it. heartwood had this right
already; bark hit it the moment Fraunces was introduced. Use `"opsz" 144` on the
h1, `60` on h2, `32` on h3.

**Weights tuned for a system sans are too heavy for Fraunces.** bark's h1 was
`font-weight: 800`, which is right for a UI grotesque and far too much for a
display serif. 500 on the h1, 470 on h2, 520 on h3.

**Check contrast, don't eyeball it.** heartwood's muted tone was `#7d6f56` at
4.07:1 on `#0b0806`, under AA, and it carried the honest-limits paragraphs — real
content, not decoration. `#938565` is 5.5:1. Anything carrying a sentence needs
4.5:1.

**Motion is CSS where the page promises no scripts.** cambium, heartwood and
sapwood all print "This page is static: no scripts" in the colophon. Scroll
reveals there use `animation-timeline: view()` behind an `@supports` guard, never
a library. See the scroll-driven block in each stylesheet.

## What each site needs to adopt this

| Site | State |
|---|---|
| heartwood | **done** — the pilot |
| cambium | **done** |
| bark | **done** — Fraunces + Inter, `--dim` to AA, approval dialog in the hero |
| sapwood | **deliberately exempt, see below** |
| forgesworn.dev | Undecided: swap to Fraunces + Inter, or keep Instrument Serif + DM Sans and align only the scale |
| bray | Same as forgesworn.dev |

### sapwood is exempt, and that was a correction

An earlier draft of this file listed sapwood as the worst offender: "no display
face at all, everything is JetBrains Mono". That was wrong, and it was wrong
because it came from reading the stylesheet rather than looking at the page.

All-mono is the *concept*. Sapwood is a console; the hero is a terminal window,
the wordmark carries a blinking cursor, and the page matches the app it
advertises. Its hierarchy is carried by weight, colour, case and letter-spacing
rather than by size — which is the correct move in a monospace system, where
size steps are coarse and unconvincing. Every colour token clears AA, most clear
AAA. It is the best-executed page of the six.

Imposing the family serif on it would destroy the idea to gain consistency
nobody asked for. Leave it alone.

forgesworn.dev and bray already have a sensible display/text split (Instrument
Serif + DM Sans), so they are the least broken. The decision there is whether the
family standardises on Fraunces + Inter or on their pair. Pick one and apply it
everywhere; the current state, where the org landing page and its own products
use different faces, is the thing that reads as unfinished.

## What was already right, and stays

Not everything needed fixing, and the tempting mistake is to redesign what works:

- **The palettes.** heartwood's warm near-black and amber is specific and good.
  Every token except the muted one was already AAA.
- **The heroes.** Fraunces at 80px with a single accent word is genuinely strong.
- **Brand marks.** heartwood's pixel cat and cambium's tree cross-section are the
  best assets in the family. Both are hand-made and neither needed touching.
- **The spec-row pattern.** Two-column `dt`/`dd` with hairline rules works.
- **The growth-ring background texture.** Atmosphere at almost no cost.

## Still open

- **Imagery.** cambium, sapwood and bray ship zero images; heartwood is a physical
  device with no photograph of it anywhere. See Imagery below for how to produce
  them safely — the tooling exists, the pictures do not yet.
- **Layout rhythm.** Every section is head → body → spec rows → aside. The
  typography now varies; the structure still doesn't.
- **bray's length.** 2,700 lines, 16 feature cards, a 251-tool inventory. Editing
  it down would improve how it looks more than styling it would.

## Imagery

The biggest remaining gap, and the one typography cannot close. Two sources.

### Captured from the real apps

Real UI beats generated art on a product site, and three of these products are
things we can actually drive. The risk is obvious: a signer's console is exactly
where key material lives, and a leaked `nsec` in a marketing PNG is unrecoverable.

`tools/shotguard.mjs` is the control. It does **not** work by inspecting the PNG
afterwards — OCR is unreliable and one miss is permanent. Instead:

1. the app is driven in a **fresh browser context**, so none of the operator's
   real localStorage, IndexedDB or cookies is ever loaded;
2. state is injected as deliberately synthetic fixtures (`deadbeef…`, `cafebabe…`)
   through each app's existing production-inert test seam;
3. the rendered DOM text **and every attribute** is scanned before the shutter;
4. any hit aborts the capture and no file is written.

It fails closed. A 64-hex pubkey and a 64-hex private key are the same shape, so
every one is blocked unless explicitly passed through `allow` — which is how the
known-synthetic fixtures get past. It also carries the OPSEC list: real name,
private repo names, local filesystem paths, private hosts.

`tools/shotguard.test.mjs` proves it, with 17 cases covering nsec, ncryptsec,
pairing secrets, bare 64-hex, API keys, GitHub tokens, labelled PINs and seed
phrases, and the identity list — plus the cases that must *pass*: npubs, public
relay URLs, short git shas, and an allowlisted pubkey. Run it before trusting a
capture run.

`tools/captures/sapwood.mjs` is the worked example: it drives sapwood's
`__sapwoodConnect` seam into the connected-console state with three fake paired
apps and captures Home and Advanced. Fixtures must match `src/lib/types.ts`
exactly — `ConnectSlot` keys on `slot_index`, and duplicate keys silently collapse
the list.

Runnable today: **sapwood** (Vite preview + test seam), **bark** (extension pages).
Not runnable here: **cambium** (Android) and **heartwood** (physical device) —
those need a device on the bench, and heartwood's OLED animations are already
captured as gifs.

### Generated

For atmosphere where there is nothing to photograph — a hero ground, a texture, a
conceptual illustration. Two rules: never generate a fake *screenshot* of a real
product (it becomes a lie the moment the UI changes), and keep generated imagery
abstract enough that it does not imply hardware we do not ship.

heartwood is the exception that wants a real photograph rather than either: it is
a physical object on a desk, and no generated image should pretend to be one.
