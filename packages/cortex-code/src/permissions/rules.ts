import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { extractPattern } from './patterns.js';

export type PermissionDecision = 'allow' | 'deny';
export type RuleScope = 'session' | 'project' | 'user';

export interface PermissionRule {
  toolName: string;
  pattern: string;
  decision: PermissionDecision;
}

interface SettingsFile {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
}

/**
 * Match a glob-like pattern against a string.
 * Supports only trailing wildcards: "git *" matches "git push origin main".
 */
function matchPattern(pattern: string, value: string): boolean {
  if (!pattern) return true; // Empty pattern = tool-wide match

  if (pattern.endsWith(' *')) {
    const prefix = pattern.slice(0, -1); // Include the trailing space
    return value.startsWith(prefix);
  }

  if (pattern.endsWith('/*')) {
    const dirPrefix = pattern.slice(0, -1); // "src/auth/" from "src/auth/*"
    return value.startsWith(dirPrefix);
  }

  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
  }

  return value === pattern;
}

function parseRuleString(rule: string): { toolName: string; pattern: string } {
  const parenIdx = rule.indexOf('(');
  if (parenIdx === -1) {
    return { toolName: rule, pattern: '' };
  }
  const toolName = rule.slice(0, parenIdx);
  const pattern = rule.slice(parenIdx + 1, -1); // Strip parens
  return { toolName, pattern };
}

function ruleToString(toolName: string, pattern: string): string {
  if (!pattern) return toolName;
  return `${toolName}(${pattern})`;
}

function getMatchValue(toolName: string, toolArgs: unknown): string {
  const args = toolArgs as Record<string, unknown>;
  switch (toolName) {
    case 'Bash':
      return String(args['command'] ?? '');
    case 'Edit':
    case 'Write':
    case 'Read':
      return String(args['file_path'] ?? args['path'] ?? '');
    case 'Glob':
      return String(args['pattern'] ?? '');
    case 'Grep':
      return String(args['path'] ?? args['pattern'] ?? '');
    case 'WebFetch': {
      const url = String(args['url'] ?? '');
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    }
    default:
      return '';
  }
}

export class PermissionRuleManager {
  private sessionRules: PermissionRule[] = [];
  private projectRules: PermissionRule[] = [];
  private userRules: PermissionRule[] = [];
  private projectSettingsPath: string;
  private userSettingsPath: string;

  constructor(cwd: string) {
    this.projectSettingsPath = join(cwd, '.cortex', 'settings.json');
    this.userSettingsPath = join(homedir(), '.cortex', 'settings.json');
  }

  /** Load persisted rules from project and user settings files. */
  async loadPersistedRules(): Promise<void> {
    this.projectRules = await this.loadRulesFromFile(this.projectSettingsPath);
    this.userRules = await this.loadRulesFromFile(this.userSettingsPath);
  }

  /**
   * Check if a tool call matches any rule.
   * Precedence: session > project > user.
   * Returns the decision if matched, null if no rule applies.
   */
  matchRule(toolName: string, toolArgs: unknown): PermissionDecision | null {
    const value = getMatchValue(toolName, toolArgs);

    // Check in precedence order: session first, then project, then user
    for (const rules of [this.sessionRules, this.projectRules, this.userRules]) {
      // Deny rules take priority within the same scope
      for (const rule of rules) {
        if (rule.toolName === toolName && rule.decision === 'deny' && matchPattern(rule.pattern, value)) {
          return 'deny';
        }
      }
      for (const rule of rules) {
        if (rule.toolName === toolName && rule.decision === 'allow' && matchPattern(rule.pattern, value)) {
          return 'allow';
        }
      }
    }

    return null;
  }

  /** Add a new rule. Session rules are in-memory; project/user are persisted. */
  async addRule(
    scope: RuleScope,
    decision: PermissionDecision,
    toolName: string,
    pattern: string,
  ): Promise<void> {
    const rule: PermissionRule = { toolName, pattern, decision };

    switch (scope) {
      case 'session':
        this.sessionRules.push(rule);
        break;
      case 'project':
        this.projectRules.push(rule);
        await this.persistRules(this.projectSettingsPath, this.projectRules);
        break;
      case 'user':
        this.userRules.push(rule);
        await this.persistRules(this.userSettingsPath, this.userRules);
        break;
    }
  }

  /** Get all rules for display purposes. */
  getAllRules(): { session: PermissionRule[]; project: PermissionRule[]; user: PermissionRule[] } {
    return {
      session: [...this.sessionRules],
      project: [...this.projectRules],
      user: [...this.userRules],
    };
  }

  /** Extract a pattern suggestion for the "always allow" option. */
  suggestPattern(toolName: string, toolArgs: unknown): string {
    return extractPattern(toolName, toolArgs);
  }

  private async loadRulesFromFile(path: string): Promise<PermissionRule[]> {
    try {
      const content = await readFile(path, 'utf-8');
      const settings = JSON.parse(content) as SettingsFile;
      const rules: PermissionRule[] = [];

      for (const ruleStr of settings.permissions?.allow ?? []) {
        const { toolName, pattern } = parseRuleString(ruleStr);
        rules.push({ toolName, pattern, decision: 'allow' });
      }
      for (const ruleStr of settings.permissions?.deny ?? []) {
        const { toolName, pattern } = parseRuleString(ruleStr);
        rules.push({ toolName, pattern, decision: 'deny' });
      }

      return rules;
    } catch {
      return [];
    }
  }

  private async persistRules(path: string, rules: PermissionRule[]): Promise<void> {
    let settings: SettingsFile;
    try {
      const content = await readFile(path, 'utf-8');
      settings = JSON.parse(content) as SettingsFile;
    } catch {
      settings = {};
    }

    settings.permissions = {
      allow: rules
        .filter(r => r.decision === 'allow')
        .map(r => ruleToString(r.toolName, r.pattern)),
      deny: rules
        .filter(r => r.decision === 'deny')
        .map(r => ruleToString(r.toolName, r.pattern)),
    };

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(settings, null, 2), { mode: 0o600 });
  }
}
