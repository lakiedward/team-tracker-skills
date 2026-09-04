import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { ToastContext, type ToastItem, type ToastTone } from './toastContext';

const TOAST_VISIBLE_MS = 4000;

const tones: Record<ToastTone, string> = {
  info: 'border-border text-text',
  success: 'border-accent text-text',
  danger: 'border-danger text-danger',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const show = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, TOAST_VISIBLE_MS);
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              'pointer-events-auto rounded-md border bg-surface px-4 py-3 text-sm shadow-md',
              tones[item.tone],
            )}
          >
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
