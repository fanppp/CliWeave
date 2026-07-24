'use client';

import { useState, type KeyboardEvent } from 'react';
import { useSendMessage } from '../hooks/useSendMessage';

export function ChatInput() {
  const { handleSend, sending } = useSendMessage();
  const [text, setText] = useState('');

  const submit = async (): Promise<void> => {
    if (!text.trim()) return;
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
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder='给 Agent 发消息…（如：把输入框改宽一点）'
        rows={4}
        style={styles.input}
        disabled={sending}
      />
      <button onClick={() => void submit()} disabled={sending || !text.trim()} style={styles.btn}>
        发送
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: { display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--border)' },
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
  btn: {
    background: 'var(--accent)',
    color: 'var(--accent-text)',
    border: 'none',
    borderRadius: 6,
    padding: '0 20px',
    fontSize: 14,
    fontWeight: 600,
  },
};
