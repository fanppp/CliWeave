'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '../stores/chatStore';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3004';

interface SessionItem {
  sessionId: string;
  startedAt: number;
  preview: string;
  messageCount: number;
}

export function SessionPicker() {
  const activeNodeId = useChatStore((s) => s.activeNodeId);
  const reloadKey = useChatStore((s) => s.reloadKey);
  const triggerReload = useChatStore((s) => s.triggerReload);
  const clear = useChatStore((s) => s.clear);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [active, setActive] = useState<string>('');
  const [creating, setCreating] = useState(false);

  const refresh = (): void => {
    fetch(`${API_URL}/api/agents/${activeNodeId}/sessions`)
      .then((r) => (r.ok ? r.json() : { sessions: [], activeSessionId: null }))
      .then((d) => {
        setSessions(Array.isArray(d.sessions) ? d.sessions : []);
        setActive(typeof d.activeSessionId === 'string' ? d.activeSessionId : '');
      })
      .catch(() => setSessions([]));
  };

  useEffect(refresh, [activeNodeId, reloadKey]);

  const activate = (sid: string): void => {
    fetch(`${API_URL}/api/agents/${activeNodeId}/sessions/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    })
      .then(() => {
        setActive(sid);
        triggerReload(); // 重新加载该会话历史
      })
      .catch(() => {});
  };

  const startNewSession = async (): Promise<void> => {
    if (creating || isStreaming) return;
    setCreating(true);
    try {
      const response = await fetch(`${API_URL}/api/agents/${activeNodeId}/sessions/new`, {
        method: 'POST',
      });
      if (!response.ok) return;
      setActive('');
      clear();
      triggerReload();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={styles.wrap}>
      {sessions.length === 0 ? (
        <span style={styles.muted}>无历史会话</span>
      ) : (
        <select
          style={styles.select}
          value={active}
          onChange={(e) => activate(e.target.value)}
          disabled={creating || isStreaming}
          title='切换或恢复指定 CLI 对话'
          aria-label='选择历史会话'
        >
          {!active && <option value=''>新会话</option>}
          {sessions.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {s.sessionId.slice(0, 8)}… ({s.messageCount}条) {s.preview.slice(0, 24)}
            </option>
          ))}
        </select>
      )}
      <button
        type='button'
        style={styles.newButton}
        onClick={() => void startNewSession()}
        disabled={creating || isStreaming}
        title={isStreaming ? '请等待当前回复完成' : '发起新会话'}
      >
        <span aria-hidden='true'>+</span> {creating ? '创建中' : '新会话'}
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', alignItems: 'center', gap: 8 },
  select: {
    background: 'var(--surface-raised)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 12,
    maxWidth: 240,
  },
  muted: { fontSize: 12, opacity: 0.5 },
  newButton: {
    height: 30,
    background: 'var(--accent)',
    color: 'var(--accent-text)',
    border: 'none',
    borderRadius: 6,
    padding: '0 10px',
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
};
