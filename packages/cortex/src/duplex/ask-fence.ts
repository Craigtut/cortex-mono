/**
 * The ask-fence containment boundary (communication.md, decisions.md D16).
 *
 * A voiced permission ask wraps untrusted request text between fence
 * markers stamped with the ask's nonce (see buildAskVoicing in prompts.ts).
 * The fence holds only while the nonce stays away from whoever authored the
 * content inside it: knowing it, model-authored command text can close the
 * fence early and continue in text that reads as Cortex's own framing.
 *
 * The talker legitimately knows the nonce, because it has to call
 * answer_ask with it. So every channel carrying talker-authored text toward
 * the reasoner is a leak path, and each one sanitizes through here. Two
 * exist today (the buffered talker reply and the answer_ask reason); a
 * third would have to call this too, which is why the implementation is
 * here rather than inline at either site.
 *
 * This is defense in depth, not the consent boundary. D16 is enforced
 * router-side and holds whether or not a nonce leaks: a leaked nonce buys
 * an attacker influence over what the talker says, never a granted ask.
 */

/**
 * The fence tag name. Declared here rather than in prompts.ts so the
 * builder and the stripper cannot disagree about what a marker looks like:
 * a format change that reached only one of them would leave a fence that
 * still renders and no longer contains.
 */
export const PERMISSION_REQUEST_TAG = 'permission-request';

/** Stands in for a removed marker or fenced construct. */
export const ASK_FENCE_PLACEHOLDER = '[permission request omitted]';

/** Stands in for a removed ask nonce. */
export const ASK_ID_PLACEHOLDER = '[ask id omitted]';

// A complete marker in either direction: `<permission-request ask="x">` or
// `</permission-request ask="x">`, tolerant of whitespace, attribute
// quoting, and case, because the talker retypes these from its own context
// rather than echoing bytes.
const OPEN_MARKER = `<\\s*${PERMISSION_REQUEST_TAG}\\b[^>]*>`;
const CLOSE_MARKER = `<\\s*\\/\\s*${PERMISSION_REQUEST_TAG}\\b[^>]*>`;

/** A whole fenced construct, markers and everything between them. */
const PAIRED_RE = new RegExp(`${OPEN_MARKER}[\\s\\S]*?${CLOSE_MARKER}`, 'gi');
/** A complete marker with no partner. */
const LONE_RE = new RegExp(`${OPEN_MARKER}|${CLOSE_MARKER}`, 'gi');
/**
 * An unterminated marker: `<permission-request ask="x` with the `>` never
 * typed. Only the tag token is removed, not the rest of the line, so a
 * truncated marker cannot be used to make the stripper eat real content.
 * The nonce it was carrying is caught by {@link ASK_ID_RE} instead.
 */
const PARTIAL_RE = new RegExp(`<\\s*\\/?\\s*${PERMISSION_REQUEST_TAG}\\b`, 'gi');

/**
 * An ask nonce anywhere in the text, marker or not. Ask ids are minted as
 * `ask-<uuid>` on both paths (the loop's resolver call and the broker's
 * network asks), and the voicing instructs the talker to call answer_ask
 * with that id in plain prose, so a chatty talker leaks the nonce with no
 * marker involved. That path is not hypothetical: it is the same string in
 * the same message.
 *
 * The `ask-` prefix is required. A bare uuid is not redacted, because a
 * user can legitimately be talking about one in their own data and the
 * reasoner would need to see it.
 */
const ASK_ID_RE = /\bask-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Cheap pre-filter: the tag name or an `ask-` token. Every branch below
 * needs one of the two, so text with neither is returned as-is without
 * running four regexes over it. Deliberately not global: a global regex
 * carries lastIndex across .test() calls and would skip every other hit.
 */
const MAY_CONTAIN_RE = new RegExp(`${PERMISSION_REQUEST_TAG}|\\bask-`, 'i');

/**
 * Remove ask-fence markers and ask nonces from talker-authored text bound
 * for the reasoner.
 *
 * A whole fenced construct is replaced, contents included, rather than
 * being unwrapped. Unwrapping would keep whatever sat inside, and inside a
 * fabricated fence that is precisely the payload; inside a real one it is
 * the rendered request, which the reasoner authored and already has. So
 * dropping it costs the reasoner nothing and denies the attacker the
 * laundering step.
 *
 * Text with no marker and no nonce is returned unchanged. Angle brackets on
 * their own are left alone: only this exact tag name matches, so a talker
 * quoting a user's `a < b` or a snippet of HTML is not touched.
 */
export function stripAskFence(text: string): string {
  if (text.length === 0) return text;
  if (!MAY_CONTAIN_RE.test(text)) return text;
  return text
    .replace(PAIRED_RE, ASK_FENCE_PLACEHOLDER)
    .replace(LONE_RE, ASK_FENCE_PLACEHOLDER)
    .replace(PARTIAL_RE, ASK_FENCE_PLACEHOLDER)
    .replace(ASK_ID_RE, ASK_ID_PLACEHOLDER);
}
