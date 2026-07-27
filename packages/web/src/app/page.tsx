'use client';

import { useEffect, useState } from 'react';
import { ChatInput } from '@/components/ChatInput';
import { GraphCanvas } from '@/components/GraphCanvas';
import { GraphRunPanel } from '@/components/GraphRunPanel';
import { GraphRunStream } from '@/components/GraphRunStream';
import { MessageStream } from '@/components/MessageStream';
import { NodeConfigPanel } from '@/components/NodeConfigPanel';
import { NodeSelector } from '@/components/NodeSelector';
import { RunPicker } from '@/components/RunPicker';
import { SessionPicker } from '@/components/SessionPicker';
import { useSocket } from '@/hooks/useSocket';
import { useNodeHistory } from '@/hooks/useNodeHistory';

type Mode = 'node' | 'graph';
const MODE_KEY = '0agentteams.mode';

function readMode(): Mode {
  if (typeof window === 'undefined') return 'node';
  try {
    const saved = window.localStorage.getItem(MODE_KEY);
    return saved === 'graph' ? 'graph' : 'node';
  } catch {
    return 'node';
  }
}

export default function Home() {
  const { connected } = useSocket();
  useNodeHistory();
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [mode, setMode] = useState<Mode>(readMode);

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
      setTheme('light');
      document.documentElement.dataset.theme = 'light';
    }
  }, []);

  const switchMode = (next: Mode): void => {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // 浏览器存储不可用时忽略
    }
  };

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
          <div style={styles.modeToggle}>
            <button
              type='button'
              onClick={() => switchMode('node')}
              style={{ ...styles.modeBtn, ...(mode === 'node' ? styles.modeBtnActive : {}) }}
            >
              单节点
            </button>
            <button
              type='button'
              onClick={() => switchMode('graph')}
              style={{ ...styles.modeBtn, ...(mode === 'graph' ? styles.modeBtnActive : {}) }}
            >
              图运行
            </button>
          </div>
          {mode === 'node' && <NodeSelector />}
          {mode === 'node' && <SessionPicker />}
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
          {mode === 'node' ? (
            <>
              <MessageStream />
              <ChatInput />
            </>
          ) : (
            <>
              <GraphCanvas />
              <GraphRunPanel />
            </>
          )}
        </section>
        <aside style={styles.side}>
          {mode === 'node' ? (
            <NodeConfigPanel />
          ) : (
            <div style={styles.graphSide}>
              <div style={styles.sideTitle}>图运行流</div>
              <div style={styles.streamWrap}>
                <GraphRunStream />
              </div>
              <div style={styles.sideTitle}>运行历史</div>
              <div style={styles.runPickerWrap}>
                <RunPicker />
              </div>
            </div>
          )}
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
  modeToggle: { display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' },
  modeBtn: {
    background: 'var(--surface-raised)',
    color: 'var(--text-muted)',
    border: 'none',
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
  },
  modeBtnActive: { color: 'var(--text-strong)', background: 'var(--accent)', fontWeight: 600 },
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
  body: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' },
  chat: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' },
  side: { width: 380, minHeight: 0, flexShrink: 0, overflow: 'hidden', borderLeft: '1px solid var(--border)' },
  graphSide: { height: '100%', display: 'flex', flexDirection: 'column' },
  sideTitle: { padding: '10px 14px 4px', fontSize: 12, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' },
  streamWrap: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
  runPickerWrap: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)' },
  sidePlaceholder: { color: 'var(--text-faint)', fontSize: 13, padding: 16 },
};
