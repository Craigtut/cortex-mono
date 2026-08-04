/**
 * Fan-out context manager view for the duplex facade (decisions.md D6).
 *
 * D6 forbids exposing the talker/reasoner split through any per-slot
 * routing knob: consumer slots apply to both loops, and that covers
 * mid-session writes, not only construction. 2b-i wired initial slots to
 * both loops but getContextManager() returned the reasoner's manager, so a
 * consumer updating a persona slot mid-session silently diverged the two
 * loops. This view closes that: writes reach both loops, reads come from
 * the reasoner.
 *
 * Internal slots (underscore-prefixed: '_observations',
 * '_available_tools') are NOT fanned out. Each loop owns its own internal
 * slot content (the talker's observations are not the reasoner's), so a
 * write to one lands only on the primary (reasoner) manager, exactly as a
 * direct AgentLoop consumer would see.
 *
 * Extends ContextManager so the facade's getContextManager() keeps its
 * type; the base state is a detached dummy and every public member is
 * overridden to delegate.
 */

import { ContextManager } from '../context-manager.js';
import type { AgentContext } from '../context-manager.js';

/** Cortex-internal slot names are never fanned out to the mirror loop. */
function isInternalSlot(name: string): boolean {
  return name.startsWith('_');
}

export class FanOutContextManager extends ContextManager {
  private readonly readManager: ContextManager;
  private readonly mirrorManager: ContextManager;

  /**
   * @param readManager - The reasoner's manager: reads and primary writes.
   * @param mirrorManager - The talker's manager: consumer-slot writes are
   *   mirrored here so the loops never diverge.
   */
  constructor(readManager: ContextManager, mirrorManager: ContextManager) {
    // The base class needs an accessor and a slot list; both are inert
    // here (every member below delegates), but the slot list is kept
    // accurate so anything reading the base's frozen copy stays truthful.
    super({ state: { messages: [] } }, { slots: [...readManager.slots] });
    this.readManager = readManager;
    this.mirrorManager = mirrorManager;
  }

  override get slotCount(): number {
    return this.readManager.slotCount;
  }

  override get slots(): readonly string[] {
    return this.readManager.slots;
  }

  /**
   * Write a slot on both loops (consumer slots) or the reasoner only
   * (internal slots). The reasoner write runs first: it validates the slot
   * name, so an unknown name throws before either loop is touched.
   */
  override setSlot(name: string, content: string): void {
    this.readManager.setSlot(name, content);
    if (!isInternalSlot(name)) {
      this.mirrorManager.setSlot(name, content);
    }
  }

  override getSlot(name: string): string | null {
    return this.readManager.getSlot(name);
  }

  /** Ephemeral content is a write too: it reaches both loops. */
  override setEphemeral(content: string | null): void {
    this.readManager.setEphemeral(content);
    this.mirrorManager.setEphemeral(content);
  }

  override getEphemeral(): string | null {
    return this.readManager.getEphemeral();
  }

  override getTransformContextHook(): (context: AgentContext) => AgentContext {
    return this.readManager.getTransformContextHook();
  }
}
