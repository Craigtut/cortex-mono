import { describe, it, expect } from 'vitest';
import { findDangerousCommand } from '../../src/permissions/dangerous-commands.js';

describe('findDangerousCommand', () => {
  describe('catastrophic rm', () => {
    const blocked = [
      'rm -rf /',
      'rm -rf /*',
      'rm -fr /',
      'rm -r -f /',
      'rm --recursive --force /',
      'rm -rf /.',
      'rm -rf ~',
      'rm -rf ~/',
      'rm -rf $HOME',
      'rm -rf ${HOME}/',
      'rm -rf /usr',
      'rm -rf /etc/',
      'rm -rf /var/*',
      'rm -rf "/"',
      "rm -r''f /",
      'sudo rm -rf /',
      'FOO=bar rm -rf /',
      'rm -rf --no-preserve-root /',
      'timeout 5 rm -rf /',
      'git status && rm -rf /',
      'echo hi; rm -rf ~',
      'echo $(rm -rf /)',
    ];
    for (const cmd of blocked) {
      it(`blocks: ${cmd}`, () => {
        expect(findDangerousCommand(cmd)).not.toBeNull();
      });
    }
  });

  describe('other catastrophic commands', () => {
    it('blocks recursive chmod/chown on root', () => {
      expect(findDangerousCommand('chmod -R 777 /')).not.toBeNull();
      expect(findDangerousCommand('chown -R me /usr')).not.toBeNull();
    });

    it('blocks writing to a block device', () => {
      expect(findDangerousCommand('dd if=/dev/zero of=/dev/sda bs=1M')).not.toBeNull();
      expect(findDangerousCommand('mkfs.ext4 /dev/sdb')).not.toBeNull();
      expect(findDangerousCommand('echo x > /dev/sda')).not.toBeNull();
      expect(findDangerousCommand('cat junk 2>/dev/nvme0n1')).not.toBeNull();
    });

    it('blocks a fork bomb', () => {
      expect(findDangerousCommand(':(){ :|:& };:')).not.toBeNull();
    });
  });

  describe('safe commands', () => {
    const allowed = [
      'rm -rf build',
      'rm -rf node_modules',
      'rm -rf ./dist',
      'rm -rf /tmp/scratch',
      'rm file.txt',
      'rm -rf /usr/local/lib/node_modules/foo', // deep path -> prompt, not hard block
      'git status',
      'npm install',
      'chmod 755 run.sh',
      'dd if=/dev/zero of=disk.img bs=1M count=10',
      'cat /dev/sda',
      'echo hi > out.txt',
      'echo "rm -rf /"', // quoted string argument, not an executed command
    ];
    for (const cmd of allowed) {
      it(`allows: ${cmd}`, () => {
        expect(findDangerousCommand(cmd)).toBeNull();
      });
    }
  });
});
