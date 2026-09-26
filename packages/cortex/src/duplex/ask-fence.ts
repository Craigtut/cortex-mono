/**
 * The ask-fence containment boundary (communication.md, decisions.md D16).
 *
 * A voiced permission ask wraps untrusted request text between fence
 * markers stamped with the ask's nonce (see buildAskVoicing in prompts.ts).
 * The fence holds only while the nonce stays away from whoever authored the
 * content inside it: knowing it, model-authored command text can close the
 * fence early and continue in text that reads as Cortex's own framing.
 *
 * The talker necessarily sees the nonce: it is stamped on the fence markers
 * of every voicing the talker reads out (answer_ask itself takes no id, so
 * the talker is never invited to repeat it). So every channel carrying
 * talker-authored text toward the reasoner is a leak path, and each one
 * sanitizes through here. Two exist today (the buffered talker reply and
 * the answer_ask reason); a third would have to call this too, which is why
 * the implementation is here rather than inline at either site.
 *
 * This is defense in depth, not the consent boundary. D16 is enforced
 * by the broker and holds whether or not a nonce leaks: a leaked nonce buys
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

/**
 * The attribute region of a marker: zero or more `name="value"` pairs, with
 * the value quoted either way or bare.
 *
 * Deliberately not `[^>]*`, which is the obvious spelling and is wrong. It
 * treats everything up to the next `>` ANYWHERE in the text as the inside
 * of a tag, so `I saw <permission-request in the log. Use x => y?` reads as
 * one enormous marker and the strip eats the sentence. A `>` after a
 * truncated marker is not exotic in a coding session: `=>`, `->`, a JSX
 * tag, a diff line, or a quoted comparison all supply one. Matching actual
 * attribute syntax means prose cannot be mistaken for a tag body, so a
 * truncated marker falls through to {@link PARTIAL_RE}, which removes the
 * tag token alone and leaves the sentence standing.
 *
 * It also fixes the quoted-`>` case for free: `ask="a>b"` is one attribute
 * here, where the old pattern ended the tag inside the quotes.
 */
const ATTRIBUTES = `(?:\\s+[A-Za-z_:][\\w.:-]*\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))*\\s*`;

// A complete marker in either direction: `<permission-request ask="x">` or
// `</permission-request ask="x">`, tolerant of whitespace, attribute
// quoting, and case, because the talker retypes these from its own context
// rather than echoing bytes.
const OPEN_MARKER = `<\\s*${PERMISSION_REQUEST_TAG}\\b${ATTRIBUTES}\\/?>`;
const CLOSE_MARKER = `<\\s*\\/\\s*${PERMISSION_REQUEST_TAG}\\b${ATTRIBUTES}>`;

/** A whole fenced construct, markers and everything between them. */
const PAIRED_RE = new RegExp(`${OPEN_MARKER}[\\s\\S]*?${CLOSE_MARKER}`, 'gi');
/** A complete marker with no partner. */
const LONE_RE = new RegExp(`${OPEN_MARKER}|${CLOSE_MARKER}`, 'gi');
/**
 * Anything tag-shaped the two above did not take: an unterminated marker
 * (`<permission-request ask="x` with the `>` never typed) or one whose
 * attribute region is not attribute-shaped. It matches the tag token and
 * nothing else, and whatever the tag was carrying stays put; the nonce in
 * it is caught by {@link ASK_ID_RE}, which is why matching less costs
 * nothing.
 *
 * **This regex being narrow is not what keeps the stripper from eating
 * prose.** That property belongs to {@link ATTRIBUTES}, and saying it here
 * is how the bug it describes stayed hidden: an earlier version of this
 * comment claimed "a truncated marker cannot make the stripper eat real
 * content", which was true of this regex and false of the module, because
 * `LONE_RE` ran first with a to-the-next-bracket match and consumed the
 * span before this ever saw it. The comment was accurate about its subject
 * and wrong about its scope, and a reader hardening the regex the comment
 * sat on would not have touched the cause. Claims about the whole strip
 * belong on {@link stripAskFence}.
 *
 * Runs after the two complete forms, not before: it matches the tag token
 * of every marker, so running it first would decapitate well-formed
 * markers and leave their attribute text behind as residue.
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
 *
 * **No trailing boundary**, so `ask-<uuid>xyz` still loses the nonce. A
 * `\b` there let one appended character carry the whole id through, which
 * is a keystroke for a hostile talker. The leading boundary stays, and is
 * spelled as a lookbehind rather than `\b` so it also excludes a hyphen:
 * that is what keeps a legitimate `task-<uuid>` intact, which `\b` would
 * not, since `\b` sees the `t` and the `a` as one word and never fires.
 * Asymmetric on purpose. Dropping the leading one too would catch
 * `Xask-<uuid>` and would also eat `task-<uuid>`, and protecting real task
 * ids is worth more than closing one more hostile spelling that the fence
 * markers no longer carry anyway.
 */
const ASK_ID_RE =
  /(?<![A-Za-z0-9_-])ask-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

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
 * A fenced construct is replaced, contents included, rather than being
 * unwrapped. Unwrapping would keep whatever sat inside, and inside a
 * fabricated fence that is precisely the payload; inside a real one it is
 * the rendered request, which the reasoner authored and already has. So
 * dropping it costs the reasoner nothing and denies the attacker the
 * laundering step.
 *
 * **Not every byte of a nested fabrication**, and the claim is worth
 * stating narrowly. The paired match is lazy, running from an open marker
 * to the NEXT close marker, so `<a>A<b>B</b>C</a>` loses everything through
 * `</b>` and leaves `C` before the lone pass takes `</a>`. A greedy match
 * would collect `C` and would also merge two unrelated fences in one
 * message into a single construct, deleting the legitimate text between
 * them; lazy is the right trade for the common case. What survives is a
 * fragment of hostile prose with every marker and nonce stripped out of it,
 * so it has no framing power left. Hostile-talker only: nothing produces
 * nested fences legitimately.
 *
 * Text with no marker and no nonce is returned unchanged. Angle brackets on
 * their own are left alone: only this exact tag name matches, so a talker
 * quoting a user's `a < b` or a snippet of HTML is not touched.
 *
 * **Nothing here ever removes more than a marker.** A truncated or
 * malformed marker costs its tag token and no surrounding prose, whatever
 * else the text contains. That is a property of the whole pipeline rather
 * than of any one pattern, so it is stated here: it holds because
 * {@link ATTRIBUTES} refuses to read prose as a tag body, and it would stop
 * holding if any pattern above went back to matching to the next `>`.
 * Regression cases for it live in duplex-ask-fence.test.ts.
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
