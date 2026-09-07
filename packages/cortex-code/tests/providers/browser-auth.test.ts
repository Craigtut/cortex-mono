import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container, Text, type Loader, type TUI } from '@earendil-works/pi-tui';
import { openAuthBrowser, showBrowserAuthorization } from '../../src/providers/browser-auth.js';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const env = process.env;
const url = 'https://example.com/authorize?state=a%26b&redirect_uri=http%3A%2F%2Flocalhost%3A1234&scope=read%20write';

beforeEach(() => {
  execFile.mockReset();
  execFile.mockImplementation((_file, _args, _options, callback) => callback(null));
  process.env = { SystemRoot: 'D:\\Windows' };
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  process.env = env;
});

describe('OAuth browser launch', () => {
  it.each([
    ['win32', 'D:\\Windows\\System32\\rundll32.exe', ['url.dll,FileProtocolHandler', url]],
    ['darwin', 'open', [url]],
    ['linux', 'xdg-open', [url]],
  ])('launches the %s URL handler with the complete OAuth URL', async (os, file, args) => {
    Object.defineProperty(process, 'platform', { value: os, configurable: true });
    await openAuthBrowser(url);
    expect(execFile).toHaveBeenCalledWith(file, args,
      { windowsHide: true, timeout: 10_000 }, expect.any(Function));
  });

  it('reports a missing browser launcher', async () => {
    execFile.mockImplementation((_file, _args, _options, callback) => callback(new Error('ENOENT')));
    await expect(openAuthBrowser(url)).rejects.toThrow('ENOENT');
  });

  it.each(['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'not a URL'])(
    'does not launch an invalid authorization URL: %s', async value => {
      await expect(openAuthBrowser(value)).rejects.toThrow();
      expect(execFile).not.toHaveBeenCalled();
    },
  );

  it('keeps a manual URL and failure message visible through provider progress', async () => {
    let failLaunch!: (error: Error) => void;
    execFile.mockImplementation((_file, _args, _options, callback) => { failLaunch = callback; });
    const tui = { requestRender: vi.fn() };
    const container = new Container();
    const loader = { setMessage: vi.fn() };

    showBrowserAuthorization(tui as unknown as TUI, container, loader as unknown as Loader, {
      url, instructions: 'Enter device code ABCD',
    });
    expect(loader.setMessage).toHaveBeenCalledWith('Enter device code ABCD');
    expect(container.children).toHaveLength(2);
    expect(container.children[1]).toBeInstanceOf(Text);
    expect(container.render(200).join('\n')).toContain(url);

    failLaunch(new Error('ENOENT'));
    await vi.waitFor(() => expect(container.render(200).join('\n')).toContain('Could not open the browser'));
    loader.setMessage('Waiting for authorization...');
    expect(container.render(200).join('\n')).toContain(url);
    expect(tui.requestRender).toHaveBeenCalledTimes(2);
  });
});
