# @animus-labs/brand

Shared Cortex brand tokens. Pure data, no framework. See `docs/brand-vision.md`.

- `colors` palette (carbon, moss, bone, acid, amber, cinnabar)
- `fonts` and `googleFontsHref` (DM Mono, DM Sans)
- `flapAlphabet`, `flapTiming` split-flap primitives
- `honestStates`, `thinkingWords`, `thinkingSignature`
- `themeCss()` CSS custom properties for the web

The website and the TUI both read from here so the two stay in sync. This holds
the *what* (the data); each surface owns the *how* (its own rendering).
