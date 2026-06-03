# Cortex Brand Vision

The shared brand for Cortex and Cortex Code. One brand, two marks: the same palette, type, motif, and voice, with marks that tell the harness and the product apart.

## What Cortex is

Cortex is the harness around the model: tools, permissions, compaction, memory. Infrastructure that other things run on. The brand is not a personality bolted onto a chatbot. It is the voice of a well-built instrument and its readout.

## Positioning: the instrument

The room as it stands:

- **Claude Code** is the colleague. Warm, human, a little corporate. It works to feel like a person.
- **Codex** is the corporate utility. Clean, neutral, black and white. It works to feel like nothing.

Both apologize for being a machine. One hides it behind warmth, the other behind minimalism.

Cortex refuses to apologize. It is an instrument: a precise, well-built machine for people who like machines. It does not perform friendliness and it does not perform neutrality. It states what it is doing, then stops. That posture is the whole rebellion, and it never shows up as attitude in the copy. The terseness does the work.

Reference points: Dieter Rams and Braun, Teenage Engineering, Panic and Playdate, Nothing, Solari departure boards, Eurorack, old Tektronix and HP bench gear.

## The feeling: precision that feels alive

The magic is not exposed guts. It is a sealed, well-built machine whose life shows in its motion. You see a clean, precisely labeled surface. It feels alive when it moves. You never see the motor. You see the flaps settle, and that is the magic.

The name carries this. Cortex is the thinking layer. The brand renders thought as a machine. Flaps clatter the way neurons fire. The board settles when the thought arrives.

## Motif: the split-flap board

The split-flap (Solari) board is the unifying grammar. Everything inherits from it.

- **Characters in cells.** Monospace grid. Layout, spacing, and icons snap to a cell.
- **The logo is one frame of the board.** The wordmark resolves the way a board settles into place.
- **The mark is the spinner.** When Cortex thinks, the glyph flips. Thinking gets motion, and eventually sound.
- **Resolving, not departing.** The board's gift is not travel. It is state resolving in real time. Cells scramble, then settle. `resolving` becomes `resolved`. Cognition arriving.
- **The readout is the voice.** See below.

## Color

Warm green-black base, warm cream type, acid as the spark. The neutrals are what keep the green from reading neon. Lime on warm carbon reads intentional and analog. Lime on pure black reads hacker terminal. Keep the green rare.

| Role | Name | Hex | Use |
| --- | --- | --- | --- |
| Base and flaps | Carbon | `#070906` | dark green-black, roughly 80% of every surface |
| Panel | Moss | `#13200F` | cards, code blocks, lift off carbon |
| Type | Bone | `#F2EBD6` | the workhorse, most of the text |
| Primary spark | Acid | `#B8E23E` | success, resolved, the lit cell, the cursor. about 5% of pixels |
| Secondary signal | Amber | `#E5AC51` | running, warning, secondary highlights |
| Flag | Cinnabar | `#D8553F` | errors only, almost never |

Ratio: roughly 80% carbon, bone where it carries, acid on about 5% of pixels. Acid is primary and rare. Amber is the second tone that flags the rows that need your eye, the way a real board uses a warm secondary. It is a muted gold so it sits beside acid without fighting it. Cinnabar flags errors and is used almost never.

### Scope: brand palette vs reading colors

This palette governs brand surfaces: the site, the logo, marketing, and the branded top section of the TUI. It is not the palette for syntax highlighting or inline text emphasis inside the TUI. Those need more muted, legible tones, tuned for long reading and for sitting under the user's own theme. That is a separate exercise.

## Type

- **DM Mono** carries mechanism: the wordmark, status lines, the board, logs, anything that lives in a cell.
- **DM Sans** carries prose: docs, README, UI labels, landing body.

Two faces, two registers. When Cortex narrates the machine, mono. When it explains itself to a person, sans.

## Cortex and Cortex Code

Cortex and Cortex Code share one brand: the same palette, type, motif, and voice. They differ only in their marks, and the difference carries meaning.

- **Cortex** is the harness. A general-purpose agent framework, with nothing specific to code. Its wordmark is plain: `cortex`, lowercase, DM Mono. Calm and foundational. Descriptor: `Cortex // agent harness`.
- **Cortex Code** is the product. A coding agent built on the harness. Its wordmark adds the code and terminal signifiers: `‹cortex›_`. The brackets read as code, the trailing `_` is the cursor. The logo never spells out "Cortex Code." It is just `‹cortex›_`. Descriptor: `Cortex Code // coding agent`.

The signifiers earn their place only on Code. Brackets and a cursor mean nothing on a generic harness, so the harness goes without them. Said plainly: Cortex Code is Cortex with a cursor.

## Logo system

- **Cortex wordmark.** `cortex`, lowercase, DM Mono. The harness, unadorned.
- **Cortex Code wordmark.** `‹cortex›_`, DM Mono. The harness pointed at a terminal.
- **The glyph.** The diamond. It reads three ways: `<>` (code), a cut gem (instrument), and a split-flap card (the vertical seam is the flip line). It is Cortex Code's icon, favicon, and thinking spinner, and the family mark whenever an icon is needed.

Two rules: a wordmark and the glyph are never combined into one lockup, and the bracket motif never appears twice. Keep a hair of a gap at the glyph's seam so it reads as two cards meeting, a flip line, not a drawn line.

## Voice

One line: **Cortex talks like a precision instrument's readout. It names the mechanism, states the fact, and stops.**

Cortex is a harness, not a character, so its voice is the voice of documentation and system output, not a chatbot persona. The most on-brand thing infrastructure can do is refuse to pretend it is your friend.

### Principles

1. **Name the mechanism.** Use honest mechanical and cognitive words for what it is doing: observing, reflecting, compacting, resolving. The codebase already speaks this way (observer, reflector, buffer, slots, budget guards). That vocabulary is the brand language.
2. **Clean surface, hidden gore.** Name the states. Never dump the wiring. No log exhaust, no stack-trace noise, no token-by-token narration. The surface stays calm.
3. **Terse and load-bearing.** No filler. No "just," no "simply," no "go ahead and." Man-page density. If a word is not carrying weight, cut it.
4. **Declarative, present tense, readout style.** State facts as they happen, like an instrument panel. Do not narrate feelings.
5. **Confident, never cute, never apologetic.** No emoji in system output. No exclamation points. No "oops." Warmth comes from precision, not tone. Confidence in simplicity, not volume. Never overstate.
6. **A little alive.** Dry, mechanical whimsy, deadpan. The whimsy lives in two places only: the motion, and the labels. A well-made machine is allowed one wink and keeps a straight face while doing it.

### Two registers, same voice

- **Machine readout** (DM Mono, lowercase, data):
  - `observer · running`
  - `context resolved · 142k -> 38k`
  - `budget · 12k remaining`
- **Documentation prose** (DM Sans, sentences, no hype):
  - "When context nears the budget, the observer records the turn and the reflector compacts it. You set the thresholds. The machine does the rest."

### Thinking words

The gerund cycle runs in two layers, so Cortex can be charming without ever lying about the mechanism.

- **Honest states**, shown when the real machine is working: `observing`, `reflecting`, `compacting`, `resolving`.
- **Whimsy fillers**, cycled while the model is just thinking. Sourced from Cortex Code's spinner and kept in `packages/brand` as the single source: `Thinking`, `Musing`, `Brewing`, `Doodling`, `Bubbling`, `Rummaging`, `Woolgathering`, `Waffling`, `Larking`, `Slurping`, `Fizzing`, `Dawdling`, `Whittling`, `Burbling`, `Gallivanting`, `Unfurling`, `Steeping`, `Fermenting`, `Sauntering`, `Oscillating`, `Kindling`, `Humming`, `Sifting`, `Weaving`, `Ambling`, `Roving`, `Stirring`, `Gleaning`, `Idling`, `Lilting`.
- **House signature**: `consulting the cortex`.

Rules: lowercase, present participle, DM Mono, deadpan. When something real is happening, name it honestly. When it is just thinking, it can be charming.

### Do and do not

| Do not | Do |
| --- | --- |
| `Thinking...` with sparkles | `observing` |
| `Oops! Something went wrong, please try again.` | `tool call failed · Bash exited 127 · command not found: rg` |
| "Cortex is a friendly, powerful framework that helps you build amazing agents with ease." | "Cortex is the harness around the model: tools, permissions, compaction, memory. The parts an agent needs that the core leaves out." |
| "I'll go ahead and try to compact the context for you now." | `compacting context` |

## Naming (Braun-core labeling)

Name parts, states, and product categories with precise, evocative, deadpan labels. Components have agency: the observer records, the reflector compacts. Invented product names and categories are welcome when they are precise and said with a straight face. The label is the design flair.

## Descriptor, not slogan

No tagline. Lead with the category, treated as seriously as a product name:

> `Cortex // agent harness`

The design and the product names carry the feeling. Confidence in simplicity, not volume.

## What we never do

- em dashes (use commas, colons, parentheses, or separate sentences)
- exclamation points
- emoji in system output
- hype words (amazing, powerful, effortless, blazing, magical as an adjective)
- apologies (oops, sorry, uh oh)
- cute for the sake of cute
- overstating anything
