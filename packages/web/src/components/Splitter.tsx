'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** 水平分割（左 | 右），中间垂直拖动条改左右宽度。 */
export function HSplit({
  left,
  right,
  initialLeft = 700,
  minLeft = 320,
  minRight = 280,
}: {
  left: ReactNode;
  right: ReactNode;
  initialLeft?: number;
  minLeft?: number;
  minRight?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftW, setLeftW] = useState(initialLeft);
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const maxLeft = rect.width - minRight;
      setLeftW(Math.min(Math.max(x, minLeft), maxLeft));
    };
    const onUp = (): void => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [minLeft, minRight]);

  return (
    <div ref={containerRef} style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0, minWidth: 0 }}>
      <div style={{ width: leftW, minWidth: minLeft, height: '100%', minHeight: 0, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>{left}</div>
      <div style={vBarStyle} onMouseDown={onMouseDown} role='separator' aria-orientation='vertical' />
      <div style={{ flex: 1, minWidth: minRight, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>{right}</div>
    </div>
  );
}

/** 垂直分割（上 | 下），中间水平拖动条改上下高度。 */
export function VSplit({
  top,
  bottom,
  initialTop = 280,
  minTop = 80,
  minBottom = 80,
}: {
  top: ReactNode;
  bottom: ReactNode;
  initialTop?: number;
  minTop?: number;
  minBottom?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [topH, setTopH] = useState(initialTop);
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'row-resize';
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const maxTop = rect.height - minBottom;
      setTopH(Math.min(Math.max(y, minTop), maxTop));
    };
    const onUp = (): void => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [minTop, minBottom]);

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, minWidth: 0 }}>
      <div style={{ height: topH, minHeight: minTop, width: '100%', minWidth: 0, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>{top}</div>
      <div style={hBarStyle} onMouseDown={onMouseDown} role='separator' aria-orientation='horizontal' />
      <div style={{ flex: 1, minHeight: minBottom, width: '100%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>{bottom}</div>
    </div>
  );
}

const vBarStyle: CSSProperties = {
  width: 6,
  cursor: 'col-resize',
  background: 'var(--border)',
  flexShrink: 0,
  height: '100%',
};
const hBarStyle: CSSProperties = {
  height: 6,
  cursor: 'row-resize',
  background: 'var(--border)',
  flexShrink: 0,
  width: '100%',
};
