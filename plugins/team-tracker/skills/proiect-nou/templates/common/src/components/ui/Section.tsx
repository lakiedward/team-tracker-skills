import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

type SectionProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  stableKey: string;
  title?: ReactNode;
  description?: ReactNode;
};

export function Section({ stableKey, title, description, className, children, ...rest }: SectionProps) {
  const hasHeading = Boolean(title || description);

  return (
    <section data-section={stableKey} className={cn('px-4 py-12 md:px-8', className)} {...rest}>
      {title && <h2 className="font-display text-2xl text-text">{title}</h2>}
      {description && <p className="mt-2 text-base text-muted">{description}</p>}
      <div className={cn(hasHeading && 'mt-6')}>{children}</div>
    </section>
  );
}
