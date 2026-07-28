'use client';

import { useEffect, useRef } from 'react';
import { useChatStore, type AgentEvent } from '../stores/chatStore';
import { useSocketConnection } from '../providers/SocketProvider';

/** 服务端 NodeMessageEnvelope：{ instanceKey, message }。 */
interface NodeMessageEnvelope {
  instanceKey: string;
  message: AgentEvent;
}

/**
 * 单节点聊天：join_node(instanceKey, ack) + agent_message(envelope) 监听。
 * - 按 envelope.instanceKey 过滤（防 projA/projB 同 nodeKey 延迟消息串台）。
 * - join_node ack 成功且键/socket 未变才写 joinedInstanceKey（防旧 ack 覆盖新状态）。
 * - 发送前由 useSendMessage 校验 joinedInstanceKey === activeInstanceKey。
 */
export function useSocket(): { connected: boolean } {
  const { socket, connected } = useSocketConnection();
  const activeInstanceKey = useChatStore((s) => s.activeInstanceKey);
  const pushAgentEvent = useChatStore((s) => s.pushAgentEvent);

  const activeKeyRef = useRef<string | null>(activeInstanceKey);
  activeKeyRef.current = activeInstanceKey;
  const joinedRef = useRef<string | null>(null);

  // 监听 agent_message（按 instanceKey 过滤）
  useEffect(() => {
    if (!socket) return;
    const onEnvelope = (env: NodeMessageEnvelope): void => {
      if (env.instanceKey === activeKeyRef.current) pushAgentEvent(env.message);
    };
    socket.on('agent_message', onEnvelope);
    return () => {
      socket.off('agent_message', onEnvelope);
    };
  }, [socket, pushAgentEvent]);

  // 连接/节点/项目变化时重新 join（ack 守卫）
  useEffect(() => {
    if (!socket || !connected) return;
    const requestedKey = activeInstanceKey;
    const requestedSocketId = socket.id;
    // leave 旧 room
    if (joinedRef.current && joinedRef.current !== requestedKey) {
      socket.emit('leave_node', joinedRef.current);
    }
    if (!requestedKey) {
      // 无 instanceKey（节点列表未加载）：清 join 态，等 NodeSelector 设置后重 join
      useChatStore.getState().setJoinedInstanceKey(null);
      joinedRef.current = null;
      return;
    }
    // 清旧 join 态（ack 前不可发）
    useChatStore.getState().setJoinedInstanceKey(null);
    socket.timeout(5000).emit('join_node', requestedKey, (ok: boolean) => {
      // 守卫：ack 回来时键/socket 仍一致才写（防切项目后旧 ack 覆盖）
      if (
        ok &&
        useChatStore.getState().activeInstanceKey === requestedKey &&
        socket.id === requestedSocketId
      ) {
        useChatStore.getState().setJoinedInstanceKey(requestedKey);
        joinedRef.current = requestedKey;
      }
    });
  }, [socket, connected, activeInstanceKey]);

  return { connected };
}
