'use client';

import { useState, type KeyboardEvent } from 'react';
import { useSendMessage } from '../hooks/useSendMessage';
import { useChatStore } from '../stores/chatStore';

export function ChatInput() {
  const { handleSend, sending } = useSendMessage();
  const isStreaming = useChatStore((s) => s.isStreaming);
  const [text, setText] = useState('');
  const busy = sending || isStreaming;

  const submit = async (): Promise<void> => {
    if (!text.trim() || busy) return;
    await handleSend(text);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div style={styles.bar}>
      <div style={{ ...styles.state, color: busy ? 'var(--text-muted)' : 'var(--success)' }}>
        <span style={{ ...styles.stateDot, background: busy ? 'var(--accent)' : 'var(--success)' }} />
        {busy ? 'CLI 正在执行，请稍候，本次回复完成前不能再次发送' : 'Agent 已就绪，可以发送任务'}
      </div>
      <div style={styles.controls}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={busy ? '当前任务完成后可继续输入' : '给 Agent 发消息…（如：把输入框改宽一点）'}
          rows={4}
          style={{ ...styles.input, ...(busy ? styles.inputDisabled : {}) }}
          disabled={busy}
        />
        <button
          onClick={() => void submit()}
          disabled={busy || !text.trim()}
          style={{ ...styles.btn, ...((busy || !text.trim()) ? styles.btnDisabled : {}) }}
        >
          {busy ? '请稍候' : '发送'}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: { padding: 12, borderTop: '1px solid var(--border)' },
  state: { display: 'flex', alignItems: 'center', gap: 6, minHeight: 20, marginBottom: 6, fontSize: 12 },
  stateDot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  controls: { display: 'flex', gap: 8 },
  input: {
    flex: 1,
    resize: 'none',
    background: 'var(--surface-raised)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '10px 12px',
    fontSize: 16,
    outline: 'none',
  },
  inputDisabled: { cursor: 'not-allowed', opacity: 0.65 },
  btn: {
    background: 'var(--accent)',
    color: 'var(--accent-text)',
    border: 'none',
    borderRadius: 6,
    padding: '0 20px',
    fontSize: 14,
    fontWeight: 600,
  },
  btnDisabled: { cursor: 'not-allowed', opacity: 0.55 },
};
