import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ReadRegistry } from '../../../src/tools/shared/read-registry.js';
import { createReadTool } from '../../../src/tools/read.js';

describe('Read tool', () => {
  let registry: ReadRegistry;
  let readTool: ReturnType<typeof createReadTool>;
  let tmpDir: string;

  beforeEach(() => {
    registry = new ReadRegistry();
    readTool = createReadTool({ readRegistry: registry });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-read-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a text file with line numbers', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'line one\nline two\nline three\n');

    const result = await readTool.execute({ file_path: filePath });

    expect(result.content[0]?.type).toBe('text');
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('1\tline one');
    expect(text).toContain('2\tline two');
    expect(text).toContain('3\tline three');
    expect(result.details.totalLines).toBe(4); // trailing newline creates empty last line
    expect(result.details.filePath).toBe(filePath);
  });

  it('marks the file as read in the registry', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'content');

    expect(registry.hasBeenRead(filePath)).toBe(false);
    await readTool.execute({ file_path: filePath });
    expect(registry.hasBeenRead(filePath)).toBe(true);
  });

  it('reads with offset and limit', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const filePath = path.join(tmpDir, 'large.txt');
    fs.writeFileSync(filePath, lines.join('\n'));

    const result = await readTool.execute({
      file_path: filePath,
      offset: 5,
      limit: 3,
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('5\tline 5');
    expect(text).toContain('6\tline 6');
    expect(text).toContain('7\tline 7');
    expect(text).not.toContain('line 4');
    expect(text).not.toContain('line 8');
  });

  it('returns error for nonexistent file', async () => {
    const result = await readTool.execute({ file_path: '/nonexistent/file.txt' });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('File does not exist');
  });

  it('returns error for directory', async () => {
    const result = await readTool.execute({ file_path: tmpDir });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Cannot read a directory');
  });

  it('detects and returns image files as base64', async () => {
    const filePath = path.join(tmpDir, 'test.png');
    // Create a minimal PNG file (8-byte header)
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(filePath, pngHeader);

    const result = await readTool.execute({ file_path: filePath });

    expect(result.content[0]?.type).toBe('image');
    const imageContent = result.content[0] as { type: 'image'; data: string; mimeType: string };
    expect(imageContent.mimeType).toBe('image/png');
    expect(imageContent.data).toBe(pngHeader.toString('base64'));
  });

  it('detects binary files', async () => {
    const filePath = path.join(tmpDir, 'binary.dat');
    const buffer = Buffer.alloc(1024);
    buffer[0] = 0x00; // null byte
    buffer[10] = 0x00;
    fs.writeFileSync(filePath, buffer);

    const result = await readTool.execute({ file_path: filePath });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Binary file detected');
  });

  it('handles empty files', async () => {
    const filePath = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(filePath, '');

    const result = await readTool.execute({ file_path: filePath });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('File is empty');
  });

  it('truncates long lines', async () => {
    const filePath = path.join(tmpDir, 'longline.txt');
    const longLine = 'x'.repeat(3000);
    fs.writeFileSync(filePath, longLine);

    const result = await readTool.execute({ file_path: filePath });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('... [truncated]');
    expect(result.details.truncatedChars).toBe(true);
  });

  it('handles UTF-8 content', async () => {
    const filePath = path.join(tmpDir, 'utf8.txt');
    fs.writeFileSync(filePath, 'Hello \u00e9\u00e8\u00ea \u4e16\u754c\n');

    const result = await readTool.execute({ file_path: filePath });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('\u00e9\u00e8\u00ea');
    expect(text).toContain('\u4e16\u754c');
  });

  it('routes .pdf files through the PDF extractor rather than the binary path', async () => {
    // Malformed PDF bytes — the extractor surfaces a parse error, but
    // crucially the binary-file path is NOT taken (the .pdf extension
    // is handled specially).
    const filePath = path.join(tmpDir, 'document.pdf');
    const pdfHeader = Buffer.from('%PDF-1.4 fake pdf content');
    const pdfContent = Buffer.concat([pdfHeader, Buffer.alloc(100)]);
    fs.writeFileSync(filePath, pdfContent);

    const result = await readTool.execute({ file_path: filePath });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).not.toContain('Binary file detected');
    // Either a parse error surfaces, or the extractor reports no text.
    expect(text).toMatch(/parse PDF|no extractable text|image/i);
  });

  it('shows truncation notice when file exceeds limit', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const filePath = path.join(tmpDir, 'many-lines.txt');
    fs.writeFileSync(filePath, lines.join('\n'));

    const result = await readTool.execute({
      file_path: filePath,
      limit: 10,
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Showing lines');
    expect(text).toContain('of 100 total');
    expect(result.details.truncatedLines).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Device path blocking
  // -----------------------------------------------------------------------

  describe('device path blocking', () => {
    it('blocks /dev/zero', async () => {
      const result = await readTool.execute({ file_path: '/dev/zero' });
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('would block or produce infinite output');
    });

    it('blocks /dev/random', async () => {
      const result = await readTool.execute({ file_path: '/dev/random' });
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('would block or produce infinite output');
    });

    it('blocks /dev/stdin', async () => {
      const result = await readTool.execute({ file_path: '/dev/stdin' });
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('would block or produce infinite output');
    });

    it('blocks /dev/tty', async () => {
      const result = await readTool.execute({ file_path: '/dev/tty' });
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('would block or produce infinite output');
    });

    it('blocks /proc/self/fd/0', async () => {
      const result = await readTool.execute({ file_path: '/proc/self/fd/0' });
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('would block or produce infinite output');
    });

    it('blocks /proc/123/fd/1', async () => {
      const result = await readTool.execute({ file_path: '/proc/123/fd/1' });
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('would block or produce infinite output');
    });

    it('allows /dev/null (not blocked)', async () => {
      const result = await readTool.execute({ file_path: '/dev/null' });
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      // /dev/null is empty, should not trigger device blocking
      expect(text).not.toContain('would block');
    });
  });

  // -----------------------------------------------------------------------
  // File-unchanged dedup
  // -----------------------------------------------------------------------

  describe('file-unchanged dedup', () => {
    it('returns unchanged stub on re-read of same file', async () => {
      const filePath = path.join(tmpDir, 'stable.txt');
      fs.writeFileSync(filePath, 'hello world\n');

      // First read: returns content
      const first = await readTool.execute({ file_path: filePath });
      const firstText = (first.content[0] as { type: 'text'; text: string }).text;
      expect(firstText).toContain('hello world');

      // Second read (same file, same range): returns stub
      const second = await readTool.execute({ file_path: filePath });
      const secondText = (second.content[0] as { type: 'text'; text: string }).text;
      expect(secondText).toContain('File unchanged since last read');
    });

    it('returns full content when file is modified between reads', async () => {
      const filePath = path.join(tmpDir, 'changing.txt');
      fs.writeFileSync(filePath, 'version 1\n');

      // First read
      await readTool.execute({ file_path: filePath });

      // Modify the file (need to change mtime)
      // Touch the file with a different timestamp
      const futureTime = Date.now() + 2000;
      fs.utimesSync(filePath, futureTime / 1000, futureTime / 1000);

      // Second read: file changed, should return full content
      const second = await readTool.execute({ file_path: filePath });
      const secondText = (second.content[0] as { type: 'text'; text: string }).text;
      expect(secondText).toContain('version 1');
      expect(secondText).not.toContain('unchanged');
    });

    it('returns full content when different range is requested', async () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
      const filePath = path.join(tmpDir, 'multirange.txt');
      fs.writeFileSync(filePath, lines.join('\n'));

      // Read lines 1-10
      await readTool.execute({ file_path: filePath, offset: 1, limit: 10 });

      // Read lines 20-30 (different range): should return full content
      const second = await readTool.execute({ file_path: filePath, offset: 20, limit: 10 });
      const secondText = (second.content[0] as { type: 'text'; text: string }).text;
      expect(secondText).toContain('line 20');
      expect(secondText).not.toContain('unchanged');
    });

    it('does not dedup after registry is cleared', async () => {
      const filePath = path.join(tmpDir, 'cleared.txt');
      fs.writeFileSync(filePath, 'content\n');

      // First read
      await readTool.execute({ file_path: filePath });

      // Clear registry (simulates new agentic loop)
      registry.clear();

      // Second read: no dedup, returns full content
      const second = await readTool.execute({ file_path: filePath });
      const secondText = (second.content[0] as { type: 'text'; text: string }).text;
      expect(secondText).toContain('content');
      expect(secondText).not.toContain('unchanged');
    });
  });

  // -----------------------------------------------------------------------
  // Size and token gates
  // -----------------------------------------------------------------------

  describe('size and token gates', () => {
    it('Gate 1: rejects files over 10 MB', async () => {
      const filePath = path.join(tmpDir, 'huge.txt');
      // Create a file just over 10 MB using sparse write
      const fd = fs.openSync(filePath, 'w');
      fs.writeSync(fd, 'x', 10 * 1024 * 1024 + 1);
      fs.closeSync(fd);

      const result = await readTool.execute({ file_path: filePath });
      const text = (result.content[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('too large to read');
      expect(text).toContain('10.0 MB');
      expect(text).toContain('Bash');
      expect(result.details.rejected).toBe(true);
    });

    it('Gate 1: rejects files over 10 MB even with offset/limit', async () => {
      const filePath = path.join(tmpDir, 'huge2.txt');
      const fd = fs.openSync(filePath, 'w');
      fs.writeSync(fd, 'x', 10 * 1024 * 1024 + 1);
      fs.closeSync(fd);

      const result = await readTool.execute({ file_path: filePath, offset: 1, limit: 10 });
      const text = (result.content[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('too large to read');
      expect(result.details.rejected).toBe(true);
    });

    it('Gate 2: rejects full reads of files over 256 KB', async () => {
      const filePath = path.join(tmpDir, 'medium.txt');
      // Create a file just over 256 KB
      const content = 'a'.repeat(256 * 1024 + 100) + '\n';
      fs.writeFileSync(filePath, content);

      const result = await readTool.execute({ file_path: filePath });
      const text = (result.content[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('too large to read in full');
      expect(text).toContain('256 KB');
      expect(text).toContain('offset and limit');
      expect(text).toContain('Grep');
      expect(result.details.rejected).toBe(true);
    });

    it('Gate 2: allows files over 256 KB when offset/limit is provided', async () => {
      const filePath = path.join(tmpDir, 'medium-ranged.txt');
      // Create a file over 256 KB with identifiable content
      const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}: ${'x'.repeat(60)}`);
      fs.writeFileSync(filePath, lines.join('\n'));

      const result = await readTool.execute({ file_path: filePath, offset: 1, limit: 10 });
      const text = (result.content[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('line 1:');
      expect(text).toContain('line 10:');
      expect(result.details.rejected).toBeUndefined();
    });

    it('Gate 3: rejects output exceeding 25K estimated tokens', async () => {
      const filePath = path.join(tmpDir, 'dense.txt');
      // Create content that fits in 256 KB but produces >25K tokens
      // Each line ~120 chars, 2000 lines (default limit) = 240K chars ~ 60K tokens
      const lines = Array.from({ length: 2000 }, (_, i) => `${i}: ${'abcdefghij'.repeat(11)}`);
      fs.writeFileSync(filePath, lines.join('\n'));

      // Verify it's under 256 KB so Gate 2 doesn't fire
      const stat = fs.statSync(filePath);
      expect(stat.size).toBeLessThan(256 * 1024);

      const result = await readTool.execute({ file_path: filePath });
      const text = (result.content[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('too large');
      expect(text).toContain('tokens');
      expect(text).toContain('smaller limit');
      expect(text).toContain('Grep');
      expect(result.details.rejected).toBe(true);
    });

    it('Gate 3: suggests a reduced limit in rejection message', async () => {
      const filePath = path.join(tmpDir, 'suggest.txt');
      // Create content that will produce ~50K tokens with limit 2000
      const lines = Array.from({ length: 2000 }, (_, i) => `${i}: ${'abcdefghij'.repeat(11)}`);
      fs.writeFileSync(filePath, lines.join('\n'));

      const result = await readTool.execute({ file_path: filePath });
      const text = (result.content[0] as { type: 'text'; text: string }).text;

      // Should suggest a limit roughly half of 2000 (since tokens are ~2x over)
      expect(text).toMatch(/try limit: \d+/);
    });

    it('Gate 3: does not mark file as read on rejection', async () => {
      const filePath = path.join(tmpDir, 'nomark.txt');
      const lines = Array.from({ length: 2000 }, (_, i) => `${i}: ${'abcdefghij'.repeat(11)}`);
      fs.writeFileSync(filePath, lines.join('\n'));

      await readTool.execute({ file_path: filePath });

      // File should NOT be marked as read since Gate 3 rejected it
      expect(registry.hasBeenRead(filePath)).toBe(false);
    });

    it('allows files under all gate thresholds', async () => {
      const filePath = path.join(tmpDir, 'small.txt');
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
      fs.writeFileSync(filePath, lines.join('\n'));

      const result = await readTool.execute({ file_path: filePath });
      const text = (result.content[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('line 1');
      expect(text).toContain('line 50');
      expect(result.details.rejected).toBeUndefined();
      expect(registry.hasBeenRead(filePath)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Tool description
  // -----------------------------------------------------------------------

  describe('tool description', () => {
    it('includes size guidance', () => {
      expect(readTool.description).toContain('256 KB');
      expect(readTool.description).toContain('10.0 MB');
    });

    it('mentions Grep for searching', () => {
      expect(readTool.description).toContain('Grep');
    });

    it('mentions token limit', () => {
      expect(readTool.description).toContain('25,000 tokens');
    });
  });

  // -------------------------------------------------------------------------
  // PDF extraction (integration via unpdf)
  // -------------------------------------------------------------------------

  describe('PDF files', () => {
    /** Build a PDF on disk from the given page texts. Returns the file path. */
    async function writePdf(pageTexts: string[], fileName = 'doc.pdf'): Promise<string> {
      const { PDFDocument, StandardFonts } = await import('pdf-lib');
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      for (const pageText of pageTexts) {
        const page = doc.addPage();
        if (pageText.length > 0) {
          page.drawText(pageText, { x: 72, y: 720, font, size: 12 });
        }
      }
      const bytes = await doc.save();
      const filePath = path.join(tmpDir, fileName);
      fs.writeFileSync(filePath, bytes);
      return filePath;
    }

    function getText(result: { content: Array<{ type: string; text?: string }> }): string {
      return (result.content[0] as { type: 'text'; text: string }).text;
    }

    it('extracts text from a multi-page PDF with line-numbered output', async () => {
      const pdfPath = await writePdf([
        'First page introduces the topic.',
        'Second page elaborates on the subject.',
      ]);

      const result = await readTool.execute({ file_path: pdfPath });

      const text = getText(result);
      expect(text).toContain('[PDF: 2 pages]');
      expect(text).toContain('[Page 1]');
      expect(text).toContain('First page');
      expect(text).toContain('[Page 2]');
      expect(text).toContain('Second page');
      // Line-numbered like any other text read.
      expect(text).toMatch(/^\s+1\t/m);
      expect(result.details.totalLines).toBeGreaterThan(0);
      expect(result.details.rejected).toBeUndefined();
    });

    it('honors the pages parameter for a subset extraction', async () => {
      const pdfPath = await writePdf([
        'Alpha content',
        'Beta content',
        'Gamma content',
      ]);

      const result = await readTool.execute({
        file_path: pdfPath,
        pages: '2-3',
      });

      const text = getText(result);
      expect(text).toContain('[PDF: showing pages 2-3 of 3]');
      expect(text).toContain('Beta');
      expect(text).toContain('Gamma');
      expect(text).not.toContain('Alpha');
    });

    it('rejects a pages spec that is out of range', async () => {
      const pdfPath = await writePdf(['only page']);

      const result = await readTool.execute({
        file_path: pdfPath,
        pages: '5',
      });

      expect(result.details.rejected).toBe(true);
      expect(getText(result)).toContain('exceeds document');
    });

    it('rejects a malformed pages spec with an actionable message', async () => {
      const pdfPath = await writePdf(['page one']);

      const result = await readTool.execute({
        file_path: pdfPath,
        pages: 'bogus',
      });

      expect(result.details.rejected).toBe(true);
      expect(getText(result)).toContain('Invalid pages spec');
    });

    it('reports scanned/image-only PDFs with a clear message', async () => {
      const pdfPath = await writePdf(['']); // no text on the page

      const result = await readTool.execute({ file_path: pdfPath });

      expect(result.details.rejected).toBe(true);
      expect(getText(result)).toMatch(/scanned|image/i);
    });

    it('marks the PDF as read so Edit-style freshness checks work', async () => {
      const pdfPath = await writePdf([
        'A page with enough content to clear the empty-text threshold.',
      ]);
      expect(registry.hasBeenRead(pdfPath)).toBe(false);
      await readTool.execute({ file_path: pdfPath });
      expect(registry.hasBeenRead(pdfPath)).toBe(true);
    });

    it('still enforces the 10 MB absolute size ceiling', async () => {
      const pdfPath = path.join(tmpDir, 'huge.pdf');
      // Write a "PDF" placeholder larger than the ceiling. Doesn't need
      // to be a real PDF — the size gate short-circuits before extraction.
      const big = Buffer.alloc(11 * 1024 * 1024, 0x20);
      fs.writeFileSync(pdfPath, big);

      const result = await readTool.execute({ file_path: pdfPath });

      expect(result.details.rejected).toBe(true);
      expect(getText(result)).toContain('too large');
    });

    it('reports a parse error for bytes that are not a valid PDF', async () => {
      const pdfPath = path.join(tmpDir, 'invalid.pdf');
      fs.writeFileSync(pdfPath, Buffer.from([0, 1, 2, 3, 4, 5]));

      const result = await readTool.execute({ file_path: pdfPath });

      expect(result.details.rejected).toBe(true);
      expect(getText(result)).toContain('parse PDF');
    });
  });
});
