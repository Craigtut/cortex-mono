import { basename } from 'node:path';
import { SelectList, type SelectItem } from '@mariozechner/pi-tui';
import type { Command } from './index.js';
import { listSessions, type SessionMeta } from '../persistence/sessions.js';
import { selectListTheme } from '../tui/theme.js';
import { OverlayBox } from '../tui/overlay-box.js';
import { findProjectRoot } from '../utils/project-root.js';

function buildItems(sessions: SessionMeta[]): SelectItem[] {
  return sessions.slice(0, 20).map(s => {
    const date = new Date(s.updatedAt).toLocaleDateString();
    const time = new Date(s.updatedAt).toLocaleTimeString();
    const project = basename(s.cwd) || s.cwd;
    return {
      value: s.id,
      label: `${project} · ${s.mode} - ${s.model}`,
      description: `${date} ${time} (${(s.contextTokenCount / 1000).toFixed(1)}k context tokens)`,
    };
  });
}

async function openResumeDialog(
  session: { getApp: () => { transcript: { addNotification: (t: string, m: string) => void }; tui: { showOverlay: (box: unknown, opts: unknown) => { hide: () => void } } } | null; resume: (id: string) => Promise<void> },
  sessions: SessionMeta[],
  title: string,
): Promise<void> {
  const app = session.getApp();
  if (!app) return;

  const items = buildItems(sessions);
  const list = new SelectList(items, Math.min(items.length, 10), selectListTheme);
  const overlayBox = new OverlayBox(list, title);
  const handle = app.tui.showOverlay(overlayBox, {
    anchor: 'center',
    width: '70%',
    maxHeight: 16,
  });

  list.onSelect = async (item) => {
    handle.hide();
    await session.resume(item.value);
  };
  list.onCancel = () => {
    handle.hide();
  };
}

export const resumeCommand: Command = {
  name: 'resume',
  description: 'Resume a previous session in this project',
  handler: async (session) => {
    const app = session.getApp();
    if (!app) return;

    const all = await listSessions();
    if (all.length === 0) {
      app.transcript.addNotification('Resume', 'No previous sessions found.');
      return;
    }

    const currentRoot = findProjectRoot(session.getCwd());
    const scoped = all.filter(s => findProjectRoot(s.cwd) === currentRoot);

    if (scoped.length === 0) {
      app.transcript.addNotification(
        'Resume',
        'No sessions for this project. Use /resume-all to see sessions from every project.',
      );
      return;
    }

    await openResumeDialog(session, scoped, 'Resume Session (this project)');
  },
};

export const resumeAllCommand: Command = {
  name: 'resume-all',
  description: 'Resume a previous session from any project',
  handler: async (session) => {
    const app = session.getApp();
    if (!app) return;

    const sessions = await listSessions();
    if (sessions.length === 0) {
      app.transcript.addNotification('Resume', 'No previous sessions found.');
      return;
    }

    await openResumeDialog(session, sessions, 'Resume Session (all projects)');
  },
};
