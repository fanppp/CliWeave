'use client';

import { useEffect, useState } from 'react';
import { ChatInput } from '@/components/ChatInput';
import { MessageStream } from '@/components/MessageStream';
import { NodeConfigPanel } from '@/components/NodeConfigPanel';
import { NodeSelector } from '@/components/NodeSelector';
import { SessionPicker } from '@/components/SessionPicker';
import { useSocket } from '@/hooks/useSocket';
import { useNodeHistory } from '@/hooks/useNodeHistory';

export default function Home() {
  const { connected } = useSocket();
  useNodeHistory();
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
      setTheme('light');
      document.documentElement.dataset.theme = 'light';
    }
  }, []);

  const toggleTheme = (): void => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('theme', nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  };

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.title}>0AgentTeams</h1>
        <div style={styles.headerActions}>
          <NodeSelector />
          <SessionPicker />
          <span style={styles.status}>
            WebSocket:{' '}
            <strong style={{ color: connected ? 'var(--success)' : 'var(--danger)' }}>
              {connected ? '已连接' : '断开'}
            </strong>
          </span>
          <button
            type='button'
            onClick={toggleTheme}
            style={styles.themeButton}
            aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          >
            <span aria-hidden='true'>{theme === 'dark' ? '☀' : '☾'}</span>
          </button>
        </div>
      </header>
      <div style={styles.body}>
        <section style={styles.chat}>
          <MessageStream />
          <ChatInput />
        </section>
        <aside style={styles.side}>
          <NodeConfigPanel />
        </aside>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--background)', color: 'var(--text)' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 20px',
    borderBottom: '1px solid var(--border)',
  },
  title: { fontSize: 18, fontWeight: 700 },
  headerActions: { display: 'flex', alignItems: 'center', gap: 12 },
  status: { fontSize: 13, opacity: 0.85 },
  themeButton: {
    width: 34,
    height: 34,
    display: 'grid',
    placeItems: 'center',
    background: 'var(--surface-raised)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontSize: 17,
    lineHeight: 1,
  },
  body: { flex: 1, display: 'flex', overflow: 'hidden' },
  chat: { flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' },
  side: { width: 380, flexShrink: 0, borderLeft: '1px solid var(--border)' },
};
