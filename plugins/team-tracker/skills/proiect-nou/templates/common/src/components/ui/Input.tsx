import { useId, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
};

const field =
  'h-10 w-full rounded-md border bg-surface px-3 text-base text-text placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50';

export function Input({ label, hint, error, className, id, ...rest }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const messageId = `${inputId}-message`;
  const message = error ?? hint;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={inputId} className="text-sm font-semibold text-text">
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? messageId : undefined}
        className={cn(field, error ? 'border-danger' : 'border-border')}
        {...rest}
      />
      {message && (
        <p id={messageId} className={cn('text-sm', error ? 'text-danger' : 'text-muted')}>
          {message}
        </p>
      )}
    </div>
  );
}
