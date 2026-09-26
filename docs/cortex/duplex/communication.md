# Communication: Control Tools, Headlines, Wake Policy, Permission Brokering

> **STATUS: IMPLEMENTED AND DEFAULT.** Built across phases 0 through 2b-ii on the `duplex-restructure` branch and validated in Phase 3. Duplex is the default mode (D14); `mode: 'passthrough'` is the opt-out. See migration-plan.md for the honest boundary of what the test suite can see, and consumer-guide.md for what changes on upgrade.

The down-channel is a fixed set of fire-and-forget control tools on the talker; the up-channel is log routing. Neither direction ever blocks a loop on another loop.

## Down-Channel: Control Tools

The talker delegates through five control tools (decisions.md D8, which records the reversal from an earlier in-band-tags design). Each executes locally in under a millisecond (a dispatch into the facade router) and returns `terminate: true`, which pi-agent-core honors by skipping the automatic follow-up LLM call, so delegation costs zero extra rounds. The talker speaks its acknowledgment in the same turn, before the tool call, and the turn ends when the dispatch lands.

Control toolset (initial):

| Tool | Arguments | Facade action |
|---|---|---|
| `spawn_task` | `{ instructions }` | deliver new work to the reasoner |
| `steer_task` | `{ taskAlias?, message }` | deliver a redirect to the reasoner (always; no fast-path, D20); a live reasoner run takes it at its next turn boundary |
| `cancel_task` | `{ taskAlias }` | mark the task cancelled and tell the reasoner; stop the live reasoner run if it serves only cancelled work, otherwise steer the stop into it at its next turn boundary |
| `answer_ask` | `{ decision: 'allow' \| 'deny', reason? }` | settle the ask read out to the user, subject to the consent rules in D16 (no id: an answer binds to the one voiced ask) |
| `quick_lookup` | `{ question }` | spawn a read-only ephemeral sub-agent |

Task references use short human-friendly aliases surfaced in the headline block, not the underlying UUIDs, so a fast-tier model is never asked to reproduce a UUID exactly.

Result contract (D17): every call returns `{content: [...], terminate: true}` regardless of outcome. Control tools never throw and never return `isError`, because pi's error results omit `terminate` and would reopen the talker's loop. A bare string return silently loses `terminate` through the result-wrapping path, so the shape is asserted in tests by checking that the batch terminates, not by checking the return value.

Design properties:

- **Zero extra round trips.** `terminate: true` on every control-tool result skips the follow-up call; the loop honors this today (`agent-loop.ts` `shouldTerminateToolBatch`).
- **Pointer, not paraphrase.** The reasoner receives the conversation deltas anyway (log routing), so tool arguments do not need to restate the user's request accurately; the reasoner reads the user's own words.
- **Injection-resistant by construction.** Untrusted text in the talker's context (tool output in deliveries, stdout in headlines, file contents in lookup results, users quoting syntax) cannot invoke a tool by being echoed; invocation requires a deliberate structured call, and an `answer_ask` binds only to the ask actually read out.
- **Standard machinery.** Schema validation, argument coercion, and structured retryable errors come from the existing tool path; there is no bespoke parser to build or maintain.
- **Precedent.** Every production system at the API layer uses tool calls for the fast loop's control surface: OpenAI Realtime async function calling, Gemini Live `NON_BLOCKING` functions, LiveKit's auto-exposed `get_running_tasks`/`cancel_task`, Pipecat, ElevenLabs. AsyncFC formalizes the fire-and-forget contract.

Working tags remain in use on the talker for their original purpose only: separating internal reasoning from spoken text.

## Up-Channel: Headlines and Deliveries

Two speeds, mapped to the two context channels (log-and-context.md):

**Headlines** (continuous): the facade maintains a compact status block per active loop and running sub-agent: alias, state, current tool, duration, turns, token spend, last output lines, and an `as_of` timestamp so staleness is a number rather than a vibe. Sourced from event-bridge forwarding (enabled for background children in P0; today they are event-invisible, which makes the existing `Current:` surface dead code). View-injected into the talker every turn, outside BP3, hard token cap with truncation. Interpolated values are escaped, since task instructions and stdout tails reach this block verbatim. The talker answers "how's it going" from here, with honest staleness ("as of about a minute ago, it was running the test suite").

**Deliveries** (discrete): the reasoner emits a delivery through a `Deliver` tool, `{content, wake}`, symmetric with the talker's control tools. Content is plain text with no schema (decisions.md D9); `wake` proposes a class the router may demote. A reasoner run that ends without delivering a result through `Deliver` produces an implicit `when_idle` delivery from its final assistant text, so results always surface even if the model forgets the tool. A `silent` delivery is a progress note, not a result: it neither suppresses the implicit delivery nor retires the delegation it belongs to. The talker decides phrasing; grounding rules forbid inventing anything beyond the delivered content.

A liveness watchdog in the duplex session synthesizes periodic `when_idle` progress deliveries when a reasoner run has produced nothing for an extended period, so a working reasoner is distinguishable from a hung one. When the run is blocked on a pending permission ask, the progress delivery says it is waiting for the user's answer rather than reporting no update.

**Failures.** A reasoner run that dies produces a delivery too, because otherwise the headline block still lists the delegation as live and the grounding rules have the talker honestly report "still working on it" for as long as the retry ladder runs, which on the default policy is hours. The split matters: **retrying is a headline fact, giving up is a delivery fact.** A retry in progress belongs in the status block, where it is churn that updates and expires; only an exhausted ladder or a terminal failure earns a delivery. Announcing mid-ladder hands the talker two contradictory facts about one event, and the delivery is the louder one.

The boundary is the reasoner's own run. A sub-agent failure is not delivered by the facade; it reaches the reasoner through the background drain, which hands it the failed result and starts a run it can speak from. The reasoner is the right narrator there, because it knows what the failure means for the task in hand, and a facade-level delivery would bypass that judgment and race whatever the reasoner says a moment later. Two producers for one event, with the less informed one arriving first, is the defect this rule exists to avoid.

## Wake Policy

Adopted vocabulary from Gemini Live's result scheduling (decisions.md D10). Every delivery and ask carries a wake class:

| Class | Behavior |
|---|---|
| `interrupt` | deliver at the next gate release, ahead of queued input. Not "abort the in-flight turn": turn abortion is reserved for barge-in |
| `when_idle` | hold until the consumer-supplied idle signal reports a lull, then deliver |
| `silent` | queue without waking; the content is present at the loop's next natural turn |

The producer proposes a class and the router may demote it (D19). The idle signal is advisory: the facade enforces its own minimum inter-delivery spacing regardless, so an always-idle signal cannot collapse the dampening properties.

**Permission asks have their own lane.** They are `interrupt` class, so under the shipped backpressure defaults a chatty reasoner that burns the interrupt token bucket could push an ask up to the degrade delay behind, while the loop that raised it blocks the whole time. Backpressure exists to stop a reasoner monopolizing the conversation, not to delay the one message that has a human waiting on the other side of it.

As built: voicings bypass the bucket, content dedup, the spacing hold, and both queues entirely, rather than holding a reserved token. They do stamp the spacing clock, so queued ordinary deliveries hold off one window behind a fresh ask instead of talking over it, and re-voicing is damped to one delivery per ask per couple of seconds so a spraying turn cannot flood the voice channel while the ask stays answerable throughout.

**Everything delivered is fenced, on both surfaces.** Reasoner deliveries and lookup results were wrapped from the start; consumer `deliver()` content was not, which left it sitting unfenced beside a role prompt whose injection rules key on the wrapper, implicitly marking wrapped content as the untrusted kind and everything else as safe. Consumers routinely relay third-party text (an email body, a webhook payload, a support ticket), so that default handed an attacker a direct line to the instruction channel. `prompt()` stays unwrapped because it is the user speaking; everything delivered is content *about* something and gets fenced.

Consumer-relayed content uses a distinct `<external-update>` label rather than the `<background-update>` used for the reasoner's own work. The labels carry different claims: background-update asserts "your own work reported this", and the talker's grounding rules bind it to delivered work, so labelling a relayed email that way would let it be attributed to work in progress, which is the hallucination this design exists to prevent.

The `work` surface is fenced too, which is less obvious. A dispatch is a directive channel by design, so the instinct is to leave it bare, but the reasoner holds every tool: a consumer relaying a support ticket there means "handle this", not "obey this". The directive framing lives outside the fence and the payload inside it, so the dispatch still says handle-this while the relayed text gains no authority by addressing the reasoner, claiming to be the user, or claiming an approval was already given.

The verbatim request is fenced with a nonce, so content inside it cannot close the fence and escape the quotation. What makes that hold is that the nonce is CSPRNG-random and never exposed to whoever authored the content: it is not derivable, and a re-voice reuses the same id rather than minting a guessable successor. It is emphatically *not* mint-ordering, which an earlier draft of this document claimed and which is not even true of the code. Ordering is the kind of rationale that survives a refactor while the property it described quietly does not.

**Non-exposure is structural: nothing ever asks the talker to reproduce the nonce.** It appears in exactly one place the talker can see, the two marker lines wrapping the request, and nowhere it is invited to repeat. The voicing prose does not name it, the per-turn headline block does not render it, `answer_ask` has no `askId` parameter, and the talker role prompt never mentions an ask id. So a hostile talker has nothing to work with beyond the markers themselves, and a careless one has nothing to narrate.

That is the fix for what a filter cannot reach. The prose used to say "call answer_ask with askId ...", which handed over the fence key in the form most likely to come back out, and a talker paraphrasing it (spelling it out, splitting it, re-encoding it) would defeat any string filter. Nothing needed it: an answer binds to the voiced ask, exactly one ask is voiced at a time, and the router refuses an allow for anything else, so an id could never make an accepted answer possible that a bare answer would not. Asking a fast-tier model to reproduce a UUID was cost with no authority attached, which is the same reason tasks carry friendly aliases.

Denying a *specific queued* ask went with the parameter, and nothing legitimate needed that either: a user can only answer a request they have heard, each queued ask is re-voiced as its predecessor settles, unanswered ones time out to deny, and "stop everything" is `abort()`, which denies them all. The broker still implements answering by id, so D16's "deny is unrestricted" is unchanged at the layer that enforces it; what is gone is the talker's ability to address an ask the user was never read.

**The strip is the second line of defense**, against a talker that quotes the markers rather than one that repeats an id. `src/duplex/ask-fence.ts` owns both halves of the boundary: the tag name the voicing builds with, and `stripAskFence`, which every talker-authored string bound for the reasoner runs through. A whole fenced construct is removed with its contents, because inside a fabricated fence that is the payload and inside a real one it is the rendered request the reasoner authored and already has.

**What the strip covers.** Complete markers in either direction, unpaired markers, and truncated markers with the `>` never typed, in any case and with any attribute quoting. Whole fenced constructs including their contents, nesting included. And any `ask-<uuid>` token anywhere in the text, marker or not. Three channels run through it today: the `answer_ask` reason (stripped at intake, so the log entry and the resolver's block reason get the same sanitized string), and `spawn_task` instructions and `steer_task` messages (stripped in their directive builders, which is where talker text becomes reasoner-bound text). A fourth, the spoken reply buffered into `<conversation-context>` via `noteTalkerReply`, is the one channel still unstripped: the strip belongs at the facade's `onTurnComplete` call site and lands with that one-line change.

**What it does not cover.** Bare uuids with no `ask-` prefix are deliberately left alone, because a user can be talking about one in their own data and mangling it would cost the reasoner real information. And the strip is per-channel by construction: a new talker-to-reasoner channel that forgets to call it reopens that path, which is why the tag and the stripper live in one module instead of at the call sites. Neither gap reaches the nonce now that nothing shows it to the talker outside the markers, which is the point of doing both.

Even with a leaked nonce, D16 still holds and consent cannot be forged: what a closed fence buys an attacker is influence over what the talker says, not authority to approve. That is why this was a should-fix rather than a blocker. Sandbox escalation is voiced with the actual command and explicit no-containment language rather than the synthetic `Bash(escalate)` name, and carries no default timeout: auto-denying an escalation leaves the command running contained and failing, which invites a retry loop. Ordinary tool asks time out to deny.

Defaults per entry type: milestones `silent`, final results `when_idle`, permission asks `interrupt`, conversation deltas to the reasoner `silent` (D18). Without a consumer idle signal, `when_idle` degrades to `interrupt` after a configurable delay; the same delay bounds the case where a signal exists but never reports a lull.

Stale results are never dropped (the Nova 2 Sonic position): a delivery that arrives after the user changed direction still enters the log and the talker's context; the talker reconciles conversationally. Explicit `cancel_task` is the only discard path: a delivery whose causation is entirely cancelled work (the cancelled task's own directives, including the cancel itself) is not delivered, and is recorded as a `delivery_dropped_cancelled` lifecycle entry carrying the withheld content. A delivery from a run that also served live work is delivered as usual.

A cancel stops work, not just its reporting. When every cause tag of the reasoner's live run belongs to a cancelled task, the facade aborts that run (logged as `cancelled_run_stopped`) and delivers the cancel directive once the abort completes, so the reasoner can clean up anything the task left running; dispatches issued during that abort wait for it rather than being cancelled with the run. The facade declines the abort when other content is parked behind the run, since aborting would drop it, and steers the stop in instead.

## Permission Brokering

Today a permission ask blocks the asking loop while the consumer's `resolvePermission` callback decides. In duplex, asks flow through the conversation:

```
sub-agent hits ask-gated tool
  -> resolver wrapper creates ask entry
       {askId (nonce), loopPath, toolName, renderedRequest, voiced: false}   (log, wake: interrupt)
  -> broker voices it (one at a time) and the talker reads it out
  -> user answers in speech/text
  -> talker calls answer_ask({decision, reason}), bound to the voiced ask
  -> broker checks the D16 consent rules
  -> facade settles the pending resolver promise
  -> asking loop proceeds or receives the block
```

Required mechanics:

- **Ask identity.** The current resolver signature `(toolName, args)` is anonymous; with N loops the consumer cannot attribute or correlate. The wrapper adds `{askId, loopPath}` context (P1 loop-identity work).
- **Consent binding.** See D16. One ask voiced at a time; `allow` only for the most-recently-voiced ask, only once, only with a user utterance timestamped after the voicing. Enforced in the broker (`duplex/ask-consent.ts`), never by prompt.
- **Verbatim payload.** Ask entries carry `renderedRequest`: the tool name plus the actual command or path, truncated but never summarized. Without it the talker sees only a tool name (and for sandbox escalation, only the synthetic `Bash(escalate)`), which forces vague voicing regardless of model behavior. Destructive-verb and escalation asks are read verbatim.

  Truncation is head-and-tail, never head-only. A long command's payload usually sits at the end (`…&& rm -rf ~/work`), so dropping the tail lets a hostile or merely verbose command hide behind a wall of leading path while still reading as benign to the human approving it by voice.
- **Full coverage.** `resolveNetworkAccess` and the sandbox provider's ask callback have the same blocking shape and route through the same broker; previously they bypassed it entirely and would have blocked a loop invisibly.
- **Abort-race.** pi awaits `beforeToolCall` before checking the abort signal, so a pending ask currently hangs abort/destroy into the 8-second force-kill path. The Cortex wrapper races the consumer's decision against the loop's abort signal and returns a block on abort (P0; no pi change). The resolver context receives an abort signal so a consumer UI can dismiss a moot prompt.
- **Timeout.** Asks carry an optional timeout with a configurable default resolution (deny with reason). Escalation-class asks get a longer or absent default, since auto-denying an escalation leaves the command running contained and failing, which invites a retry loop.

The talker itself must never enter `beforeToolCall`: Cortex installs it whenever `resolvePermission` is configured, so wiring the broker as the talker's resolver would deadlock `answer_ask` against the ask it is answering. Both defenses are in place and asserted in tests: the talker is constructed without a resolver, AND every internal orchestration tool carries `permissionExempt` on the tool contract, which the gate honors before consulting any resolver.

**Internal tools are never consumer-gated.** Cortex's own orchestration tools are in-process dispatches with no side effect a consumer could meaningfully gate: `Deliver`, `SteerSubAgent`, the five control tools, `SubAgent`, `recall`, `load_skill`, `ToolSearch`. Each carries `permissionExempt: true`; `beforeToolCall` checks the flag on the loop's REGISTERED tool (never on the call, and MCP wrappers are refused, so a remote server cannot self-exempt by declaring the field) and skips the resolver. Before this classification existed, a reasoner's `Deliver` was routed to the consumer resolver and surfaced as a permission dialog, blocking delivery of the very answer the user was waiting on. Consumers may set the flag on their own equally-internal tools; anything touching files, network, or processes must not carry it.

In passthrough mode the broker is bypassed and `resolvePermission` behaves exactly as today.
