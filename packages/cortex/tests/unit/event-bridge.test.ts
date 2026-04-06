import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBridge } from '../../src/event-bridge.js';
import type { PiEvent, PiEventSource, CortexEvent, CortexEventType } from '../../src/event-bridge.js';

/**
 * Create a mock pi-agent-core event source.
 * Stores the subscription handler so we can emit events manually.
 */
function createMockSource(): PiEventSource & { emit: (event: PiEvent) => void } {
  let handler: ((event: PiEvent) => void) | null = null;

  return {
    subscribe(h: (event: PiEvent) => void): () => void {
      handler = h;
      return () => {
        handler = null;
      };
    },
    emit(event: PiEvent): void {
      if (handler) {
        handler(event);
      }
    },
  };
}

describe('EventBridge', () => {
  let bridge: EventBridge;
  let source: ReturnType<typeof createMockSource>;

  beforeEach(() => {
    bridge = new EventBridge(true);
    source = createMockSource();
    bridge.wire(source);
  });

  // -----------------------------------------------------------------------
  // Event mapping
  // -----------------------------------------------------------------------

  describe('event mapping', () => {
    const mappings: Array<[string, CortexEventType]> = [
      ['agent_start', 'session_start'],
      ['agent_end', 'session_end'],
      ['turn_start', 'turn_start'],
      ['turn_end', 'turn_end'],
      ['message_start', 'response_start'],
      ['message_update', 'response_chunk'],
      ['message_end', 'response_end'],
      ['tool_execution_start', 'tool_call_start'],
      ['tool_execution_update', 'tool_call_update'],
      ['tool_execution_end', 'tool_call_end'],
    ];

    for (const [piType, cortexType] of mappings) {
      it(`maps ${piType} to ${cortexType}`, () => {
        const listener = vi.fn();
        bridge.on(cortexType, listener);

        source.emit({ type: piType as PiEvent['type'] });

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({ type: cortexType }),
        );
      });
    }
  });

  // -----------------------------------------------------------------------
  // turn_end with AgentTextOutput
  // -----------------------------------------------------------------------

  describe('turn_end with working tags', () => {
    it('parses working tags from turn text and includes AgentTextOutput', () => {
      const listener = vi.fn();
      bridge.on('turn_end', listener);

      source.emit({
        type: 'turn_end',
        text: 'Hello! <working>Analysis here.</working> Final answer.',
      });

      expect(listener).toHaveBeenCalledTimes(1);

      const event: CortexEvent = listener.mock.calls[0][0];
      expect(event.textOutput).toBeDefined();
      expect(event.textOutput!.userFacing).toBe('Hello!\nFinal answer.');
      expect(event.textOutput!.working).toBe('Analysis here.');
      expect(event.textOutput!.raw).toBe('Hello! <working>Analysis here.</working> Final answer.');
    });

    it('extracts text from message.content string', () => {
      const listener = vi.fn();
      bridge.on('turn_end', listener);

      source.emit({
        type: 'turn_end',
        message: {
          content: '<working>Reasoning.</working>User-facing text.',
        },
      });

      const event: CortexEvent = listener.mock.calls[0][0];
      expect(event.textOutput).toBeDefined();
      expect(event.textOutput!.userFacing).toBe('User-facing text.');
    });

    it('extracts text from message.content array', () => {
      const listener = vi.fn();
      bridge.on('turn_end', listener);

      source.emit({
        type: 'turn_end',
        message: {
          content: [
            { type: 'text', text: 'Part one. ' },
            { type: 'text', text: 'Part two.' },
          ],
        },
      });

      const event: CortexEvent = listener.mock.calls[0][0];
      expect(event.textOutput).toBeDefined();
      expect(event.textOutput!.userFacing).toBe('Part one. Part two.');
    });

    it('extracts text from result.content string', () => {
      const listener = vi.fn();
      bridge.on('turn_end', listener);

      source.emit({
        type: 'turn_end',
        result: {
          content: 'Result text here.',
        },
      });

      const event: CortexEvent = listener.mock.calls[0][0];
      expect(event.textOutput).toBeDefined();
      expect(event.textOutput!.userFacing).toBe('Result text here.');
    });

    it('handles turn_end with no extractable text', () => {
      const listener = vi.fn();
      bridge.on('turn_end', listener);

      source.emit({
        type: 'turn_end',
        // No text, message, or result properties
      });

      const event: CortexEvent = listener.mock.calls[0][0];
      expect(event.textOutput).toBeUndefined();
    });

    it('does not parse working tags when disabled', () => {
      bridge.setWorkingTagsEnabled(false);

      const listener = vi.fn();
      bridge.on('turn_end', listener);

      source.emit({
        type: 'turn_end',
        text: 'Hello <working>internal</working> world',
      });

      const event: CortexEvent = listener.mock.calls[0][0];
      // When working tags are disabled, textOutput is not set
      expect(event.textOutput).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Listener management
  // -----------------------------------------------------------------------

  describe('listener management', () => {
    it('supports multiple listeners for the same event type', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      bridge.on('session_start', listener1);
      bridge.on('session_start', listener2);

      source.emit({ type: 'agent_start' });

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes individual listeners', () => {
      const listener = vi.fn();
      const unsub = bridge.on('session_start', listener);

      source.emit({ type: 'agent_start' });
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();

      source.emit({ type: 'agent_start' });
      expect(listener).toHaveBeenCalledTimes(1); // Not called again
    });

    it('onAll receives all mapped events', () => {
      const allListener = vi.fn();
      bridge.onAll(allListener);

      source.emit({ type: 'agent_start' });
      source.emit({ type: 'turn_end', text: 'Hello' });
      source.emit({ type: 'agent_end' });

      expect(allListener).toHaveBeenCalledTimes(3);
      expect(allListener.mock.calls[0][0].type).toBe('session_start');
      expect(allListener.mock.calls[1][0].type).toBe('turn_end');
      expect(allListener.mock.calls[2][0].type).toBe('session_end');
    });

    it('onAll unsubscribes correctly', () => {
      const allListener = vi.fn();
      const unsub = bridge.onAll(allListener);

      source.emit({ type: 'agent_start' });
      expect(allListener).toHaveBeenCalledTimes(1);

      unsub();

      source.emit({ type: 'agent_end' });
      expect(allListener).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Wire / Unwire / Destroy
  // -----------------------------------------------------------------------

  describe('lifecycle', () => {
    it('unwire disconnects from the source', () => {
      const listener = vi.fn();
      bridge.on('session_start', listener);

      bridge.unwire();

      source.emit({ type: 'agent_start' });
      expect(listener).not.toHaveBeenCalled();
    });

    it('wire replaces previous connection', () => {
      const listener = vi.fn();
      bridge.on('session_start', listener);

      const source2 = createMockSource();
      bridge.wire(source2);

      // Old source should not trigger events
      source.emit({ type: 'agent_start' });
      expect(listener).not.toHaveBeenCalled();

      // New source should work
      source2.emit({ type: 'agent_start' });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('destroy cleans up all listeners and connection', () => {
      const typeListener = vi.fn();
      const allListener = vi.fn();
      bridge.on('session_start', typeListener);
      bridge.onAll(allListener);

      bridge.destroy();

      source.emit({ type: 'agent_start' });
      expect(typeListener).not.toHaveBeenCalled();
      expect(allListener).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Event data passthrough
  // -----------------------------------------------------------------------

  describe('event data passthrough', () => {
    it('includes original pi event data in the cortex event', () => {
      const listener = vi.fn();
      bridge.on('session_start', listener);

      const piEvent: PiEvent = {
        type: 'agent_start',
        sessionId: 'test-123',
        timestamp: Date.now(),
      };

      source.emit(piEvent);

      const event: CortexEvent = listener.mock.calls[0][0];
      expect(event.data).toBe(piEvent);
    });

    it('passes tool call data through', () => {
      const startListener = vi.fn();
      const endListener = vi.fn();
      bridge.on('tool_call_start', startListener);
      bridge.on('tool_call_end', endListener);

      source.emit({
        type: 'tool_execution_start',
        toolName: 'read',
        args: { path: '/tmp/test.txt' },
      });

      source.emit({
        type: 'tool_execution_end',
        toolName: 'read',
        result: 'file contents here',
      });

      expect(startListener).toHaveBeenCalledTimes(1);
      expect(endListener).toHaveBeenCalledTimes(1);

      const startData = (startListener.mock.calls[0][0] as CortexEvent).data as Record<string, unknown>;
      expect(startData.toolName).toBe('read');
    });
  });

  // -----------------------------------------------------------------------
  // Logger integration
  // -----------------------------------------------------------------------

  describe('logger', () => {
    it('logs error when a type-specific listener throws', () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const loggedBridge = new EventBridge(false, logger);
      const loggedSource = createMockSource();
      loggedBridge.wire(loggedSource);

      const goodListener = vi.fn();
      loggedBridge.on('session_start', () => { throw new Error('boom'); });
      loggedBridge.on('session_start', goodListener);

      loggedSource.emit({ type: 'agent_start' });

      expect(logger.error).toHaveBeenCalledWith(
        '[EventBridge] listener threw',
        expect.objectContaining({ eventType: 'session_start', error: 'boom' }),
      );
      // Subsequent listener still fires
      expect(goodListener).toHaveBeenCalledTimes(1);
    });

    it('logs error when a catch-all listener throws', () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const loggedBridge = new EventBridge(false, logger);
      const loggedSource = createMockSource();
      loggedBridge.wire(loggedSource);

      loggedBridge.onAll(() => { throw new Error('catch-all boom'); });

      loggedSource.emit({ type: 'agent_start' });

      expect(logger.error).toHaveBeenCalledWith(
        '[EventBridge] catch-all listener threw',
        expect.objectContaining({ error: 'catch-all boom' }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Typed payloads
  // -----------------------------------------------------------------------

  describe('typed payloads', () => {
    it('populates payload for tool_call_start', () => {
      const listener = vi.fn();
      bridge.on('tool_call_start', listener);

      source.emit({
        type: 'tool_execution_start',
        toolCallId: 'tc-1',
        toolName: 'Read',
        args: { file_path: '/tmp/test.txt' },
      });

      const event: CortexEvent = listener.mock.calls[0][0];
      expect(event.payload).toEqual({
        toolCallId: 'tc-1',
        toolName: 'Read',
        args: { file_path: '/tmp/test.txt' },
      });
    });

    it('populates payload for tool_call_update', () => {
      const listener = vi.fn();
      bridge.on('tool_call_update', listener);

      source.emit({
        type: 'tool_execution_update',
        toolCallId: 'tc-2',
        toolName: 'Bash',
        args: { command: 'echo hi' },
        partialResult: {
          content: [{ type: 'text', text: 'hi\n' }],
          details: { stdout: 'hi\n', stderr: '', totalLines: 1 },
        },
      });

      const event: CortexEvent = listener.mock.calls[0][0];
      expect(event.payload).toBeDefined();
      expect((event.payload as Record<string, unknown>)['toolCallId']).toBe('tc-2');
      expect((event.payload as Record<string, unknown>)['toolName']).toBe('Bash');
      expect((event.payload as Record<string, unknown>)['partialResult']).toBeDefined();
    });

    it('populates payload for tool_call_end', () => {
      const listener = vi.fn();
      bridge.on('tool_call_end', listener);

      source.emit({
        type: 'tool_execution_end',
        toolCallId: 'tc-3',
        toolName: 'Glob',
        result: {
          content: [{ type: 'text', text: 'file.ts' }],
          details: { totalCount: 1 },
        },
        durationMs: 42,
        isError: false,
      });

      const event: CortexEvent = listener.mock.calls[0][0];
      expect(event.payload).toBeDefined();
      const payload = event.payload as Record<string, unknown>;
      expect(payload['toolCallId']).toBe('tc-3');
      expect(payload['durationMs']).toBe(42);
      expect(payload['isError']).toBe(false);
      expect(payload['error']).toBeUndefined();
    });

    it('includes error in payload for failed tool calls', () => {
      const listener = vi.fn();
      bridge.on('tool_call_end', listener);

      source.emit({
        type: 'tool_execution_end',
        toolCallId: 'tc-4',
        toolName: 'Read',
        result: { content: [], details: {} },
        isError: true,
        error: 'file not found',
      });

      const event: CortexEvent = listener.mock.calls[0][0];
      const payload = event.payload as Record<string, unknown>;
      expect(payload['isError']).toBe(true);
      expect(payload['error']).toBe('file not found');
    });

    it('returns no payload for non-tool events', () => {
      const listener = vi.fn();
      bridge.on('session_start', listener);

      source.emit({ type: 'agent_start' });

      const event: CortexEvent = listener.mock.calls[0][0];
      expect(event.payload).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Child event forwarding
  // -----------------------------------------------------------------------

  describe('forwardFrom', () => {
    it('forwards child events with childTaskId', () => {
      const childBridge = new EventBridge(false);
      const childSource = createMockSource();
      childBridge.wire(childSource);

      const listener = vi.fn();
      bridge.on('tool_call_start', listener);

      bridge.forwardFrom(childBridge, 'sub-agent-1');

      childSource.emit({
        type: 'tool_execution_start',
        toolCallId: 'child-tc-1',
        toolName: 'Grep',
        args: { pattern: 'foo' },
      });

      expect(listener).toHaveBeenCalledTimes(1);
      const event: CortexEvent = listener.mock.calls[0][0];
      expect(event.childTaskId).toBe('sub-agent-1');
      expect(event.payload).toBeDefined();
      expect((event.payload as Record<string, unknown>)['toolName']).toBe('Grep');
    });

    it('parent events have no childTaskId', () => {
      const listener = vi.fn();
      bridge.on('tool_call_start', listener);

      source.emit({
        type: 'tool_execution_start',
        toolCallId: 'parent-tc',
        toolName: 'Read',
        args: {},
      });

      const event: CortexEvent = listener.mock.calls[0][0];
      expect(event.childTaskId).toBeUndefined();
    });

    it('unsubscribe stops forwarding', () => {
      const childBridge = new EventBridge(false);
      const childSource = createMockSource();
      childBridge.wire(childSource);

      const listener = vi.fn();
      bridge.on('tool_call_start', listener);

      const unsub = bridge.forwardFrom(childBridge, 'sub-1');
      childSource.emit({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'X', args: {} });
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      childSource.emit({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'Y', args: {} });
      expect(listener).toHaveBeenCalledTimes(1); // Not called again
    });

    it('forwards all event types from child', () => {
      const childBridge = new EventBridge(false);
      const childSource = createMockSource();
      childBridge.wire(childSource);

      const allListener = vi.fn();
      bridge.onAll(allListener);

      bridge.forwardFrom(childBridge, 'sub-2');

      childSource.emit({ type: 'turn_start' });
      childSource.emit({ type: 'tool_execution_start', toolCallId: '1', toolName: 'A', args: {} });
      childSource.emit({ type: 'tool_execution_end', toolCallId: '1', toolName: 'A', result: {} });

      expect(allListener).toHaveBeenCalledTimes(3);
      for (const call of allListener.mock.calls) {
        expect(call[0].childTaskId).toBe('sub-2');
      }
    });
  });
});
