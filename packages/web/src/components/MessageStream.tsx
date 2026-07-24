'use client';

import { useEffect, useRef } from 'react';
import { useChatStore, type ChatMessage } from '../stores/chatStore';

function bubbleColor(msg: ChatMessage): { bg: string; label: string } {
  if (msg.role === 'user') return { bg: 'var(--bubble-user)', label: '你' };
  if (msg.role === 'system') return { bg: 'var(--bubble-system)', label: '系统' };
  if (msg.eventType === 'tool_use') return { bg: 'var(--bubble-tool)', label: msg.toolName ?? '工具' };
  return { bg: 'var(--bubble-agent)', label: 'Agent' };
}

export function MessageStream() {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  return (
    <div style={styles.wrap}>
      {messages.length === 0 && (
        <div style={styles.empty}>输入消息开始对话。Agent 能直接改写本项目源码。</div>
      )}
      {messages.map((msg) => {
        const { bg, label } = bubbleColor(msg);
        return (
          <div key={msg.id} style={{ ...styles.bubble, background: bg }}>
            <div style={styles.meta}>
              <strong>{label}</strong>
              <span style={styles.time}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
            </div>
            {msg.eventType === 'tool_use' ? (
              <pre style={styles.pre}>{msg.content}</pre>
            ) : (
              <div style={styles.content}>{msg.content}</div>
            )}
          </div>
        );
      })}
      {isStreaming && <div style={styles.thinking}>Agent 思考中…</div>}
      <div ref={endRef} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { color: 'var(--text-faint)', textAlign: 'center', marginTop: 40 },
  bubble: { borderRadius: 8, padding: '10px 14px', maxWidth: '85%' },
  meta: { display: 'flex', justifyContent: 'space-between', fontSize: 11, opacity: 0.6, marginBottom: 4 },
  time: { fontSize: 10 },
  content: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5, fontSize: 14 },
  pre: { margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--code-text)' },
  thinking: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 13, padding: '0 4px' },
};
