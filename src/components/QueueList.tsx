import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CornerUpLeft, GripVertical, Pencil, Trash2 } from '../icons';

export interface QueuedMessage {
  id: string;
  text: string;
}

interface Props {
  items: QueuedMessage[];
  onChangeDirection: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onReorder: (sourceId: string, targetId: string) => void;
}

export default function QueueList({ items, onChangeDirection, onEdit, onRemove, onReorder }: Props) {
  const draggedId = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const startPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    draggedId.current = id;
    setDraggingId(id);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const movePointerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const sourceId = draggedId.current;
    if (!sourceId) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-queue-id]');
    const targetId = target?.dataset.queueId;
    if (targetId && targetId !== sourceId) onReorder(sourceId, targetId);
  };

  const endPointerDrag = () => {
    draggedId.current = null;
    setDraggingId(null);
  };

  if (!items.length) return null;

  return (
    <div className="queue-list" role="list" aria-label="排队消息">
      {items.map((item, index) => (
        <div
          key={item.id}
          className={`queue-card ${draggingId === item.id ? 'dragging' : ''}`}
          data-queue-id={item.id}
          role="listitem"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const sourceId = event.dataTransfer.getData('text/plain') || draggedId.current;
            if (sourceId && sourceId !== item.id) onReorder(sourceId, item.id);
            endPointerDrag();
          }}
        >
          <button
            className="queue-handle"
            type="button"
            draggable
            aria-label={`拖动第 ${index + 1} 条排队消息；可用上下方向键调整顺序`}
            title="拖拽排序（键盘可用 ↑/↓）"
            onDragStart={(event) => {
              draggedId.current = item.id;
              setDraggingId(item.id);
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', item.id);
            }}
            onDragEnd={endPointerDrag}
            onPointerDown={(event) => startPointerDrag(event, item.id)}
            onPointerMove={movePointerDrag}
            onPointerUp={endPointerDrag}
            onPointerCancel={endPointerDrag}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' && index > 0) {
                event.preventDefault();
                onReorder(item.id, items[index - 1].id);
              } else if (event.key === 'ArrowDown' && index < items.length - 1) {
                event.preventDefault();
                onReorder(item.id, items[index + 1].id);
              }
            }}
          >
            <GripVertical size={15} aria-hidden />
          </button>
          <span className="queue-card-text">{item.text}</span>
          <div className="queue-actions">
            <button
              className="queue-action direction"
              type="button"
              aria-label="改变方向并立即发送"
              title="改变方向：停止当前生成并立即发送"
              onClick={() => onChangeDirection(item.id)}
            >
              <CornerUpLeft size={14} aria-hidden />
            </button>
            <button
              className="queue-action"
              type="button"
              aria-label="重新编辑排队消息"
              title="重新编辑"
              onClick={() => onEdit(item.id)}
            >
              <Pencil size={13} aria-hidden />
            </button>
            <button
              className="queue-action danger"
              type="button"
              aria-label="删除排队消息"
              title="删除"
              onClick={() => onRemove(item.id)}
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
