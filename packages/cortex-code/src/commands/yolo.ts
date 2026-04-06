import { SelectList, type SelectItem } from '@mariozechner/pi-tui';
import type { Command } from './index.js';
import { selectListTheme, colors } from '../tui/theme.js';
import { OverlayBox } from '../tui/overlay-box.js';

export const yoloCommand: Command = {
  name: 'yolo',
  description: 'Toggle YOLO mode (bypass permissions)',
  handler: (session) => {
    const app = session.getApp();
    if (!app) return;

    const currentMode = session.getYoloMode();

    if (!currentMode) {
      // First activation: show confirmation
      const items: SelectItem[] = [
        { value: 'enable', label: 'Enable YOLO mode', description: 'All tools auto-approved' },
        { value: 'cancel', label: 'Cancel' },
      ];

      const list = new SelectList(items, 2, selectListTheme);
      const overlayBox = new OverlayBox(list, 'YOLO Mode');
      const handle = app.tui.showOverlay(overlayBox, {
        anchor: 'center',
        width: '50%',
        maxHeight: 8,
      });

      list.onSelect = (item) => {
        handle.hide();
        if (item.value === 'enable') {
          session.setYoloMode(true);
          app.transcript.addNotification('YOLO Mode', 'Enabled. All tool calls will be auto-approved.\nNote: Tool-internal safety checks still apply.');
        }
      };

      list.onCancel = () => {
        handle.hide();
      };
    } else {
      // Already enabled: toggle off
      session.setYoloMode(false);
      app.transcript.addNotification('YOLO Mode', 'Disabled. Tool calls will require approval.');
    }
  },
};
