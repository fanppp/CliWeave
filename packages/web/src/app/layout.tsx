import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SocketProvider } from '../providers/SocketProvider';
import './globals.css';

export const metadata: Metadata = {
  title: '0AgentTeams',
  description: '可配置多 CLI Agent 节点协作平台',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang='zh-CN'>
      <body>
        <SocketProvider>{children}</SocketProvider>
      </body>
    </html>
  );
}
