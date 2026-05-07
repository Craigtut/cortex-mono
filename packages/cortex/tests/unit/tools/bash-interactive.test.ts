import { describe, it, expect } from 'vitest';
import {
  checkInteractive,
  tokenize,
  findProgram,
} from '../../../src/tools/bash/interactive.js';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('splits on unquoted whitespace', () => {
    expect(tokenize('foo bar baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('keeps double-quoted sections intact', () => {
    expect(tokenize('echo "hello world" foo')).toEqual([
      'echo',
      'hello world',
      'foo',
    ]);
  });

  it('keeps single-quoted sections intact', () => {
    expect(tokenize("echo 'hello world' foo")).toEqual([
      'echo',
      'hello world',
      'foo',
    ]);
  });

  it('honors backslash-escaped spaces', () => {
    expect(tokenize('touch hello\\ world.txt')).toEqual([
      'touch',
      'hello world.txt',
    ]);
  });

  it('handles nested quote chars inside the other kind of quote', () => {
    expect(tokenize(`echo "it's fine"`)).toEqual(['echo', "it's fine"]);
    expect(tokenize(`echo 'she said "hi"'`)).toEqual(['echo', 'she said "hi"']);
  });

  it('returns empty array for empty / whitespace-only input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   \t  ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Program resolution
// ---------------------------------------------------------------------------

describe('findProgram', () => {
  it('returns basename and args for a plain invocation', () => {
    expect(findProgram(['vim', 'foo.txt'])).toEqual({
      name: 'vim',
      args: ['foo.txt'],
    });
  });

  it('strips path prefix from the program token', () => {
    expect(findProgram(['/usr/bin/python3', 'script.py'])).toEqual({
      name: 'python3',
      args: ['script.py'],
    });
  });

  it('skips leading KEY=VALUE env-var prefixes', () => {
    expect(findProgram(['FOO=bar', 'BAZ=qux', 'vim', 'file'])).toEqual({
      name: 'vim',
      args: ['file'],
    });
  });

  it('unwraps `env` wrapper, including its flags and var assignments', () => {
    expect(findProgram(['env', 'FOO=bar', 'vim', 'file'])).toEqual({
      name: 'vim',
      args: ['file'],
    });
    expect(findProgram(['env', '-u', 'OLD', 'FOO=bar', 'vim'])).toEqual({
      name: 'vim',
      args: [],
    });
  });

  it('returns null when no program token exists', () => {
    expect(findProgram([])).toBeNull();
    expect(findProgram(['FOO=bar'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Always-interactive rejections
// ---------------------------------------------------------------------------

describe('checkInteractive — editors', () => {
  it.each(['vim', 'vi', 'nvim', 'emacs', 'nano', 'pico'])(
    'rejects %s',
    (editor) => {
      const r = checkInteractive(`${editor} foo.txt`);
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain(editor);
      expect(r.reason).toContain('Edit or Write');
    },
  );

  it('rejects vim even with path prefix', () => {
    expect(checkInteractive('/usr/bin/vim foo').allowed).toBe(false);
  });

  it('rejects vim invoked via env wrapper', () => {
    expect(checkInteractive('env TERM=xterm vim foo').allowed).toBe(false);
  });
});

describe('checkInteractive — monitors', () => {
  it.each(['top', 'htop', 'watch', 'btop'])('rejects %s', (mon) => {
    const r = checkInteractive(mon);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain(mon);
  });
});

describe('checkInteractive — pagers', () => {
  it('rejects less standalone', () => {
    expect(checkInteractive('less file.txt').allowed).toBe(false);
  });

  it('rejects less piped (pager still waits on keypress)', () => {
    const r = checkInteractive('cat file.txt | less');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('less');
  });

  it('rejects more and most', () => {
    expect(checkInteractive('more file').allowed).toBe(false);
    expect(checkInteractive('most file').allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Conditional rejections — REPLs
// ---------------------------------------------------------------------------

describe('checkInteractive — python', () => {
  it('rejects bare python', () => {
    expect(checkInteractive('python').allowed).toBe(false);
    expect(checkInteractive('python3').allowed).toBe(false);
  });

  it('allows python with a script file', () => {
    expect(checkInteractive('python script.py').allowed).toBe(true);
    expect(checkInteractive('python3 /tmp/run.py').allowed).toBe(true);
  });

  it('allows python -c', () => {
    expect(checkInteractive('python3 -c "print(1)"').allowed).toBe(true);
  });

  it('allows python -m module', () => {
    expect(checkInteractive('python -m http.server 8000').allowed).toBe(true);
  });

  it('allows python --version', () => {
    expect(checkInteractive('python --version').allowed).toBe(true);
    expect(checkInteractive('python -V').allowed).toBe(true);
  });
});

describe('checkInteractive — node', () => {
  it('rejects bare node', () => {
    expect(checkInteractive('node').allowed).toBe(false);
  });

  it('allows node with script', () => {
    expect(checkInteractive('node script.js').allowed).toBe(true);
    expect(checkInteractive('node --experimental-vm-modules test.mjs').allowed).toBe(true);
  });

  it('allows node -e and -p', () => {
    expect(checkInteractive('node -e "console.log(1)"').allowed).toBe(true);
    expect(checkInteractive('node -p "process.version"').allowed).toBe(true);
  });
});

describe('checkInteractive — ruby / irb', () => {
  it('rejects irb always', () => {
    expect(checkInteractive('irb').allowed).toBe(false);
    expect(checkInteractive('irb --simple-prompt').allowed).toBe(false);
  });

  it('rejects bare ruby (reads from stdin)', () => {
    expect(checkInteractive('ruby').allowed).toBe(false);
  });

  it('allows ruby with script or -e', () => {
    expect(checkInteractive('ruby test.rb').allowed).toBe(true);
    expect(checkInteractive('ruby -e "puts 1"').allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Conditional rejections — DB clients
// ---------------------------------------------------------------------------

describe('checkInteractive — psql', () => {
  it('rejects bare psql', () => {
    expect(checkInteractive('psql').allowed).toBe(false);
  });

  it('rejects psql with only connection flags', () => {
    const r = checkInteractive('psql -h localhost -U postgres mydb');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('psql');
  });

  it('allows psql -c', () => {
    expect(checkInteractive('psql -c "SELECT 1"').allowed).toBe(true);
    expect(
      checkInteractive('psql -h localhost -U postgres -c "SELECT 1" db').allowed,
    ).toBe(true);
  });

  it('allows psql -f', () => {
    expect(checkInteractive('psql -f script.sql mydb').allowed).toBe(true);
  });

  it('allows psql --list', () => {
    expect(checkInteractive('psql -l').allowed).toBe(true);
    expect(checkInteractive('psql --list').allowed).toBe(true);
  });

  it('allows --command=VALUE form', () => {
    expect(checkInteractive('psql --command="SELECT 1" db').allowed).toBe(true);
  });
});

describe('checkInteractive — mysql', () => {
  it('rejects bare mysql', () => {
    expect(checkInteractive('mysql').allowed).toBe(false);
    expect(checkInteractive('mysql -u root -p mydb').allowed).toBe(false);
  });

  it('allows mysql -e', () => {
    expect(checkInteractive('mysql -e "SELECT 1"').allowed).toBe(true);
    expect(
      checkInteractive('mysql -u root -pX --execute="SHOW TABLES"').allowed,
    ).toBe(true);
  });

  it('also applies to mariadb alias', () => {
    expect(checkInteractive('mariadb').allowed).toBe(false);
    expect(checkInteractive('mariadb -e "SELECT 1"').allowed).toBe(true);
  });
});

describe('checkInteractive — sqlite3', () => {
  it('rejects bare sqlite3', () => {
    expect(checkInteractive('sqlite3').allowed).toBe(false);
  });

  it('rejects sqlite3 with only a db file', () => {
    expect(checkInteractive('sqlite3 mydb.db').allowed).toBe(false);
  });

  it('allows sqlite3 with db + sql', () => {
    expect(
      checkInteractive('sqlite3 mydb.db "SELECT * FROM t"').allowed,
    ).toBe(true);
  });

  it('allows sqlite3 -cmd', () => {
    expect(checkInteractive('sqlite3 -cmd "SELECT 1" mydb.db').allowed).toBe(
      true,
    );
  });
});

describe('checkInteractive — mongo / mongosh', () => {
  it('rejects bare mongo and mongosh', () => {
    expect(checkInteractive('mongo').allowed).toBe(false);
    expect(checkInteractive('mongosh mongodb://localhost').allowed).toBe(false);
  });

  it('allows --eval', () => {
    expect(
      checkInteractive('mongosh --eval "db.users.countDocuments()"').allowed,
    ).toBe(true);
  });

  it('allows a JS script file', () => {
    expect(checkInteractive('mongosh seed.js').allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Quote-awareness and false-positive suppression
// ---------------------------------------------------------------------------

describe('checkInteractive — quote-awareness', () => {
  it('does not flag interactive tool names inside quoted args', () => {
    expect(checkInteractive('echo "use vim to edit"').allowed).toBe(true);
    expect(checkInteractive('echo "run top to monitor"').allowed).toBe(true);
    expect(checkInteractive("grep 'less' file.txt").allowed).toBe(true);
  });

  it('does not flag interactive names as substrings of other programs', () => {
    // 'bashvim' is not vim. Checks program token equality, not contains.
    expect(checkInteractive('bashvim --help').allowed).toBe(true);
  });

  it('allows non-interactive programs that happen to have similar prefixes', () => {
    expect(checkInteractive('topup --arg').allowed).toBe(true);
    expect(checkInteractive('nodejs --version').allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-command handling
// ---------------------------------------------------------------------------

describe('checkInteractive — sub-commands', () => {
  it('rejects when any sub-command is interactive', () => {
    expect(checkInteractive('git status && vim foo').allowed).toBe(false);
    expect(checkInteractive('ls; htop').allowed).toBe(false);
  });

  it('allows when all sub-commands are non-interactive', () => {
    expect(checkInteractive('git status && git diff').allowed).toBe(true);
    expect(checkInteractive('ls -la; pwd').allowed).toBe(true);
  });

  it('rejects the first interactive sub-command it encounters', () => {
    const r = checkInteractive('ls | less | wc -l');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('less');
  });
});
