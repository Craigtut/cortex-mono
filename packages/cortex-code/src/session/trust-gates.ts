/**
 * Trust-on-first-use gates for project-local executable content.
 *
 * A cloned repository can ship `.cortex/mcp.json`, `.cortex/hooks.json` and
 * `.cortex/skills`, each of which runs commands on the user's machine. Global
 * (`~/.cortex`) content is user-authored and always loads; project content
 * loads only once the user has approved that exact content, and is re-gated
 * whenever it changes.
 */

import { SelectList, type SelectItem } from '@earendil-works/pi-tui';
import type { CortexAgent, McpStdioConfig } from '@animus-labs/cortex';
import type { App } from '../tui/app.js';
import { OverlayBox } from '../tui/overlay-box.js';
import { selectListTheme } from '../tui/theme.js';
import { discoverSkills, isProjectSkill, computeProjectSkillsSignature } from '../discovery/skills.js';
import { discoverMcpServers } from '../discovery/mcp.js';
import { checkProjectMcpTrust, trustProjectMcpConfig } from '../discovery/mcp-trust.js';
import { checkProjectTrust, recordProjectTrust } from '../discovery/project-trust.js';
import { loadHookHandlers, readProjectHooksContent, hasProjectHooks } from '../hooks/loader.js';
import type { HookEvent, HookHandler } from '../hooks/types.js';

export type TrustGateAgent = Pick<CortexAgent, 'connectMcpServer' | 'addSkill'>;
export type TrustGateApp = Pick<App, 'tui' | 'transcript'>;

export class ProjectTrustGates {
  constructor(
    private readonly cwd: string,
    private readonly getAgent: () => TrustGateAgent | null,
    private readonly getApp: () => TrustGateApp | null,
  ) {}

  /**
   * Discover and connect MCP servers, applying trust-on-first-use for
   * project-local configs. Global servers (~/.cortex/mcp.json) connect
   * immediately. Project servers require user approval if the config
   * is new or has changed since last approval.
   */
  async connectMcpServers(): Promise<void> {
    const allServers = await discoverMcpServers(this.cwd);
    const globalServers = allServers.filter(s => s.source === 'global');
    const projectServers = allServers.filter(s => s.source === 'project');

    // Global servers are always trusted
    for (const server of globalServers) {
      await this.connectMcpServer(server);
    }

    // No project servers: nothing to trust-check
    if (projectServers.length === 0) return;

    // Check if the project MCP config is trusted
    const trust = await checkProjectMcpTrust(this.cwd);
    if (trust.trusted) {
      for (const server of projectServers) {
        await this.connectMcpServer(server);
      }
      return;
    }

    // Untrusted: prompt the user
    const serverList = projectServers.map(s => `  ${s.name}: ${s.config.command}${s.config.args ? ' ' + s.config.args.join(' ') : ''}`).join('\n');

    await new Promise<void>((resolve) => {
      const items: SelectItem[] = [
        { value: 'trust', label: 'Trust and connect', description: 'Approve these servers' },
        { value: 'skip', label: 'Skip project servers', description: 'Only use global MCP servers' },
      ];

      const list = new SelectList(items, 2, selectListTheme);
      const overlayBox = new OverlayBox(list, 'New Project MCP Servers');
      const handle = this.getApp()!.tui.showOverlay(overlayBox, {
        anchor: 'center',
        width: '60%',
        maxHeight: 12,
      });

      this.getApp()!.transcript.addNotification(
        'MCP Trust Check',
        `This project wants to connect MCP servers:\n${serverList}`,
      );

      list.onSelect = async (item) => {
        handle.hide();
        if (item.value === 'trust') {
          // Record the EXACT config we trust-checked and showed the user, not a
          // fresh read, so a file swapped between prompt and click is not trusted.
          await trustProjectMcpConfig(this.cwd, trust.configContent);
          for (const server of projectServers) {
            await this.connectMcpServer(server);
          }
          this.getApp()!.transcript.addNotification('MCP', `Connected ${projectServers.length} project server(s).`);
        } else {
          this.getApp()!.transcript.addNotification('MCP', 'Skipped project MCP servers.');
        }
        resolve();
      };

      list.onCancel = () => {
        handle.hide();
        this.getApp()!.transcript.addNotification('MCP', 'Skipped project MCP servers.');
        resolve();
      };
    });
  }

  private async connectMcpServer(server: { name: string; config: McpStdioConfig }): Promise<void> {
    try {
      await this.getAgent()!.connectMcpServer(server.name, server.config);
    } catch (err) {
      this.getApp()!.transcript.addNotification(
        'MCP Error',
        `Failed to connect "${server.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Load lifecycle hooks with the project-trust gate applied. Global hooks
   * (~/.cortex/hooks.json) are user-authored and always load. Project hooks
   * (.cortex/hooks.json) run subprocesses, so if the project's hooks are new or
   * changed and the user has not trusted them, we prompt before loading. On
   * decline, only global hooks load and the project's hooks never run.
   */
  async loadHooks(): Promise<Record<HookEvent, HookHandler[]>> {
    const handlers = await loadHookHandlers(this.cwd);

    // Nothing project-local to gate: return as-is (global-only or empty).
    if (!hasProjectHooks(handlers)) return handlers;

    const content = await readProjectHooksContent(this.cwd);
    if (await checkProjectTrust(this.cwd, 'hooks', content)) return handlers;

    // Untrusted project hooks: prompt before loading them.
    const decision = await this.promptProjectContentTrust(
      'New Project Hooks',
      'This project defines lifecycle hooks in .cortex/hooks.json that run\n' +
        'commands on your machine. Trust and load them?',
    );
    if (decision === 'trust' && content !== null) {
      await recordProjectTrust(this.cwd, 'hooks', content);
      this.getApp()!.transcript.addNotification('Hooks', 'Loaded project hooks.');
      return handlers;
    }

    this.getApp()!.transcript.addNotification('Hooks', 'Skipped project hooks (untrusted).');
    // Reload global-only so declined project hooks are absent, not just inert.
    return loadHookHandlers(this.cwd, { includeProject: false });
  }

  /**
   * Register discovered skills with the project-trust gate applied. Global
   * skills always register. Project skills (.cortex/skills) can run shell on
   * load, so if they are new or changed and untrusted, we prompt before
   * registering them. On decline, project skills are not registered and so are
   * never model-invocable.
   */
  async registerSkills(): Promise<void> {
    const agent = this.getAgent();
    if (!agent) return;
    // Through the facade's addSkill(), not getSkillRegistry().addSkill():
    // the facade owns which loops a skill lands on, and reaching past it
    // registers on whatever loop the getter happens to return today.
    const skills = await discoverSkills(this.cwd);

    const globalSkills = skills.filter((s) => !isProjectSkill(s));
    const projectSkills = skills.filter(isProjectSkill);
    for (const skill of globalSkills) agent.addSkill(skill);

    if (projectSkills.length === 0) return;

    const signature = await computeProjectSkillsSignature(skills);
    if (await checkProjectTrust(this.cwd, 'skills', signature)) {
      for (const skill of projectSkills) agent.addSkill(skill);
      return;
    }

    const decision = await this.promptProjectContentTrust(
      'New Project Skills',
      `This project defines ${projectSkills.length} skill(s) in .cortex/skills that can\n` +
        'run shell commands when loaded. Trust and register them?',
    );
    if (decision === 'trust' && signature !== null) {
      await recordProjectTrust(this.cwd, 'skills', signature);
      for (const skill of projectSkills) agent.addSkill(skill);
      this.getApp()!.transcript.addNotification('Skills', `Registered ${projectSkills.length} project skill(s).`);
      return;
    }

    this.getApp()!.transcript.addNotification('Skills', 'Skipped project skills (untrusted).');
  }

  /**
   * Show a two-option trust overlay for project-local executable content
   * (hooks or skills), mirroring the MCP trust prompt. Returns 'skip' if the
   * user declines, cancels, or the TUI is unavailable.
   */
  private async promptProjectContentTrust(
    title: string,
    message: string,
  ): Promise<'trust' | 'skip'> {
    if (!this.getApp()) return 'skip';
    return new Promise<'trust' | 'skip'>((resolve) => {
      const items: SelectItem[] = [
        { value: 'trust', label: 'Trust and load', description: 'Approve this project content' },
        { value: 'skip', label: 'Skip', description: 'Leave it inert for this project' },
      ];
      const list = new SelectList(items, 2, selectListTheme);
      const overlayBox = new OverlayBox(list, title);
      const handle = this.getApp()!.tui.showOverlay(overlayBox, {
        anchor: 'center',
        width: '60%',
        maxHeight: 12,
      });
      this.getApp()!.transcript.addNotification(title, message);
      list.onSelect = (item) => {
        handle.hide();
        resolve(item.value === 'trust' ? 'trust' : 'skip');
      };
      list.onCancel = () => {
        handle.hide();
        resolve('skip');
      };
    });
  }

  /**
   * Prompt the user to trust a new/changed project MCP config during a
   * watcher-driven reload. Mirrors the startup overlay in
   * `connectMcpServers`. Returns 'skip' if the user declines or
   * dismisses the overlay.
   */
  async resolveProjectMcpTrust(cwd: string, serverNames: string[]): Promise<'trust' | 'skip'> {
    if (!this.getApp()) return 'skip';
    void cwd;
    return await new Promise<'trust' | 'skip'>((resolve) => {
      const items: SelectItem[] = [
        { value: 'trust', label: 'Trust and connect', description: 'Approve project MCP servers' },
        { value: 'skip', label: 'Skip', description: 'Keep using global servers only' },
      ];
      const list = new SelectList(items, 2, selectListTheme);
      const overlayBox = new OverlayBox(list, 'Project MCP Servers Changed');
      const handle = this.getApp()!.tui.showOverlay(overlayBox, {
        anchor: 'center',
        width: '60%',
        maxHeight: 12,
      });
      this.getApp()!.transcript.addNotification(
        'MCP Trust Check',
        `Approve new/changed project MCP servers?\n${serverNames.map(n => `  ${n}`).join('\n')}`,
      );
      list.onSelect = (item) => {
        handle.hide();
        resolve(item.value === 'trust' ? 'trust' : 'skip');
      };
      list.onCancel = () => {
        handle.hide();
        resolve('skip');
      };
    });
  }
}
