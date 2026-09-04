import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
};

export function Dialog({ open, onClose, title, children, className }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const handleClose = () => {
    returnFocusTo.current?.focus();
    returnFocusTo.current = null;
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={handleClose}
      className={cn(
        'm-auto w-full max-w-lg rounded-lg border border-border bg-surface p-6 text-text shadow-md backdrop:bg-text/50',
        className,
      )}
    >
      <h2 id={titleId} className="font-display text-xl">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </dialog>
  );
}
