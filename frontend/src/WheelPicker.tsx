import { useEffect, useRef } from 'react';

interface WheelPickerProps {
  value: number;
  min: number;
  max: number;
  label?: string;
  onChange: (value: number) => void;
}

const ITEM_HEIGHT = 44;
const VISIBLE = 5; // 可见行数（奇数）

/**
 * 滚轮选择器 —— 使用 scroll-snap 实现鼓形滚轮效果
 */
export function WheelPicker({ value, min, max, label, onChange }: WheelPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isSyncingRef = useRef(false);

  const items = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  // 将值映射为容器滚动位置
  function valueToScrollTop(v: number): number {
    return (v - min) * ITEM_HEIGHT;
  }

  // 滚动到当前值（不触发 onChange）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    isSyncingRef.current = true;
    el.scrollTop = valueToScrollTop(value);
    // 下一帧再解锁，防止 scroll 事件立即触发
    requestAnimationFrame(() => {
      isSyncingRef.current = false;
    });
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleScroll() {
    if (isSyncingRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const index = Math.round(el.scrollTop / ITEM_HEIGHT);
    const next = Math.min(max, Math.max(min, min + index));
    if (next !== value) {
      onChange(next);
    }
  }

  const padded = (n: number) => String(n).padStart(2, '0');

  return (
    <div className="wheel-picker">
      {label && <span className="wheel-picker__label">{label}</span>}
      <div className="wheel-picker__track-wrap">
        {/* 高亮选中区域 */}
        <div className="wheel-picker__highlight" />
        <div
          ref={containerRef}
          className="wheel-picker__scroll"
          style={{ height: ITEM_HEIGHT * VISIBLE }}
          onScroll={handleScroll}
        >
          {/* 前置填充 */}
          <div style={{ height: ITEM_HEIGHT * Math.floor(VISIBLE / 2) }} />
          {items.map((item) => (
            <div
              key={item}
              className={`wheel-picker__item ${item === value ? 'is-selected' : ''}`}
              style={{ height: ITEM_HEIGHT, lineHeight: `${ITEM_HEIGHT}px` }}
            >
              {padded(item)}
            </div>
          ))}
          {/* 后置填充 */}
          <div style={{ height: ITEM_HEIGHT * Math.floor(VISIBLE / 2) }} />
        </div>
      </div>
    </div>
  );
}

interface TimeWheelPickerProps {
  hour: number;
  minute: number;
  onHourChange: (h: number) => void;
  onMinuteChange: (m: number) => void;
}

/**
 * 时间滚轮选择器（小时 + 分钟）
 */
export function TimeWheelPicker({ hour, minute, onHourChange, onMinuteChange }: TimeWheelPickerProps) {
  return (
    <div className="time-wheel-picker">
      <WheelPicker value={hour} min={0} max={23} label="时" onChange={onHourChange} />
      <span className="time-wheel-picker__sep">:</span>
      <WheelPicker value={minute} min={0} max={59} label="分" onChange={onMinuteChange} />
    </div>
  );
}
