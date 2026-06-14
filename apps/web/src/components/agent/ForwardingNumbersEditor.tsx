'use client';

import { useId } from 'react';
import { E164_REGEX, type ForwardingNumber } from '@/domain/agent-config';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';

const MAX_LINES = 5;

export function validateForwardingNumbers(list: ForwardingNumber[]): Map<string, string> {
  const errors = new Map<string, string>();
  for (const entry of list) {
    if (entry.label.trim().length < 2) {
      errors.set(entry.id, 'Add a label (e.g. "Nurse line").');
    } else if (!E164_REGEX.test(entry.number.replace(/[\s().-]/g, ''))) {
      errors.set(entry.id, 'Use international format, e.g. +15551234567.');
    }
  }
  return errors;
}

export function ForwardingNumbersEditor({
  value,
  onChange,
  errors,
  disabled = false,
}: {
  value: ForwardingNumber[];
  onChange: (next: ForwardingNumber[]) => void;
  /** id → message map (from validateForwardingNumbers), shown inline. */
  errors?: Map<string, string>;
  disabled?: boolean;
}) {
  const idPrefix = useId();

  function patch(id: string, patchValue: Partial<ForwardingNumber>) {
    onChange(value.map((entry) => (entry.id === id ? { ...entry, ...patchValue } : entry)));
  }

  function remove(id: string) {
    onChange(value.filter((entry) => entry.id !== id));
  }

  function add() {
    if (value.length >= MAX_LINES) return;
    onChange([
      ...value,
      { id: `${idPrefix}-${Date.now()}-${value.length}`, label: '', number: '', whenToUse: '' },
    ]);
  }

  return (
    <div className="flex flex-col gap-4">
      {value.length === 0 && (
        <p className="rounded-xl bg-paper px-4 py-3 text-sm text-ink-muted">
          No transfer lines yet. Add one so the receptionist can hand urgent callers to a real person.
        </p>
      )}
      {value.map((entry, index) => (
        <div key={entry.id} className="rounded-2xl border border-line bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-ink">Transfer line {index + 1}</p>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => remove(entry.id)}>
              Remove
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Label"
              value={entry.label}
              disabled={disabled}
              onChange={(e) => patch(entry.id, { label: e.target.value })}
              placeholder="Nurse line"
            />
            <Input
              label="Phone number"
              value={entry.number}
              disabled={disabled}
              onChange={(e) => patch(entry.id, { number: e.target.value })}
              placeholder="+15551234567"
              inputMode="tel"
              error={errors?.get(entry.id)}
            />
          </div>
          <div className="mt-3">
            <Input
              label="When should the receptionist transfer here?"
              value={entry.whenToUse}
              disabled={disabled}
              onChange={(e) => patch(entry.id, { whenToUse: e.target.value })}
              placeholder="Clinical questions or urgent symptom concerns"
              hint="This guides the AI's judgement — callers never hear the number itself."
            />
          </div>
        </div>
      ))}
      {value.length < MAX_LINES && (
        <Button variant="secondary" size="sm" disabled={disabled} onClick={add} className="self-start">
          + Add transfer line
        </Button>
      )}
    </div>
  );
}
