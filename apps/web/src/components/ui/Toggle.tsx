'use client';

import { useId, type ReactNode } from 'react';

/**
 * Premium on/off switch matching the app's signal gradient + soft shadows.
 * Renders bare when no label is given (for inline use), or as a labeled row.
 */
export function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
  description,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  description?: ReactNode;
  id?: string;
}) {
  const autoId = useId();
  const fieldId = id ?? autoId;

  const sw = (
    <button
      type="button"
      role="switch"
      id={fieldId}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-smooth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-gradient-to-b from-signal to-signal-deep shadow-pop' : 'bg-ink/15'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-input transition-transform duration-200 ease-smooth ${
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );

  if (!label) return sw;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={fieldId} className="block cursor-pointer text-sm font-medium text-ink">
          {label}
        </label>
        {description && <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">{description}</p>}
      </div>
      {sw}
    </div>
  );
}
