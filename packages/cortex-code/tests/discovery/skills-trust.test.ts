/**
 * Trust gating for project skills (C-3). A project skill (.cortex/skills) can
 * run shell on load, so it must not be registered (and therefore not be
 * model-invocable) until the user trusts the project. Exercises the exact
 * composition the Session uses (discoverSkills + isProjectSkill +
 * computeProjectSkillsSignature + project-trust) against a real SkillRegistry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillRegistry } from '@animus-labs/cortex';

let fakeHome: string;
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome };
});

import {
  discoverSkills,
  isProjectSkill,
  computeProjectSkillsSignature,
} from '../../src/discovery/skills.js';
import { checkProjectTrust, recordProjectTrust } from '../../src/discovery/project-trust.js';

let cwd: string;

function writeProjectSkill(name: string, body: string): void {
  const dir = path.join(cwd, '.cortex', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`,
  );
}

/** Mirror of Session.registerSkillsWithTrust for a given trust outcome. */
async function registerWithTrust(trusted: boolean): Promise<SkillRegistry> {
  const registry = new SkillRegistry();
  const skills = await discoverSkills(cwd);
  for (const s of skills.filter((x) => !isProjectSkill(x))) registry.addSkill(s);
  if (trusted) {
    for (const s of skills.filter(isProjectSkill)) registry.addSkill(s);
  }
  return registry;
}

beforeEach(() => {
  // Empty fake home so there are no global skills and the trust store is isolated.
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-trust-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-trust-proj-'));
  writeProjectSkill('evil', '!`echo pwned`');
});

afterEach(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('project skills trust gate', () => {
  it('discovers the project skill and reports it untrusted on first sight', async () => {
    const skills = await discoverSkills(cwd);
    const project = skills.filter(isProjectSkill);
    expect(project).toHaveLength(1);
    expect(project[0]?.source).toBe('project:evil');

    const signature = await computeProjectSkillsSignature(skills);
    expect(signature).not.toBeNull();
    expect(await checkProjectTrust(cwd, 'skills', signature)).toBe(false);
  });

  it('does not register an untrusted project skill (not model-invocable)', async () => {
    const registry = await registerWithTrust(false);
    // The skill is neither present nor advertised to the model.
    expect(registry.getEntry('evil')).toBeNull();
    expect(registry.getAvailableSkillsSummary()).not.toContain('evil');
  });

  it('registers the project skill once trusted', async () => {
    const skills = await discoverSkills(cwd);
    const signature = await computeProjectSkillsSignature(skills);
    await recordProjectTrust(cwd, 'skills', signature!);
    expect(await checkProjectTrust(cwd, 'skills', signature)).toBe(true);

    const registry = await registerWithTrust(true);
    expect(registry.getEntry('evil')).not.toBeNull();
    expect(registry.getAvailableSkillsSummary()).toContain('evil');
  });

  it('re-flags skills after a SKILL.md edit (trust does not carry over)', async () => {
    const skills = await discoverSkills(cwd);
    const signature = await computeProjectSkillsSignature(skills);
    await recordProjectTrust(cwd, 'skills', signature!);
    expect(await checkProjectTrust(cwd, 'skills', signature)).toBe(true);

    // Edit the skill body: the signature changes, so trust is revoked.
    writeProjectSkill('evil', '!`echo now-malicious`');
    const after = await computeProjectSkillsSignature(await discoverSkills(cwd));
    expect(await checkProjectTrust(cwd, 'skills', after)).toBe(false);
  });

  it('re-flags when a non-SKILL.md helper file changes (SKILL.md untouched)', async () => {
    // A skill body can run !{script: helper.mjs}. The signature must cover the
    // whole skill dir, so editing helper.mjs alone still revokes trust.
    const helper = path.join(cwd, '.cortex', 'skills', 'evil', 'helper.mjs');
    fs.writeFileSync(helper, 'export default async () => "safe";\n');

    const signature = await computeProjectSkillsSignature(await discoverSkills(cwd));
    await recordProjectTrust(cwd, 'skills', signature!);
    expect(await checkProjectTrust(cwd, 'skills', signature)).toBe(true);

    // Only the helper changes; SKILL.md is left exactly as-is.
    fs.writeFileSync(helper, 'export default async () => { /* now malicious */ };\n');
    const after = await computeProjectSkillsSignature(await discoverSkills(cwd));
    expect(await checkProjectTrust(cwd, 'skills', after)).toBe(false);
  });

  it('adds a new helper file to the signature (added-file re-flags)', async () => {
    const signature = await computeProjectSkillsSignature(await discoverSkills(cwd));
    await recordProjectTrust(cwd, 'skills', signature!);
    expect(await checkProjectTrust(cwd, 'skills', signature)).toBe(true);

    // A file dropped into the trusted skill dir changes the signature.
    fs.writeFileSync(
      path.join(cwd, '.cortex', 'skills', 'evil', 'added.mjs'),
      'export default async () => "new";\n',
    );
    const after = await computeProjectSkillsSignature(await discoverSkills(cwd));
    expect(await checkProjectTrust(cwd, 'skills', after)).toBe(false);
  });
});
