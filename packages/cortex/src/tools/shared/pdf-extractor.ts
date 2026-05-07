/**
 * PDF text extraction.
 *
 * Wraps `unpdf` (pure-ESM, zero native deps) behind a narrow, well-typed
 * boundary so the Read tool never touches pdfjs directly. Swapping the
 * backend later is a one-file change.
 *
 * Responsibilities:
 *   - Parse the caller's `pages` spec and clamp it to the document and
 *     the per-call page cap.
 *   - Extract per-page text.
 *   - Detect "no extractable text" (scanned / image-only PDFs) and
 *     return a structured signal rather than silently-empty output.
 *   - Render the extracted text with `[Page N]` markers so the caller
 *     can line-number it exactly like any other file content.
 *
 * Pure-ish: does no filesystem I/O. Callers are expected to have
 * already loaded the PDF bytes.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PdfExtractionRequest {
  /** PDF bytes. Accepts a Node Buffer or any Uint8Array. */
  data: Buffer | Uint8Array;
  /**
   * Page spec: `"N"`, `"N-M"`, or undefined. When undefined, extracts
   * the first `maxPages` pages starting at page 1.
   */
  pagesSpec?: string | undefined;
  /** Upper bound on how many pages may be extracted in one call. */
  maxPages?: number;
}

export interface PdfExtractionOk {
  kind: 'ok';
  totalPages: number;
  /** First page extracted (1-based, inclusive). */
  firstPage: number;
  /** Last page extracted (1-based, inclusive). */
  lastPage: number;
  /** Per-page text. `pages[i].pageNumber` is 1-based. */
  pages: Array<{ pageNumber: number; text: string }>;
  /**
   * Full rendered text with `[Page N]` markers separating pages, ready
   * to be handed to the same line-numbering pipeline Read uses for
   * plain text files.
   */
  rendered: string;
}

export interface PdfExtractionEmpty {
  kind: 'empty';
  totalPages: number;
  firstPage: number;
  lastPage: number;
  message: string;
}

export interface PdfExtractionInvalidRange {
  kind: 'invalid-range';
  totalPages: number;
  message: string;
}

export interface PdfExtractionError {
  kind: 'error';
  message: string;
}

export type PdfExtractionResult =
  | PdfExtractionOk
  | PdfExtractionEmpty
  | PdfExtractionInvalidRange
  | PdfExtractionError;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default cap on pages extracted per call. Matches the advertised
 * schema default for Read's `pages` param ("max 20 pages per request").
 */
export const DEFAULT_MAX_PAGES = 20;

/**
 * Total-text length below which we treat the document as image-based.
 * 20 characters allows for a stray page number or watermark without
 * pretending we extracted meaningful content.
 */
const EMPTY_TEXT_THRESHOLD = 20;

// ---------------------------------------------------------------------------
// Pages-spec parsing (pure, unit-testable)
// ---------------------------------------------------------------------------

export type PagesSpecResult =
  | { ok: true; first: number; last: number }
  | { ok: false; message: string };

/**
 * Parse a pages-spec string against a document's page count and the
 * per-call cap. Enforces:
 *   - Format: `"N"` or `"N-M"` (base 10, whitespace tolerant)
 *   - 1 <= first <= last <= totalPages
 *   - (last - first + 1) <= maxPages
 *
 * Returns `{ ok: false }` with an actionable message on any failure.
 */
export function parsePagesSpec(
  spec: string,
  totalPages: number,
  maxPages: number,
): PagesSpecResult {
  const trimmed = spec.trim();
  const rangeMatch = /^(\d+)-(\d+)$/u.exec(trimmed);
  const singleMatch = /^(\d+)$/u.exec(trimmed);

  let first: number;
  let last: number;
  if (rangeMatch) {
    first = Number.parseInt(rangeMatch[1]!, 10);
    last = Number.parseInt(rangeMatch[2]!, 10);
  } else if (singleMatch) {
    first = Number.parseInt(singleMatch[1]!, 10);
    last = first;
  } else {
    return {
      ok: false,
      message: `Invalid pages spec "${spec}". Use "N" or "N-M" (e.g. "1-5", "3").`,
    };
  }

  if (first < 1) {
    return { ok: false, message: `Page numbers are 1-based; got first page ${first}.` };
  }
  if (last < first) {
    return {
      ok: false,
      message: `Invalid pages spec "${spec}": last page (${last}) is before first page (${first}).`,
    };
  }
  if (last > totalPages) {
    return {
      ok: false,
      message: `Pages spec "${spec}" exceeds document (has ${totalPages} page${totalPages === 1 ? '' : 's'}).`,
    };
  }
  const count = last - first + 1;
  if (count > maxPages) {
    return {
      ok: false,
      message: `Pages spec "${spec}" requests ${count} pages; the per-call limit is ${maxPages}. Narrow the range.`,
    };
  }

  return { ok: true, first, last };
}

// ---------------------------------------------------------------------------
// Buffer normalization
// ---------------------------------------------------------------------------

/**
 * Convert input bytes to a fresh, owned `Uint8Array`.
 *
 * `unpdf` rejects `Buffer` inputs outright ("Please provide binary data
 * as `Uint8Array`, rather than `Buffer`"), and its PDF.js worker path
 * may transfer the backing buffer during postMessage — leaving a shared
 * view detached for subsequent calls. Making a full copy here keeps
 * the caller's buffer usable and makes repeat extractions on the same
 * bytes safe across tests and sessions.
 */
function toUint8Array(data: Buffer | Uint8Array): Uint8Array {
  return new Uint8Array(data);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract text from a PDF buffer. Never throws — all failure modes are
 * returned as structured results so the caller can render them as
 * tool-content messages.
 */
export async function extractPdfText(
  req: PdfExtractionRequest,
): Promise<PdfExtractionResult> {
  const maxPages = req.maxPages ?? DEFAULT_MAX_PAGES;
  const bytes = toUint8Array(req.data);

  let extractResult: { totalPages: number; text: string[] };
  try {
    const { extractText } = await import('unpdf');
    const raw = await extractText(bytes, { mergePages: false });
    extractResult = {
      totalPages: raw.totalPages,
      text: Array.isArray(raw.text) ? raw.text : [raw.text],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      message: `Failed to parse PDF: ${msg}`,
    };
  }

  const { totalPages, text: allPages } = extractResult;

  if (totalPages === 0) {
    return {
      kind: 'empty',
      totalPages: 0,
      firstPage: 0,
      lastPage: 0,
      message: 'PDF contains no pages.',
    };
  }

  // Resolve the page range.
  let first: number;
  let last: number;
  if (req.pagesSpec !== undefined) {
    const parsed = parsePagesSpec(req.pagesSpec, totalPages, maxPages);
    if (!parsed.ok) {
      return { kind: 'invalid-range', totalPages, message: parsed.message };
    }
    first = parsed.first;
    last = parsed.last;
  } else {
    first = 1;
    last = Math.min(maxPages, totalPages);
  }

  const pages: Array<{ pageNumber: number; text: string }> = [];
  for (let pageNumber = first; pageNumber <= last; pageNumber++) {
    const raw = allPages[pageNumber - 1] ?? '';
    pages.push({ pageNumber, text: raw });
  }

  const totalLen = pages.reduce((n, p) => n + p.text.trim().length, 0);
  if (totalLen < EMPTY_TEXT_THRESHOLD) {
    return {
      kind: 'empty',
      totalPages,
      firstPage: first,
      lastPage: last,
      message:
        totalPages > 0 && totalLen === 0
          ? 'PDF has no extractable text (likely scanned or image-only). Use an OCR tool to process it.'
          : 'PDF yielded almost no extractable text (likely scanned or image-heavy). Use an OCR tool for full content.',
    };
  }

  const rendered = renderPages(pages, first, last, totalPages);

  return {
    kind: 'ok',
    totalPages,
    firstPage: first,
    lastPage: last,
    pages,
    rendered,
  };
}

/**
 * Render the per-page text into a single string with `[Page N]`
 * markers. A leading summary line is included so the model knows how
 * many pages the document has and which subset it's seeing.
 */
function renderPages(
  pages: Array<{ pageNumber: number; text: string }>,
  firstPage: number,
  lastPage: number,
  totalPages: number,
): string {
  const header =
    firstPage === 1 && lastPage === totalPages
      ? `[PDF: ${totalPages} page${totalPages === 1 ? '' : 's'}]`
      : `[PDF: showing pages ${firstPage}-${lastPage} of ${totalPages}]`;
  const body = pages
    .map((p) => `[Page ${p.pageNumber}]\n${p.text.trim()}`)
    .join('\n\n');
  return `${header}\n\n${body}\n`;
}
