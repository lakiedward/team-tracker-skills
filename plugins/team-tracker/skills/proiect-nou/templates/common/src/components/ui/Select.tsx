import { useId, type SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type SelectOption = {
  value: string;
  label: string;
};

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  options: SelectOption[];
  placeholder?: string;
  error?: string;
};

const field =
  'h-10 w-full rounded-md border bg-surface px-3 text-base text-text focus:outline-none focus:ring-2 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50';

export function Select({ label, options, placeholder, error, className, id, ...rest }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const errorId = `${selectId}-error`;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={selectId} className="text-sm font-semibold text-text">
        {label}
      </label>
      <select
        id={selectId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cn(field, error ? 'border-danger' : 'border-border')}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
