'use client';

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

const FIELD_BASE =
  'w-full rounded-xl border bg-white px-3.5 text-ink shadow-input placeholder:text-ink-muted/60 transition-all duration-150 hover:border-ink-muted/40 focus:outline-none focus:ring-4 focus:ring-signal/15 focus:border-signal disabled:bg-paper disabled:text-ink-muted disabled:shadow-none';

function FieldFrame({
  id,
  label,
  error,
  hint,
  trailing,
  children,
}: {
  id: string;
  label?: string;
  error?: string;
  hint?: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {(label || trailing) && (
        <div className="flex items-baseline justify-between">
          {label && (
            <label htmlFor={id} className="text-sm font-medium text-ink">
              {label}
            </label>
          )}
          {trailing}
        </div>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-ink-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  trailing?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, trailing, className = '', id, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldFrame id={fieldId} label={label} error={error} hint={hint} trailing={trailing}>
      <input
        ref={ref}
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        className={`${FIELD_BASE} h-11 ${error ? 'border-danger' : 'border-line'} ${className}`}
        {...rest}
      />
    </FieldFrame>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
  trailing?: ReactNode;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, hint, trailing, className = '', id, rows = 6, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldFrame id={fieldId} label={label} error={error} hint={hint} trailing={trailing}>
      <textarea
        ref={ref}
        id={fieldId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        className={`${FIELD_BASE} resize-y py-2.5 leading-relaxed ${error ? 'border-danger' : 'border-line'} ${className}`}
        {...rest}
      />
    </FieldFrame>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, hint, className = '', id, children, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldFrame id={fieldId} label={label} error={error} hint={hint}>
      <select
        ref={ref}
        id={fieldId}
        aria-invalid={error ? true : undefined}
        className={`${FIELD_BASE} h-11 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%228%22%20viewBox%3D%220%200%2012%208%22%3E%3Cpath%20fill%3D%22%235B6475%22%20d%3D%22M6%208%200%200h12z%22%2F%3E%3C%2Fsvg%3E')] bg-[length:10px] bg-[position:right_14px_center] bg-no-repeat pr-9 ${
          error ? 'border-danger' : 'border-line'
        } ${className}`}
        {...rest}
      >
        {children}
      </select>
    </FieldFrame>
  );
});
