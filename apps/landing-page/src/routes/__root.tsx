/// <reference types="vite/client" />
import type { ReactNode } from 'react';
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from '@tanstack/react-router';
import { themeCss, googleFontsHref } from '@animus-labs/brand';
import appCss from '../styles/app.css?url';
import splitFlapCss from '../styles/split-flap.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Cortex // agent harness' },
      {
        name: 'description',
        content:
          'Cortex is the harness around the model: tools, permissions, compaction, memory.',
      },
    ],
    links: [
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossOrigin: 'anonymous',
      },
      { rel: 'stylesheet', href: googleFontsHref },
      { rel: 'stylesheet', href: appCss },
      { rel: 'stylesheet', href: splitFlapCss },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* Brand tokens baked into the prerendered HTML as CSS variables. */}
        <style dangerouslySetInnerHTML={{ __html: themeCss() }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
