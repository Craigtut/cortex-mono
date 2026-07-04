import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import {
  findCatastrophicCommand,
  isPathSameOrDescendant,
  resolveThroughExistingAncestor,
} from '@animus-labs/cortex';
import { extractPattern } from './patterns.js';
import { isPathWithinRealCwd } from './path-containment.js';
import { splitBashCommand, stripLeadingAssignments, isCompoundBash } from './bash-command.js';

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

interface PermissionRuleManagerOptions {
  configDir?: string;
}

/**
 * Stable per-workspace settings file path (keyed by a hash of the realpathed
 * cwd). Shared by every store that persists workspace-scoped settings (the
 * permission rules and the network domain grants), so they read and write the
 * same file, each owning its own top-level key.
 */
export function workspaceSettingsPath(
  cwd: string,
  configDir: string = join(homedir(), '.cortex'),
): string {
  let realCwd = cwd;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    // Fall back to the provided cwd if the workspace disappears mid-startup.
  }
  const workspaceId = createHash('sha256').update(realCwd).digest('hex');
  return join(configDir, 'workspaces', workspaceId, 'settings.json');
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

/**
 * Match a single (already-split) Bash subcommand against a rule pattern.
 *
 * Prefix patterns ("git commit *") match the subcommand and its arguments but
 * never span a shell operator, so a `git *` rule cannot cover the `rm` half of
 * `git status && rm -rf foo`. Patterns without a wildcard are exact matches.
 */
function matchBashPattern(pattern: string, subcommand: string): boolean {
  if (!pattern) return true; // tool-wide allow/deny

  if (pattern.endsWith(' *')) {
    const prefix = pattern.slice(0, -2); // "git commit"
    if (subcommand === prefix) return true;
    if (!subcommand.startsWith(prefix + ' ')) return false;
    // Defense in depth: a prefix rule may only cover one simple-command.
    return !isCompoundBash(subcommand);
  }

  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return subcommand.startsWith(prefix) && !isCompoundBash(subcommand);
  }

  return subcommand === pattern;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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

/**
 * The directory (or file) a path-based rule pattern is scoped to, with any
 * trailing wildcard stripped. Used to canonicalize the rule's scope so a
 * resolved target can be tested for containment inside it.
 *
 *   "${cwd}/*"     -> "${cwd}"        (whole workspace)
 *   "src/auth/*"   -> "src/auth"      (a subdirectory, relative to cwd)
 *   "*"            -> ""              (workspace root; resolved against cwd)
 *   "/etc/*"       -> "/etc"          (an explicit external directory)
 *   "notes.txt"    -> "notes.txt"     (an exact path)
 */
function patternBaseDir(pattern: string): string {
  if (pattern.endsWith('/*')) return pattern.slice(0, -2);
  if (pattern.endsWith('*')) return pattern.slice(0, -1);
  return pattern;
}

export class PermissionRuleManager {
  private sessionRules: PermissionRule[] = [];
  private projectRules: PermissionRule[] = [];
  private userRules: PermissionRule[] = [];
  private workspaceSettingsPath: string;
  private userSettingsPath: string;
  private readonly cwd: string;

  constructor(cwd: string, options: PermissionRuleManagerOptions = {}) {
    this.cwd = cwd;
    const configDir = options.configDir ?? join(homedir(), '.cortex');
    this.workspaceSettingsPath = workspaceSettingsPath(cwd, configDir);
    this.userSettingsPath = join(configDir, 'settings.json');
  }

  /** Load persisted rules from user-owned workspace and global settings files. */
  async loadPersistedRules(): Promise<void> {
    this.projectRules = await this.loadRulesFromFile(this.workspaceSettingsPath);
    this.userRules = await this.loadRulesFromFile(this.userSettingsPath);
  }

  /**
   * Check if a tool call matches any rule.
   * Precedence: session > project > user.
   * Returns the decision if matched, null if no rule applies.
   *
   * Path-based tools (Edit/Write/Read/Glob/Grep) are matched through real
   * filesystem containment, not a raw string prefix, so a model-authored
   * `..`/symlink path cannot satisfy a workspace-scoped rule and let the
   * tool's own `path.resolve()` complete a traversal. The method is async
   * because that containment check reads the filesystem (realpath).
   */
  async matchRule(toolName: string, toolArgs: unknown): Promise<PermissionDecision | null> {
    // Bash is evaluated per simple-command so a prefix rule cannot auto-approve
    // a second command chained on with && / ; / | etc.
    if (toolName === 'Bash') {
      const args = toolArgs as Record<string, unknown>;
      return this.matchBashCommand(String(args['command'] ?? ''));
    }

    if (toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') {
      const args = toolArgs as Record<string, unknown>;
      return this.matchFilePathRule(toolName, String(args['file_path'] ?? args['path'] ?? ''));
    }

    if (toolName === 'Glob' || toolName === 'Grep') {
      return this.matchSearchRule(toolName, toolArgs);
    }

    return this.matchByValue(toolName, getMatchValue(toolName, toolArgs));
  }

  /** Precedence walk (session > project > user, deny before allow) over a plain string value. */
  private matchByValue(toolName: string, value: string): PermissionDecision | null {
    for (const rules of [this.sessionRules, this.projectRules, this.userRules]) {
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

  /**
   * Match a rule for a file tool (Edit/Write/Read) by containment.
   *
   * The target is resolved to its real absolute path (through `..` and
   * symlinks, via the nearest existing ancestor) and tested for containment
   * inside each rule pattern's canonicalized scope. This means:
   *
   *  - A workspace allow rule (`${cwd}/*`) only fires when the resolved target
   *    genuinely lives inside the workspace, so `${cwd}/../../etc/passwd` and a
   *    workspace symlink pointing outside are both refused (fall through to a
   *    prompt) instead of being auto-approved.
   *  - Legitimate in-workspace paths, absolute or relative to cwd, still match.
   *  - Deny additionally matches the raw, unresolved string, so a workspace
   *    deny still catches a literal `${cwd}/..` escape attempt, and a deny on
   *    an explicit directory still catches a path that resolves into it.
   */
  private async matchFilePathRule(
    toolName: string,
    filePath: string,
  ): Promise<PermissionDecision | null> {
    const resolvedTarget = filePath ? await this.resolveTarget(filePath) : '';

    for (const rules of [this.sessionRules, this.projectRules, this.userRules]) {
      for (const rule of rules) {
        if (rule.toolName !== toolName || rule.decision !== 'deny') continue;
        if (matchPattern(rule.pattern, filePath)) return 'deny';
        if (resolvedTarget && (await this.patternContainsTarget(rule.pattern, resolvedTarget))) {
          return 'deny';
        }
      }
      for (const rule of rules) {
        if (rule.toolName !== toolName || rule.decision !== 'allow') continue;
        // A tool-wide allow (empty pattern, e.g. a hand-written `Edit` with no
        // parens) is a deliberate unscoped grant and intentionally skips
        // containment. suggestPattern never emits an empty pattern for a file
        // tool, so this is not reachable from the "always allow" UI: it only
        // exists when a user authors it explicitly.
        if (!rule.pattern) return 'allow';
        if (resolvedTarget && (await this.patternContainsTarget(rule.pattern, resolvedTarget))) {
          return 'allow';
        }
      }
    }
    return null;
  }

  /**
   * Match a rule for a search tool (Glob/Grep). The rule value is a glob or
   * regex (not a filesystem path), so pattern matching stays string-based, but
   * an allow only fires when the search root resolves inside the workspace.
   * A search rooted outside the workspace falls through to a prompt rather than
   * being auto-approved by a (workspace-oriented) allow rule.
   */
  private async matchSearchRule(
    toolName: string,
    toolArgs: unknown,
  ): Promise<PermissionDecision | null> {
    const args = toolArgs as Record<string, unknown>;
    const value = getMatchValue(toolName, toolArgs);
    const searchRoot = String(args['path'] ?? '');
    // No explicit path means the tool searches the workspace root, which is
    // trivially contained.
    const rootWithinWorkspace = searchRoot ? await isPathWithinRealCwd(searchRoot, this.cwd) : true;

    for (const rules of [this.sessionRules, this.projectRules, this.userRules]) {
      for (const rule of rules) {
        if (rule.toolName === toolName && rule.decision === 'deny' && matchPattern(rule.pattern, value)) {
          return 'deny';
        }
      }
      for (const rule of rules) {
        if (rule.toolName === toolName && rule.decision === 'allow' && matchPattern(rule.pattern, value)) {
          return rootWithinWorkspace ? 'allow' : null;
        }
      }
    }
    return null;
  }

  /** Resolve a tool path argument to its real absolute path (relative paths are cwd-based). */
  private resolveTarget(filePath: string): Promise<string> {
    const absolute = isAbsolute(filePath) ? filePath : resolve(this.cwd, filePath);
    return resolveThroughExistingAncestor(absolute);
  }

  /**
   * True if a resolved absolute target is the same as, or a descendant of, the
   * rule pattern's canonicalized scope. The pattern base is resolved relative
   * to the workspace and realpath-canonicalized so a symlinked workspace root
   * does not produce false negatives for legitimate in-workspace paths.
   */
  private async patternContainsTarget(pattern: string, resolvedTarget: string): Promise<boolean> {
    const baseSpec = patternBaseDir(pattern);
    const baseAbsolute = isAbsolute(baseSpec) ? baseSpec : resolve(this.cwd, baseSpec);
    const resolvedBase = await resolveThroughExistingAncestor(baseAbsolute);
    return isPathSameOrDescendant(resolvedTarget, resolvedBase);
  }

  /**
   * Decide a whole Bash command by evaluating each simple-command separately.
   *
   * - Catastrophic commands (e.g. `rm -rf /`) are denied unconditionally, even
   *   if an allow rule would otherwise match.
   * - A deny on any subcommand denies the whole command.
   * - The command is allowed only if *every* subcommand is allowed.
   * - Otherwise null (prompt).
   */
  private matchBashCommand(command: string): PermissionDecision | null {
    if (findCatastrophicCommand(command, { cwd: this.cwd, home: homedir() })) return 'deny';

    let allAllowed = true;
    for (const sub of splitBashCommand(command)) {
      const decision = this.decideBashSubcommand(sub);
      if (decision === 'deny') return 'deny';
      if (decision !== 'allow') allAllowed = false;
    }
    return allAllowed ? 'allow' : null;
  }

  /** Apply scope precedence (session > project > user, deny before allow) to one subcommand. */
  private decideBashSubcommand(subcommand: string): PermissionDecision | null {
    // Allow matching may only strip *safe* env vars, so `PATH=/evil cmd` can't
    // be normalized to satisfy an allow rule. Deny matching strips all leading
    // assignments, so `FOO=bar denied-cmd` still matches a deny rule.
    const allowCandidates = unique([subcommand, stripLeadingAssignments(subcommand, true)]);
    const denyCandidates = unique([...allowCandidates, stripLeadingAssignments(subcommand, false)]);

    for (const rules of [this.sessionRules, this.projectRules, this.userRules]) {
      for (const rule of rules) {
        if (rule.toolName === 'Bash' && rule.decision === 'deny'
            && denyCandidates.some((c) => matchBashPattern(rule.pattern, c))) {
          return 'deny';
        }
      }
      for (const rule of rules) {
        if (rule.toolName === 'Bash' && rule.decision === 'allow'
            && allowCandidates.some((c) => matchBashPattern(rule.pattern, c))) {
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
        await this.persistRules(this.workspaceSettingsPath, this.projectRules);
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

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(settings, null, 2), { mode: 0o600 });
    await chmod(path, 0o600);
  }
}
