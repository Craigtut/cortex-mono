/**
 * Rendering of permission asks for humans.
 *
 * A rendering names the permission and the actual command, path, pattern,
 * or URL at stake, truncated at a fixed cap but NEVER summarized or
 * paraphrased: a surface voicing it must be able to read exactly what will
 * run (review-findings F14: a softened rendering is forced by the data, not
 * by model misbehavior).
 *
 * Truncation keeps head AND tail, eliding only the middle. A head-only cut
 * would let a long benign prefix conceal a destructive suffix from the
 * human approving the string (`… && rm -rf ~/work`). The middle is still
 * concealed, so an over-cap rendering is not a full transcript of what will
 * run; a surface that needs certainty must read the tool call's own args.
 */

import { BASH_ESCALATION_PERMISSION_NAME, TOOL_NAMES } from './tools/tool-names.js';
import { toolCallSubject } from './tools/tool-call-subject.js';

/** Long enough that a real command line survives verbatim (D16: this is the string a human approves). */
const RENDERED_REQUEST_MAX_CHARS = 500;
const RENDERED_REQUEST_HEAD_CHARS = 300;
const RENDERED_REQUEST_TAIL_CHARS = 150;

/**
 * `value` if it fits in `maxChars`, else its first `headChars` and last
 * `tailChars` around an elision marker. Sliced by code points so the cut
 * cannot split a surrogate pair and corrupt the characters at the seam.
 */
export function clipHeadTail(
  value: string,
  maxChars: number,
  headChars: number,
  tailChars: number,
): string {
  if (value.length <= maxChars) return value;
  const chars = [...value];
  if (chars.length <= maxChars) return value;
  const elided = chars.length - headChars - tailChars;
  return (
    chars.slice(0, headChars).join('') +
    ` …[${elided} chars elided]… ` +
    chars.slice(-tailChars).join('')
  );
}

/** Clamp a rendered request to the shared rendering cap. */
export function clampRenderedRequest(rendered: string): string {
  return clipHeadTail(
    rendered,
    RENDERED_REQUEST_MAX_CHARS,
    RENDERED_REQUEST_HEAD_CHARS,
    RENDERED_REQUEST_TAIL_CHARS,
  );
}

function verbatim(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Verbatim rendering of a tool permission ask: the permission name plus
 * the call's identifying argument, or its full arguments as JSON for a
 * tool without one.
 */
export function renderPermissionRequest(permissionName: string, params: unknown): string {
  const tool = permissionName === BASH_ESCALATION_PERMISSION_NAME ? TOOL_NAMES.Bash : permissionName;
  const subject = toolCallSubject(tool, params);
  let detail: string;
  if ('command' in subject) {
    detail = verbatim(subject.command);
  } else if ('path' in subject) {
    detail = verbatim(subject.path);
  } else if ('pattern' in subject) {
    const pattern = verbatim(subject.pattern);
    const scope = verbatim(subject.scope);
    detail = scope ? `${pattern} in ${scope}` : pattern;
  } else if ('url' in subject) {
    detail = verbatim(subject.url);
  } else {
    detail = verbatim(params);
  }
  return clampRenderedRequest(detail.length > 0 ? `${permissionName}: ${detail}` : permissionName);
}
