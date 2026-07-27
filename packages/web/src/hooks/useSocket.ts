'use client';

import { useEffect, useRef } from 'react';
import { useChatStore, type AgentEvent } from '../stores/chatStore';
import { useSocketConnection } from '../providers/SocketProvider';

/**
 * 单节点聊天：join_node + agent_message 监听。
 * 复用 SocketProvider 的共享连接（审核 #10）。
 */
export function useSocket(): { connected: boolean } {
  const { socket, connected } = useSocketConnection();
  const activeNodeRef = useRef('');
  const joinedNodeRef = useRef<string | null>(null);
  const activeNodeId = useChatStore((s) => s.activeNodeId);
  const pushAgentEvent = useChatStore((s) => s.pushAgentEvent);

  activeNodeRef.current = activeNodeId;

  // 监听 agent_message（只接受当前激活节点的消息）
  useEffect(() => {
    if (!socket) return;
    const onMessage = (msg: AgentEvent): void => {
      if (msg.nodeId === activeNodeRef.current) pushAgentEvent(msg);
    };
    socket.on('agent_message', onMessage);
    return () => {
      socket.off('agent_message', onMessage);
    };
  }, [socket, pushAgentEvent]);

  // 连接成功时立即 join 当前节点（处理 socket 已连接后才挂载的情况）
  useEffect(() => {
    if (!socket || !connected) return;
    if (joinedNodeRef.current !== activeNodeId) {
      if (joinedNodeRef.current) socket.emit('leave_node', joinedNodeRef.current);
      socket.emit('join_node', activeNodeId);
      joinedNodeRef.current = activeNodeId;
    }
  }, [socket, connected, activeNodeId]);

  // 切换节点时重新 join
  useEffect(() => {
    if (!socket || !connected) return;
    if (joinedNodeRef.current && joinedNodeRef.current !== activeNodeId) {
      socket.emit('leave_node', joinedNodeRef.current);
    }
    socket.emit('join_node', activeNodeId);
    joinedNodeRef.current = activeNodeId;
  }, [socket, connected, activeNodeId]);

  return { connected };
}
