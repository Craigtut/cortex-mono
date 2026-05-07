import { describe, it, expect, beforeAll } from 'vitest';
import {
  extractPdfText,
  parsePagesSpec,
  DEFAULT_MAX_PAGES,
} from '../../../src/tools/shared/pdf-extractor.js';

// ---------------------------------------------------------------------------
// Fixture generation (deterministic, in-memory)
// ---------------------------------------------------------------------------

interface Fixtures {
  /** 3-page PDF with distinct text per page. */
  multiPage: Uint8Array;
  /** 1-page PDF containing a single short line. */
  singlePage: Uint8Array;
  /** 1-page PDF with no text drawn (empty page — simulates image-only). */
  imageOnly: Uint8Array;
}

async function buildFixtures(): Promise<Fixtures> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');

  const make = async (pages: string[]): Promise<Uint8Array> => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const pageText of pages) {
      const page = doc.addPage();
      if (pageText.length > 0) {
        page.drawText(pageText, { x: 72, y: 720, font, size: 12 });
      }
    }
    return await doc.save();
  };

  const [multiPage, singlePage, imageOnly] = await Promise.all([
    make([
      'Alpha page content describing the first section.',
      'Beta page has different text for validation.',
      'Gamma page concludes with a final paragraph.',
    ]),
    make(['Single page: short text content here.']),
    make(['']), // empty page content — no text to extract
  ]);

  return { multiPage, singlePage, imageOnly };
}

// ---------------------------------------------------------------------------
// parsePagesSpec (pure, needs no fixtures)
// ---------------------------------------------------------------------------

describe('parsePagesSpec', () => {
  it('parses a single-page spec', () => {
    expect(parsePagesSpec('3', 10, 20)).toEqual({ ok: true, first: 3, last: 3 });
  });

  it('parses a range spec', () => {
    expect(parsePagesSpec('2-5', 10, 20)).toEqual({ ok: true, first: 2, last: 5 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parsePagesSpec('  2-5  ', 10, 20)).toEqual({
      ok: true, first: 2, last: 5,
    });
  });

  it('rejects non-numeric spec', () => {
    const r = parsePagesSpec('foo', 10, 20);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('Invalid pages spec');
  });

  it('rejects zero and negative page numbers', () => {
    expect(parsePagesSpec('0', 10, 20).ok).toBe(false);
    // '-1' fails the regex (no sign allowed); message should still reflect invalid format
    expect(parsePagesSpec('-1', 10, 20).ok).toBe(false);
  });

  it('rejects inverted ranges', () => {
    const r = parsePagesSpec('5-2', 10, 20);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('before first page');
  });

  it('rejects ranges beyond document length', () => {
    const r = parsePagesSpec('5-15', 10, 20);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('exceeds document');
  });

  it('rejects ranges exceeding the per-call cap', () => {
    const r = parsePagesSpec('1-30', 100, 20);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('per-call limit is 20');
  });

  it('produces a singular "page" for a 1-page document message', () => {
    const r = parsePagesSpec('2', 1, 20);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('has 1 page');
  });
});

// ---------------------------------------------------------------------------
// extractPdfText (fixture-backed)
// ---------------------------------------------------------------------------

describe('extractPdfText', () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    fixtures = await buildFixtures();
  }, 30_000);

  it('extracts text from all pages when no spec is given (within cap)', async () => {
    const r = await extractPdfText({ data: fixtures.multiPage });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.totalPages).toBe(3);
    expect(r.firstPage).toBe(1);
    expect(r.lastPage).toBe(3);
    expect(r.pages).toHaveLength(3);
    expect(r.pages[0]!.text).toContain('Alpha');
    expect(r.pages[1]!.text).toContain('Beta');
    expect(r.pages[2]!.text).toContain('Gamma');
  });

  it('renders a page-count header for a full extraction', async () => {
    const r = await extractPdfText({ data: fixtures.multiPage });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.rendered).toContain('[PDF: 3 pages]');
    expect(r.rendered).toContain('[Page 1]');
    expect(r.rendered).toContain('[Page 2]');
    expect(r.rendered).toContain('[Page 3]');
  });

  it('renders a "showing pages X-Y" header for a subset extraction', async () => {
    const r = await extractPdfText({ data: fixtures.multiPage, pagesSpec: '2-3' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.rendered).toContain('[PDF: showing pages 2-3 of 3]');
    expect(r.rendered).toContain('[Page 2]');
    expect(r.rendered).toContain('[Page 3]');
    expect(r.rendered).not.toContain('[Page 1]');
  });

  it('honors a single-page spec', async () => {
    const r = await extractPdfText({ data: fixtures.multiPage, pagesSpec: '2' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.firstPage).toBe(2);
    expect(r.lastPage).toBe(2);
    expect(r.pages[0]!.text).toContain('Beta');
  });

  it('returns invalid-range for out-of-range specs', async () => {
    const r = await extractPdfText({ data: fixtures.multiPage, pagesSpec: '5' });
    expect(r.kind).toBe('invalid-range');
    if (r.kind === 'invalid-range') {
      expect(r.totalPages).toBe(3);
      expect(r.message).toContain('exceeds document');
    }
  });

  it('returns invalid-range for malformed specs without scanning the PDF', async () => {
    const r = await extractPdfText({ data: fixtures.multiPage, pagesSpec: 'abc' });
    expect(r.kind).toBe('invalid-range');
    if (r.kind === 'invalid-range') {
      expect(r.message).toContain('Invalid pages spec');
    }
  });

  it('returns empty for a PDF with no extractable text', async () => {
    const r = await extractPdfText({ data: fixtures.imageOnly });
    expect(r.kind).toBe('empty');
    if (r.kind === 'empty') {
      expect(r.totalPages).toBeGreaterThanOrEqual(1);
      expect(r.message).toMatch(/scanned|image/i);
    }
  });

  it('handles a single-page document', async () => {
    const r = await extractPdfText({ data: fixtures.singlePage });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.totalPages).toBe(1);
    expect(r.pages[0]!.text).toContain('Single page');
    expect(r.rendered).toContain('[PDF: 1 page]');
  });

  it('accepts a Node Buffer (must be zero-copy-converted to Uint8Array)', async () => {
    const buf = Buffer.from(fixtures.multiPage);
    const r = await extractPdfText({ data: buf });
    expect(r.kind).toBe('ok');
  });

  it('returns a parse error for bytes that are not a valid PDF', async () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    const r = await extractPdfText({ data: garbage });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('parse PDF');
  });

  it('respects a custom maxPages cap', async () => {
    const r = await extractPdfText({ data: fixtures.multiPage, maxPages: 2 });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.pages).toHaveLength(2);
    expect(r.lastPage).toBe(2);
  });

  it('rejects a spec that exceeds a custom maxPages cap', async () => {
    const r = await extractPdfText({
      data: fixtures.multiPage,
      pagesSpec: '1-3',
      maxPages: 2,
    });
    expect(r.kind).toBe('invalid-range');
    if (r.kind === 'invalid-range') {
      expect(r.message).toContain('per-call limit is 2');
    }
  });

  it('uses DEFAULT_MAX_PAGES when no maxPages override is provided', () => {
    // Sanity check on the advertised default, referenced by the Read
    // tool's schema text.
    expect(DEFAULT_MAX_PAGES).toBe(20);
  });
});
