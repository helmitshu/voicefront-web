'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Spinner } from '@/components/ui/Spinner';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-gradient-to-b from-signal to-signal-deep text-white shadow-pop hover:brightness-110 active:translate-y-px active:brightness-95 disabled:from-signal/50 disabled:to-signal/50 disabled:shadow-none',
  secondary:
    'bg-white text-ink border border-line shadow-input hover:border-ink-muted/40 hover:bg-paper active:translate-y-px disabled:text-ink-muted/60 disabled:shadow-none',
  ghost: 'bg-transparent text-ink-muted hover:bg-ink/5 hover:text-ink disabled:text-ink-muted/50',
  danger:
    'bg-gradient-to-b from-danger to-[#c23842] text-white shadow-[0_1px_2px_rgba(214,69,80,0.4),0_8px_20px_-6px_rgba(214,69,80,0.4)] hover:brightness-110 active:translate-y-px disabled:from-danger/50 disabled:to-danger/50 disabled:shadow-none',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, disabled, children, className = '', type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex select-none items-center justify-center rounded-full font-medium transition-all duration-200 ease-smooth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});
