import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import type { OAuthAuthInfo } from '@animus-labs/cortex';
import { Text, type Container, type Loader, type TUI } from '@earendil-works/pi-tui';

/** Launch the OS URL handler without passing an OAuth URL through a shell. */
export async function openAuthBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Authorization URLs must use HTTP or HTTPS');
  }

  let file: string;
  let args: string[];
  if (process.platform === 'win32') {
    const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT']
      ?? process.env['windir'] ?? 'C:\\Windows';
    file = win32.join(systemRoot, 'System32', 'rundll32.exe');
    args = ['url.dll,FileProtocolHandler', parsed.href];
  } else {
    file = process.platform === 'darwin' ? 'open' : 'xdg-open';
    args = [parsed.href];
  }
  await new Promise<void>((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Keep the manual URL visible even while provider progress updates the loader. */
export function showBrowserAuthorization(
  tui: TUI,
  container: Container,
  loader: Loader,
  auth: OAuthAuthInfo,
): void {
  loader.setMessage(auth.instructions ?? 'Opening browser...');
  const status = new Text('  If the browser does not open, use this URL:', 0, 0);
  container.addChild(status);
  container.addChild(new Text(auth.url, 0, 0));
  tui.requestRender();
  void openAuthBrowser(auth.url).catch(() => {
    // Launcher errors can include the entire OAuth URL. Keep them out of logs.
    status.setText('  Could not open the browser. Open this URL manually to continue:');
    tui.requestRender();
  });
}
