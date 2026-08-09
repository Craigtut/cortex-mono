# Documentation example typechecking

Compiles the TypeScript examples **in** `docs/cortex/consumer-guide.md` against
the real Cortex source, so an example that names a method the facade does not
have fails a check instead of shipping.

```bash
node tools/docs-examples/check.mjs
```

The artifact under test is the document. The extractor reads the fenced blocks
out of the markdown at run time; nothing here is a copy of them. That is the
whole point: a harness holding its own copy of the examples goes green against
code nobody reads the moment someone edits the doc and not the copy.

## How a block opts out

Blocks are checked when the fence language is `typescript`. A block that is not
meant to compile opts out **in the markdown**, in the fence info string, with a
reason:

~~~markdown
```typescript skip="illustrative fragment, not a runnable call"
someShape = { ... }
```
~~~

The first info-string word is still `typescript`, so the block renders and
highlights normally. The opt-out lives next to the block it applies to, which
means a reader of the doc can see which examples are checked, and the reason
cannot drift away from the code the way an exclusion list inside a tool does.

An empty or missing reason (`skip`, `skip=""`) is an error. Opting out is
allowed; opting out silently is not.

## The preamble

Examples reference application-side things Cortex does not provide:
`credentialStore`, `workingDirectory`, a `saveSession` function. Those are
declared in `preamble.ts` with **real types**.

Do not widen a preamble type to make an example compile. A stub typed `any`
turns the harness green against an example that would not work for a reader,
which is the same failure the harness exists to catch, moved somewhere harder
to see. If an example cannot compile against an honest type, that is a finding
about the example.

## Failure modes it treats as errors

- No `typescript` blocks found at all (the doc moved, was renamed, or the fence
  style changed), rather than passing vacuously over zero inputs.
- A checked block that contains no statements once imports are hoisted.
- A `skip` with no reason.
- An import form the merger does not understand, rather than dropping it.
