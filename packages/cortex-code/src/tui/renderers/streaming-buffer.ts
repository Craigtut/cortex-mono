/**
 * Rolling window buffer for streaming shell output.
 *
 * Accumulates stdout/stderr chunks and provides a windowed view of
 * the most recent lines. Handles partial line buffering (lines without
 * a trailing newline are held separately until completed).
 */

export class StreamingBuffer {
  private lines: string[] = [];
  private partialLine = '';

  /**
   * Append a chunk of output to the buffer.
   * Splits on newlines; holds the last segment if it lacks a trailing newline.
   */
  append(chunk: string): void {
    const combined = this.partialLine + chunk;
    const segments = combined.split('\n');

    // Last segment is either empty (chunk ended with \n) or a partial line
    this.partialLine = segments.pop() ?? '';

    // All other segments are complete lines
    for (const segment of segments) {
      this.lines.push(segment);
    }
  }

  /**
   * Get the most recent N lines (complete lines only).
   * If fewer than maxLines exist, returns all available lines.
   */
  getLines(maxLines: number): string[] {
    if (this.lines.length <= maxLines) {
      return [...this.lines];
    }
    return this.lines.slice(-maxLines);
  }

  /** Total number of complete lines received. */
  getTotalLineCount(): number {
    return this.lines.length;
  }

  /** Get the current partial (incomplete) line, if any. */
  getPartialLine(): string {
    return this.partialLine;
  }

  /** Get all complete output as a single string. */
  getCompleteOutput(): string {
    return this.lines.join('\n') + (this.partialLine ? '\n' + this.partialLine : '');
  }

  /** Reset the buffer. */
  clear(): void {
    this.lines = [];
    this.partialLine = '';
  }
}
