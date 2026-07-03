/**
 * Security regression tests for skill loading:
 *  - model-controlled load_skill arguments cannot inject shell (C-4),
 *  - a catastrophic command in a skill is hard-blocked by the framework floor,
 *  - Cortex built-in variables win over consumer/plugin variables (merge order).
 *
 * These exercise the real SkillRegistry.getSkillBody path, which is exactly how
 * a model-issued load_skill(name, arguments) reaches the preprocessor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillRegistry } from '../../src/skill-registry.js';

let skillsRoot: string;

beforeEach(() => {
  skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-injection-test-'));
});

afterEach(() => {
  fs.rmSync(skillsRoot, { recursive: true, force: true });
});

/** Write a SKILL.md into its own directory and return the file path. */
function writeSkill(name: string, body: string): string {
  const dir = path.join(skillsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: test skill\n---\n${body}\n`);
  return file;
}

describe('skill argument shell injection (C-4)', () => {
  it('does not let load_skill arguments inject a shell command', async () => {
    const sentinel = path.join(skillsRoot, 'INJECTED');
    // Author command references $ARGUMENTS on its own line (markers are
    // line-anchored). If the value were spliced in as shell syntax, the
    // `; touch` would run and create the sentinel.
    const registry = new SkillRegistry([
      { path: writeSkill('greet', '!`echo $ARGUMENTS`'), source: 'user' },
    ]);

    const attacker = `hi; touch ${sentinel}`;
    const body = await registry.getSkillBody('greet', {
      args: attacker.split(/\s+/),
      rawArgs: attacker,
    });

    // The injected command must NOT have run.
    expect(fs.existsSync(sentinel)).toBe(false);
    // The payload survives as inert, quoted text in echo's output.
    expect(body).toContain(`touch ${sentinel}`);
  });

  it('does not let a literal $N inside the argument value re-substitute and break quoting', async () => {
    // Regression for the multi-pass re-scan bypass: the argument value itself
    // contains a `$1`. A per-class multi-pass substituter would replace that
    // `$1` (now sitting inside the quotes produced for $ARGUMENTS) on a later
    // pass, splicing a balanced '...' into the middle and exposing live syntax
    // (`;id>SENTINEL` running as a real command). Single-pass leaves it inert.
    const sentinel = path.join(skillsRoot, 'PWNED');
    const registry = new SkillRegistry([
      { path: writeSkill('greet2', '!`echo $ARGUMENTS`'), source: 'user' },
    ]);

    const attacker = `;id>${sentinel} $1`;
    const body = await registry.getSkillBody('greet2', {
      args: attacker.split(/\s+/),
      rawArgs: attacker,
    });

    expect(fs.existsSync(sentinel)).toBe(false);
    // The whole payload, including the literal `$1`, survives as inert text.
    expect(body).toContain('$1');
  });

  it('does not let the classic "; touch /tmp/x #" payload escape quoting', async () => {
    const sentinel = path.join(skillsRoot, 'X');
    const registry = new SkillRegistry([
      { path: writeSkill('run', '!`echo start $1`'), source: 'user' },
    ]);

    const payload = `; touch ${sentinel} #`;
    const body = await registry.getSkillBody('run', {
      args: [payload],
      rawArgs: payload,
    });

    expect(fs.existsSync(sentinel)).toBe(false);
    expect(body).toContain('start');
  });
});

describe('catastrophic command in a skill is hard-blocked', () => {
  it('blocks a hardcoded catastrophic command and never runs it', async () => {
    const registry = new SkillRegistry([
      { path: writeSkill('wipe', '!`rm -rf /`'), source: 'user' },
    ]);

    const body = await registry.getSkillBody('wipe', { args: [], rawArgs: '' });

    expect(body).toContain('catastrophic-command floor');
    // The block reason is surfaced instead of any command output.
    expect(body).not.toContain('No such file');
  });

  it('blocks when an argument resolves the target to the filesystem root', async () => {
    const registry = new SkillRegistry([
      { path: writeSkill('wipe-arg', '!`rm -rf $1`'), source: 'user' },
    ]);

    const body = await registry.getSkillBody('wipe-arg', { args: ['/'], rawArgs: '/' });

    expect(body).toContain('catastrophic-command floor');
  });
});

describe('variable merge order: Cortex built-ins win', () => {
  it('built-in ARGUMENTS / SKILL_DIR / positional override consumer variables', async () => {
    const file = writeSkill('vars', 'A=$ARGUMENTS D=${SKILL_DIR} P=$1');
    const registry = new SkillRegistry([{ path: file, source: 'user' }]);

    // A malicious/careless consumer tries to shadow the real call arguments.
    registry.setPreprocessorVariables({
      ARGUMENTS: 'CONSUMER_ARGS',
      SKILL_DIR: '/evil',
      '1': 'CONSUMER_1',
    });

    const body = await registry.getSkillBody('vars', {
      args: ['real1', 'real2'],
      rawArgs: 'real1 real2',
    });

    expect(body).toContain('A=real1 real2');
    expect(body).toContain(`D=${path.dirname(file)}`);
    expect(body).toContain('P=real1');
    expect(body).not.toContain('CONSUMER');
    expect(body).not.toContain('/evil');
  });
});
