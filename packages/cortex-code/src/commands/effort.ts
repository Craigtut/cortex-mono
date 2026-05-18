import { SelectList, type SelectItem } from '@earendil-works/pi-tui';
import type { Command } from './index.js';
import { selectListTheme } from '../tui/theme.js';
import { OverlayBox } from '../tui/overlay-box.js';
import type { ThinkingLevel } from '@animus-labs/cortex';

const SEPARATOR_VALUE = '_separator';

/** Thinking levels in display order: active levels first, then separator, then Off. */
const THINKING_LEVELS: Array<{ value: ThinkingLevel; label: string; description: string }> = [
  { value: 'minimal', label: 'Minimal', description: 'Lightest reasoning' },
  { value: 'low', label: 'Low', description: 'Light reasoning' },
  { value: 'medium', label: 'Medium', description: 'Balanced (default)' },
  { value: 'high', label: 'High', description: 'Deep reasoning' },
  { value: 'max', label: 'Max', description: 'Maximum reasoning depth' },
];

const OFF_LEVEL = { value: 'off' as ThinkingLevel, label: 'Off', description: 'No extended thinking' };
const THINKING_LEVEL_ORDER: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'max'];

export const effortCommand: Command = {
  name: 'effort',
  description: 'Set thinking effort level',
  handler: async (session) => {
    const agent = session.getAgent();
    const app = session.getApp();
    if (!agent || !app) return;

    // Check model capabilities
    const caps = await agent.getModelThinkingCapabilities();

    if (!caps.supportsThinking) {
      app.transcript.addNotification(
        'Effort',
        `${session.getModelId()} does not support thinking. Switch to a reasoning model first.`,
      );
      return;
    }

    // Build level list based on capabilities
    const supported = new Set(caps.supportedLevels);
    const available = THINKING_LEVEL_ORDER
      .filter(level => supported.has(level))
      .map(level => THINKING_LEVELS.find(item => item.value === level)!)
      .filter(Boolean);

    const current = session.getEffectiveEffort();

    const items: SelectItem[] = available.map(l => ({
      value: l.value,
      label: l.value === current ? `${l.label} \u2190 current` : l.label,
      description: l.description,
    }));

    if (supported.has('off')) {
      if (items.length > 0) {
        items.push({ value: SEPARATOR_VALUE, label: '\u2500'.repeat(20), description: '' });
      }
      items.push({
        value: OFF_LEVEL.value,
        label: current === 'off' ? `${OFF_LEVEL.label} \u2190 current` : OFF_LEVEL.label,
        description: OFF_LEVEL.description,
      });
    }

    if (items.length === 0) {
      app.transcript.addNotification('Effort', `${session.getModelId()} does not expose configurable effort levels.`);
      return;
    }

    const list = new SelectList(items, Math.min(items.length, 10), selectListTheme);

    // Pre-select the current effort level
    const currentIndex = items.findIndex(i => i.value === current);
    if (currentIndex >= 0) {
      list.setSelectedIndex(currentIndex);
    }

    // Skip over the separator when navigating with arrow keys
    const separatorIndex = items.findIndex(i => i.value === SEPARATOR_VALUE);
    let previousIndex = currentIndex >= 0 ? currentIndex : 0;
    list.onSelectionChange = (item) => {
      if (item.value === SEPARATOR_VALUE) {
        if (separatorIndex < 0) return;
        const skipTo = previousIndex < separatorIndex
          ? separatorIndex + 1
          : separatorIndex - 1;
        list.setSelectedIndex(skipTo);
        previousIndex = skipTo;
      } else {
        previousIndex = items.findIndex(i => i.value === item.value);
      }
    };

    const overlayBox = new OverlayBox(list, 'Thinking Effort');
    const handle = app.tui.showOverlay(overlayBox, {
      anchor: 'center',
      width: '50%',
      maxHeight: 14,
    });

    return new Promise<void>((resolve) => {
      list.onSelect = async (item) => {
        // Ignore separator selection
        if (item.value === SEPARATOR_VALUE) return;

        handle.hide();
        app.focusEditor();

        const level = item.value as ThinkingLevel;
        if (level === current) {
          app.transcript.addNotification('Effort', `Already set to ${level}.`);
        } else {
          await session.setPreferredEffort(level);
          // setPreferredEffort handles notification if clamped;
          // only show confirmation when the level was applied as-is
          const effective = session.getEffectiveEffort();
          if (effective === level) {
            app.transcript.addNotification('Effort', `Set to ${level}.`);
          }
        }
        resolve();
      };

      list.onCancel = () => {
        handle.hide();
        app.focusEditor();
        resolve();
      };
    });
  },
};
