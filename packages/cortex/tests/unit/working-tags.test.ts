import { describe, it, expect } from 'vitest';
import {
  stripWorkingTags,
  extractWorkingContent,
  parseWorkingTags,
  WorkingTagStreamFilter,
} from '../../src/working-tags.js';

describe('stripWorkingTags', () => {
  it('returns text unchanged when no working tags are present', () => {
    const text = 'Hello, here is your answer.';
    expect(stripWorkingTags(text)).toBe('Hello, here is your answer.');
  });

  it('strips a single working block', () => {
    const text = 'Hello! <working>Internal analysis here.</working> Here is the result.';
    expect(stripWorkingTags(text)).toBe('Hello!\nHere is the result.');
  });

  it('strips multiple working blocks', () => {
    const text =
      '<working>First analysis.</working>Progress update. <working>Second analysis.</working>Final answer.';
    expect(stripWorkingTags(text)).toBe('Progress update.\nFinal answer.');
  });

  it('handles working block at the start', () => {
    const text = '<working>Reasoning about the problem.</working>Here is the answer.';
    expect(stripWorkingTags(text)).toBe('Here is the answer.');
  });

  it('handles working block at the end', () => {
    const text = 'Here is the answer. <working>Further notes for later.</working>';
    expect(stripWorkingTags(text)).toBe('Here is the answer.');
  });

  it('handles unclosed working tag', () => {
    const text = 'User message. <working>Partial analysis that was cut off';
    expect(stripWorkingTags(text)).toBe('User message.');
  });

  it('handles empty working block', () => {
    const text = 'Before. <working></working> After.';
    expect(stripWorkingTags(text)).toBe('Before.\nAfter.');
  });

  it('handles working block with only whitespace', () => {
    const text = 'Before. <working>   </working> After.';
    expect(stripWorkingTags(text)).toBe('Before.\nAfter.');
  });

  it('handles multi-line working content', () => {
    const text = `Before. <working>Line one of analysis.
Line two of analysis.
Line three.</working> After.`;
    expect(stripWorkingTags(text)).toBe('Before.\nAfter.');
  });

  it('returns empty string when everything is in working tags', () => {
    const text = '<working>All content is internal reasoning.</working>';
    expect(stripWorkingTags(text)).toBe('');
  });

  it('normalizes excessive whitespace between segments', () => {
    const text = 'Start.   <working>Middle.</working>   End.';
    expect(stripWorkingTags(text)).toBe('Start.\nEnd.');
  });

  it('handles nested tags as flat delimiters (first open, first close)', () => {
    // Nesting is not supported. The inner </working> closes the outer block.
    const text = 'Before. <working>Outer <working>inner</working> rest</working> After.';
    // The first </working> closes the first <working>, leaving " rest</working> After."
    // Then " rest" appears as user-facing text and "</working>" is literal text after stripping.
    // The second </working> is treated as literal text since there is no open tag.
    const result = stripWorkingTags(text);
    expect(result).toContain('Before.');
    expect(result).toContain('After.');
  });
});

describe('extractWorkingContent', () => {
  it('returns null when no working tags are present', () => {
    expect(extractWorkingContent('Hello, no tags here.')).toBeNull();
  });

  it('extracts content from a single working block', () => {
    const text = 'Hello! <working>Analysis of the data.</working> Result.';
    expect(extractWorkingContent(text)).toBe('Analysis of the data.');
  });

  it('concatenates multiple working blocks with newlines', () => {
    const text =
      '<working>First block.</working> Progress. <working>Second block.</working> Done.';
    expect(extractWorkingContent(text)).toBe('First block.\nSecond block.');
  });

  it('extracts content from unclosed working tag', () => {
    const text = 'Start. <working>Partial content that was cut off';
    expect(extractWorkingContent(text)).toBe('Partial content that was cut off');
  });

  it('returns null for empty working block', () => {
    const text = 'Before. <working></working> After.';
    expect(extractWorkingContent(text)).toBeNull();
  });

  it('returns null for whitespace-only working block', () => {
    const text = 'Before. <working>   </working> After.';
    expect(extractWorkingContent(text)).toBeNull();
  });

  it('trims whitespace from extracted content', () => {
    const text = '<working>  Padded content.  </working>';
    expect(extractWorkingContent(text)).toBe('Padded content.');
  });

  it('extracts multi-line working content', () => {
    const text = `Before. <working>Line one.
Line two.
Line three.</working> After.`;
    expect(extractWorkingContent(text)).toBe('Line one.\nLine two.\nLine three.');
  });
});

describe('parseWorkingTags', () => {
  it('parses text with no working tags (all user-facing)', () => {
    const text = 'Hello, here is your answer.';
    const result = parseWorkingTags(text);

    expect(result.userFacing).toBe('Hello, here is your answer.');
    expect(result.working).toBeNull();
    expect(result.raw).toBe(text);
  });

  it('parses text with a single working block', () => {
    const text =
      'Sure, let me look into that! <working>I should search for developer community platforms.</working>';
    const result = parseWorkingTags(text);

    expect(result.userFacing).toBe('Sure, let me look into that!');
    expect(result.working).toBe(
      'I should search for developer community platforms.',
    );
    expect(result.raw).toBe(text);
  });

  it('parses text with multiple working blocks', () => {
    const text = `<working>Search results show several strong options.</working>
Found some promising platforms. Digging into their posting requirements now.
<working>Based on posting guidelines research, dev.to has no restrictions.</working>

Here is what I would recommend:
1. dev.to
2. Reddit`;

    const result = parseWorkingTags(text);

    expect(result.working).toBe(
      'Search results show several strong options.\nBased on posting guidelines research, dev.to has no restrictions.',
    );
    expect(result.userFacing).toContain('Found some promising platforms.');
    expect(result.userFacing).toContain('Here is what I would recommend:');
    expect(result.userFacing).not.toContain('Search results show');
    expect(result.userFacing).not.toContain('posting guidelines research');
    expect(result.raw).toBe(text);
  });

  it('parses text with unclosed working tag', () => {
    const text = 'Acknowledged. <working>Starting analysis of the data and';
    const result = parseWorkingTags(text);

    expect(result.userFacing).toBe('Acknowledged.');
    expect(result.working).toBe('Starting analysis of the data and');
    expect(result.raw).toBe(text);
  });

  it('preserves the raw text exactly as provided', () => {
    const text = 'Hello <working>inner</working> world';
    const result = parseWorkingTags(text);
    expect(result.raw).toBe(text);
  });

  it('handles empty string', () => {
    const result = parseWorkingTags('');
    expect(result.userFacing).toBe('');
    expect(result.working).toBeNull();
    expect(result.raw).toBe('');
  });

  it('handles the full example from the docs', () => {
    // Turn 1 example from working-tags.md
    const turn1 = `Sure, let me look into that for you! <working>I should search for developer
community platforms, content aggregators, and social channels that work well
for open-source developer tools. Key factors: audience alignment with
self-hosted/AI enthusiasts, content format support, engagement patterns.</working>`;

    const result1 = parseWorkingTags(turn1);
    expect(result1.userFacing).toBe('Sure, let me look into that for you!');
    expect(result1.working).toContain('I should search for developer');
    expect(result1.working).toContain('engagement patterns.');

    // Turn 2 example
    const turn2 = `<working>Search results show several strong options: dev.to has 1M+ monthly
active developers and supports long-form markdown. Reddit r/selfhosted
(400K subscribers) is directly aligned with self-hosted positioning.</working>
Found some promising platforms. Digging into their posting requirements now.`;

    const result2 = parseWorkingTags(turn2);
    expect(result2.userFacing).toBe(
      'Found some promising platforms. Digging into their posting requirements now.',
    );
    expect(result2.working).toContain('dev.to has 1M+');
  });

  it('handles nested tags as flat delimiters', () => {
    // Nesting is not supported; treated as flat (first open, first close)
    const text = '<working>outer <working>inner</working> after';
    const result = parseWorkingTags(text);

    // First <working> to first </working> is the block: "outer <working>inner"
    // " after" is user-facing since the first </working> closed the block
    expect(result.working).toBe('outer <working>inner');
    expect(result.userFacing).toContain('after');
  });

  it('handles working tags in tool results context (not affected)', () => {
    // The parser works on any string; it is the caller's responsibility
    // to only parse agent-generated text, not tool results.
    // This test just verifies the parser handles the literal text correctly.
    const text = 'The file contains: <working>some code</working> and more text.';
    const result = parseWorkingTags(text);
    expect(result.userFacing).toBe('The file contains:\nand more text.');
    expect(result.working).toBe('some code');
  });
});

// ---------------------------------------------------------------------------
// WorkingTagStreamFilter (the duplex facade's voice-safe delta stream, F6)
// ---------------------------------------------------------------------------

describe('WorkingTagStreamFilter', () => {
  /** Run a whole message through one filter in the given chunks. */
  function filterChunks(chunks: string[]): string {
    const filter = new WorkingTagStreamFilter();
    let out = '';
    for (const chunk of chunks) out += filter.push(chunk);
    return out + filter.flush();
  }

  it('passes plain text through unchanged', () => {
    expect(filterChunks(['Hello ', 'world.'])).toBe('Hello world.');
  });

  it('suppresses a complete working block, leaving the newline sentinel', () => {
    expect(filterChunks(['Hi <working>thinking hard</working>done'])).toBe('Hi \ndone');
  });

  it('holds back a tag split across chunk boundaries and never emits working content', () => {
    const out = filterChunks(['Hello <wor', 'king>secret plan</wor', 'king>world']);
    expect(out).toBe('Hello \nworld');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('<working>');
  });

  it('is split-invariant: every 2-way chunking of a message yields the one-shot output', () => {
    const samples = [
      'Hello <working>secret alpha</working> world',
      '<working>secret at start</working>Answer.',
      'Tail case <working>secret omega</working>',
      'No tags at all, just < a stray bracket',
      'Math: 1 < 2 and <b>bold</b> stay literal',
      '<working>one</working>mid<working>two</working>end',
      'Unclosed <working>secret trailing',
      'Ends ambiguous <wor',
    ];
    for (const text of samples) {
      const oneShot = filterChunks([text]);
      for (let i = 0; i <= text.length; i++) {
        const split = filterChunks([text.slice(0, i), text.slice(i)]);
        expect(split, `split at ${i} of ${JSON.stringify(text)}`).toBe(oneShot);
        expect(split).not.toContain('secret');
      }
      // Character-by-character feeding crosses every boundary at once.
      expect(filterChunks([...text])).toBe(oneShot);
    }
  });

  it('emits a trailing "<" that never became a tag at flush time', () => {
    const filter = new WorkingTagStreamFilter();
    expect(filter.push('The answer is x ')).toBe('The answer is x ');
    expect(filter.push('<')).toBe('');
    expect(filter.flush()).toBe('<');
  });

  it('emits a held partial open tag that never completed', () => {
    const filter = new WorkingTagStreamFilter();
    expect(filter.push('see <work')).toBe('see ');
    // Diverges: '<work' + 'flow' is not '<working>'.
    expect(filter.push('flow>')).toBe('<workflow>');
    expect(filter.flush()).toBe('');
  });

  it('cannot deadlock on a close tag that never arrives: flush drops unterminated working content', () => {
    const filter = new WorkingTagStreamFilter();
    expect(filter.push('Sure. <working>never closed ')).toBe('Sure. ');
    expect(filter.push('still going')).toBe('');
    // flush() is synchronous and unconditional; the working content is
    // dropped exactly as stripWorkingTags drops an unclosed block.
    expect(filter.flush()).toBe('');
  });

  it('keeps literal non-working tags and lone close tags (parity with stripWorkingTags)', () => {
    expect(filterChunks(['a <b>bold</b> c'])).toBe('a <b>bold</b> c');
    // A lone close tag with no open block stays literal in the batch
    // parser, so the stream keeps it too.
    expect(filterChunks(['no block </working> here'])).toBe('no block </working> here');
  });

  it('reset() clears mode and held text between messages', () => {
    const filter = new WorkingTagStreamFilter();
    filter.push('start <working>unfinished');
    filter.reset();
    // A fresh message: nothing left over from the suppressed block.
    expect(filter.push('clean text')).toBe('clean text');
    expect(filter.flush()).toBe('');
  });
});
