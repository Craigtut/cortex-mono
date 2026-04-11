import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObservationalMemoryEngine } from '../../../../src/compaction/observational/index.js';
import {
  OBSERVATION_CONTEXT_PREAMBLE,
  OBSERVATION_RECALL_INSTRUCTIONS,
} from '../../../../src/compaction/observational/constants.js';
import type { CompleteFn } from '../../../../src/compaction/compaction.js';
import type { AgentMessage } from '../../../../src/context-manager.js';
import type {
  ObservationalMemoryState,
  ObservationEvent,
  ReflectionEvent,
} from '../../../../src/compaction/observational/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userMsg = (content: string): AgentMessage => ({ role: 'user', content });
const assistantMsg = (content: string): AgentMessage => ({ role: 'assistant', content });

const OBSERVER_OUTPUT =
  '<observations>\nDate: Apr 10, 2026\n\n* \u{1F7E1} (14:30) Test observation\n</observations>\n\n' +
  '<current-task>\n- Primary: Testing\n</current-task>\n\n' +
  '<suggested-response>\nContinue testing.\n</suggested-response>';

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests: Constructor
// ---------------------------------------------------------------------------

describe('ObservationalMemoryEngine', () => {
  describe('constructor', () => {
    it('merges partial config with defaults', () => {
      const engine = new ObservationalMemoryEngine(
        { activationThreshold: 0.85 },
        0,
      );

      // Verify the engine works with merged config by checking slot content
      const slot = engine.buildSlotContent();
      expect(slot).toContain(OBSERVATION_CONTEXT_PREAMBLE);
    });

    it('works with empty config', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const slot = engine.buildSlotContent();
      expect(slot).toContain(OBSERVATION_CONTEXT_PREAMBLE);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: buildSlotContent
  // -------------------------------------------------------------------------

  describe('buildSlotContent', () => {
    it('includes preamble and empty observations', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const slot = engine.buildSlotContent();

      expect(slot).toContain(OBSERVATION_CONTEXT_PREAMBLE);
      expect(slot).toContain('<observations>');
      expect(slot).toContain('</observations>');
    });

    it('includes recall instructions when recall is configured', () => {
      const engine = new ObservationalMemoryEngine(
        {
          recall: {
            search: vi.fn().mockResolvedValue([]),
          },
        },
        0,
      );

      const slot = engine.buildSlotContent();
      expect(slot).toContain(OBSERVATION_RECALL_INSTRUCTIONS);
    });

    it('excludes recall instructions when recall is not configured', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const slot = engine.buildSlotContent();
      expect(slot).not.toContain('Recall Tool');
    });

    it('includes continuation hints when present', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);

      // Trigger observation to set continuation hints
      await engine.triggerObservation([userMsg('Hello')], 0);

      const slot = engine.buildSlotContent();
      expect(slot).toContain('<current-task>');
      expect(slot).toContain('Testing');
      expect(slot).toContain('<suggested-response>');
      expect(slot).toContain('Continue testing');
    });

    it('includes observations after they are generated', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);

      await engine.triggerObservation([userMsg('Hello')], 0);

      const slot = engine.buildSlotContent();
      expect(slot).toContain('Test observation');
    });
  });

  // -------------------------------------------------------------------------
  // Tests: getState / restoreState
  // -------------------------------------------------------------------------

  describe('getState / restoreState', () => {
    it('returns initial empty state', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const state = engine.getState();

      expect(state.observations).toBe('');
      expect(state.continuationHint).toBeNull();
      expect(state.observationTokenCount).toBe(0);
      expect(state.generationCount).toBe(0);
      expect(state.bufferedChunks).toEqual([]);
    });

    it('round-trips state through save and restore', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);

      await engine.triggerObservation([userMsg('Hello')], 0);
      const savedState = engine.getState();

      // Create a new engine and restore state
      const newEngine = new ObservationalMemoryEngine({}, 0);
      newEngine.restoreState(savedState);

      const restoredState = newEngine.getState();
      expect(restoredState.observations).toBe(savedState.observations);
      expect(restoredState.continuationHint).toEqual(savedState.continuationHint);
      expect(restoredState.observationTokenCount).toBe(savedState.observationTokenCount);
      expect(restoredState.generationCount).toBe(savedState.generationCount);
    });

    it('restored engine produces same slot content', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);

      await engine.triggerObservation([userMsg('Hello')], 0);
      const originalSlot = engine.getSlotContent();
      const savedState = engine.getState();

      const newEngine = new ObservationalMemoryEngine({}, 0);
      newEngine.restoreState(savedState);

      expect(newEngine.getSlotContent()).toBe(originalSlot);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: onObservation / onReflection handlers
  // -------------------------------------------------------------------------

  describe('onObservation / onReflection', () => {
    it('fires observation handler with correct payload on triggerObservation', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);

      const handler = vi.fn();
      engine.onObservation(handler);

      await engine.triggerObservation([userMsg('Hello'), assistantMsg('Hi')], 0);

      expect(handler).toHaveBeenCalledOnce();
      const event: ObservationEvent = handler.mock.calls[0]![0];
      expect(event.compactedMessages.length).toBe(2);
      expect(event.observations).toContain('Test observation');
      expect(event.sync).toBe(true);
      expect(event.timestamp).toBeInstanceOf(Date);
    });

    it('supports multiple observation handlers', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      engine.onObservation(handler1);
      engine.onObservation(handler2);

      await engine.triggerObservation([userMsg('Hello')], 0);

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it('isolates handler errors so one does not break others', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);
      engine.setLogger({ warn: vi.fn(), info: vi.fn() });

      const throwingHandler = vi.fn(() => { throw new Error('handler error'); });
      const goodHandler = vi.fn();
      engine.onObservation(throwingHandler);
      engine.onObservation(goodHandler);

      await engine.triggerObservation([userMsg('Hello')], 0);

      expect(throwingHandler).toHaveBeenCalledOnce();
      expect(goodHandler).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Tests: onTurnEnd
  // -------------------------------------------------------------------------

  describe('onTurnEnd', () => {
    let engine: ObservationalMemoryEngine;
    let mockComplete: ReturnType<typeof vi.fn<CompleteFn>>;

    beforeEach(() => {
      engine = new ObservationalMemoryEngine({
        activationThreshold: 0.9,
        bufferMinTokens: 1_000,
        bufferTargetCycles: 4,
        bufferTokenCap: 30_000,
      }, 0);

      mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);
      engine.setContextWindow(100_000);
      engine.setUtilityModelContextWindow(200_000);
    });

    it('triggers buffer when unobserved tokens exceed interval', () => {
      // Current utilization: 50000/100000 = 50%
      // Tokens until activation: (0.9 - 0.5) * 100000 = 40000
      // Buffer interval: 40000 / 4 = 10000 (within cap and above floor)
      // Need messages with more than 10000 tokens
      const largeMsg = userMsg('x'.repeat(50_000)); // ~12500 tokens
      engine.onTurnEnd(50_000, 100_000, [largeMsg], 0);

      expect(mockComplete).toHaveBeenCalled();
    });

    it('does not trigger when unobserved tokens are below interval', () => {
      // With small messages, tokens will be below the buffer interval
      const smallMsg = userMsg('hello');
      engine.onTurnEnd(50_000, 100_000, [smallMsg], 0);

      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('does not trigger when already past activation threshold', () => {
      // Utilization = 95000/100000 = 95%, above 90% threshold
      const msg = userMsg('x'.repeat(50_000));
      engine.onTurnEnd(95_000, 100_000, [msg], 0);

      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('does not trigger when contextWindow is 0', () => {
      const msg = userMsg('x'.repeat(50_000));
      engine.onTurnEnd(50_000, 0, [msg], 0);

      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('does not trigger when completeFn is not set', () => {
      const noCompleteEngine = new ObservationalMemoryEngine({}, 0);
      noCompleteEngine.setContextWindow(100_000);
      noCompleteEngine.setUtilityModelContextWindow(200_000);

      const msg = userMsg('x'.repeat(50_000));
      noCompleteEngine.onTurnEnd(50_000, 100_000, [msg], 0);

      // No error should be thrown, just silently skips
    });
  });

  // -------------------------------------------------------------------------
  // Tests: misc
  // -------------------------------------------------------------------------

  describe('miscellaneous', () => {
    it('hasRecall returns false when not configured', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      expect(engine.hasRecall()).toBe(false);
    });

    it('hasRecall returns true when configured', () => {
      const engine = new ObservationalMemoryEngine({
        recall: { search: vi.fn().mockResolvedValue([]) },
      }, 0);
      expect(engine.hasRecall()).toBe(true);
    });

    it('getRecallConfig returns the config when provided', () => {
      const search = vi.fn().mockResolvedValue([]);
      const engine = new ObservationalMemoryEngine({
        recall: { search },
      }, 0);

      const config = engine.getRecallConfig();
      expect(config).toBeDefined();
      expect(config!.search).toBe(search);
    });

    it('getRecallConfig returns undefined when not configured', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      expect(engine.getRecallConfig()).toBeUndefined();
    });

    it('abort does not throw', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      expect(() => engine.abort()).not.toThrow();
    });

    it('getObservations returns empty string initially', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      expect(engine.getObservations()).toBe('');
    });

    it('getObservations returns observations after trigger', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);

      await engine.triggerObservation([userMsg('Hello')], 0);
      expect(engine.getObservations()).toContain('Test observation');
    });

    it('triggerObservation does nothing when completeFn is not set', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      await engine.triggerObservation([userMsg('Hello')], 0);
      expect(engine.getObservations()).toBe('');
    });

    it('triggerObservation does nothing with empty messages', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>();
      engine.setCompleteFn(mockComplete);

      await engine.triggerObservation([], 0);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('appends observations on subsequent triggers', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      let callCount = 0;
      const mockComplete = vi.fn<CompleteFn>().mockImplementation(async () => {
        callCount++;
        return `<observations>\nObservation batch ${callCount}\n</observations>`;
      });
      engine.setCompleteFn(mockComplete);

      await engine.triggerObservation([userMsg('First')], 0);
      await engine.triggerObservation([userMsg('Second')], 0);

      const observations = engine.getObservations();
      expect(observations).toContain('Observation batch 1');
      expect(observations).toContain('Observation batch 2');
    });
  });
});
