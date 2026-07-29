'use client';

import { useEffect, useState } from 'react';
import { ChatInput } from '@/components/ChatInput';
import { GraphCanvas } from '@/components/GraphCanvas';
import { GraphRunPanel } from '@/components/GraphRunPanel';
import { GraphRunStream } from '@/components/GraphRunStream';
import { MessageStream } from '@/components/MessageStream';
import { NodeConfigPanel } from '@/components/NodeConfigPanel';
import { NodeSelector } from '@/components/NodeSelector';
import { ProjectPicker } from '@/components/ProjectPicker';
import { RunPicker } from '@/components/RunPicker';
import { SessionPicker } from '@/components/SessionPicker';
import { IssuesPanel } from '@/components/IssuesPanel';
import { HSplit, VSplit } from '@/components/Splitter';
import { useSocket } from '@/hooks/useSocket';
import { useNodeHistory } from '@/hooks/useNodeHistory';
import { useGraphRunStore } from '@/stores/graphRunStore';

type Mode = 'node' | 'graph';
const MODE_KEY = '0agentteams.mode';

export default function Home() {
  const { connected } = useSocket();
  useNodeHistory();
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  // 初始用 'node'，挂载后再从 localStorage 读取，避免 SSR/CSR 不一致导致 hydration 报错
  const [mode, setMode] = useState<Mode>('node');

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
      setTheme('light');
      document.documentElement.dataset.theme = 'light';
    }
    try {
      const savedMode = window.localStorage.getItem(MODE_KEY);
      if (savedMode === 'graph') setMode('graph');
    } catch {
      // 浏览器存储不可用时保持默认
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
          <ProjectPicker />
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
        {mode === 'node' ? (
          <>
            <section style={styles.chat}>
              <MessageStream />
              <ChatInput />
            </section>
            <aside style={styles.side}>
              <NodeConfigPanel />
            </aside>
          </>
        ) : (
          <HSplit
            left={
              <section style={styles.chat}>
                <GraphCanvas />
                <GraphRunPanel />
              </section>
            }
            right={
              <aside style={styles.sideFill}>
                <VSplit top={<GraphRunStream />} bottom={<GraphSideBottom />} />
              </aside>
            }
          />
        )}
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
  sideFill: { flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', height: '100%' },
};

/** 图模式右侧底部：[运行历史 / 节点配置] 标签切换；点 agent 节点自动切到配置 */
function GraphSideBottom() {
  const selected = useGraphRunStore((s) => s.selectedAgentNodeKey);
  const setSelected = useGraphRunStore((s) => s.setSelectedAgentNodeKey);
  const graph = useGraphRunStore((s) => s.graph);
  const [tab, setTab] = useState<'history' | 'config' | 'issues'>('history');

  // 点 agent 节点 → 自动切到配置
  useEffect(() => {
    if (selected) setTab('config');
  }, [selected]);

  // 配置 tab 默认展示选中节点；未选则取图中第一个 agent
  const configKey = selected ?? graph?.nodes.find((n) => n.type === 'agent')?.agentNodeKey ?? null;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)' }}>
      <div style={tabBarStyle}>
        <button style={{ ...tabBtnStyle, ...(tab === 'history' ? tabBtnActiveStyle : {}) }} onClick={() => setTab('history')}>
          运行历史
        </button>
        <button style={{ ...tabBtnStyle, ...(tab === 'config' ? tabBtnActiveStyle : {}) }} onClick={() => setTab('config')}>
          节点配置
        </button>
        <button style={{ ...tabBtnStyle, ...(tab === 'issues' ? tabBtnActiveStyle : {}) }} onClick={() => setTab('issues')}>
          Issues
        </button>
        {selected && (
          <button style={backBtnStyle} onClick={() => setSelected(null)}>
            取消选择
          </button>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {tab === 'history' ? (
          <RunPicker />
        ) : tab === 'issues' ? (
          <IssuesPanel />
        ) : configKey ? (
          <NodeConfigPanel nodeKey={configKey} />
        ) : (
          <div style={{ color: 'var(--text-faint)', fontSize: 13, padding: 16 }}>画布上还没有 agent 节点。</div>
        )}
      </div>
    </div>
  );
}

const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  padding: '6px 10px',
  borderBottom: '1px solid var(--border)',
  alignItems: 'center',
};
const tabBtnStyle: React.CSSProperties = {
  background: 'var(--surface-raised)',
  color: 'var(--text-muted)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
};
const tabBtnActiveStyle: React.CSSProperties = {
  color: 'var(--text-strong)',
  background: 'var(--accent)',
  fontWeight: 600,
  border: '1px solid var(--accent)',
};
const backBtnStyle: React.CSSProperties = {
  marginLeft: 'auto',
  background: 'transparent',
  color: 'var(--text-muted)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '3px 8px',
  fontSize: 11,
  cursor: 'pointer',
};
