import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

type CardProps = HTMLAttributes<HTMLDivElement>;

export function Card({ className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-surface p-6 text-text shadow-sm', className)}
      {...rest}
    >
      {children}
    </div>
  );
}
