'use client';

import { DAY_KEYS, DAY_LABELS, type BusinessHours, type DayKey } from '@/domain/agent-config';

export function BusinessHoursEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: BusinessHours;
  onChange: (next: BusinessHours) => void;
  disabled?: boolean;
}) {
  function patchDay(day: DayKey, patch: Partial<BusinessHours[DayKey]>) {
    onChange({ ...value, [day]: { ...value[day], ...patch } });
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line">
      {DAY_KEYS.map((day, index) => {
        const row = value[day];
        const overnight = row.enabled && row.close <= row.open;
        return (
          <div
            key={day}
            className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${
              index > 0 ? 'border-t border-line' : ''
            } ${row.enabled ? 'bg-white' : 'bg-paper/70'}`}
          >
            <label className="flex w-36 cursor-pointer items-center gap-2.5">
              <input
                type="checkbox"
                checked={row.enabled}
                disabled={disabled}
                onChange={(e) => patchDay(day, { enabled: e.target.checked })}
                className="h-4 w-4 rounded border-line text-signal accent-signal focus:ring-signal"
              />
              <span className={`text-sm font-medium ${row.enabled ? 'text-ink' : 'text-ink-muted'}`}>
                {DAY_LABELS[day]}
              </span>
            </label>
            {row.enabled ? (
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  value={row.open}
                  disabled={disabled}
                  onChange={(e) => patchDay(day, { open: e.target.value })}
                  aria-label={`${DAY_LABELS[day]} opening time`}
                  className="h-9 rounded-lg border border-line bg-white px-2 font-mono text-sm text-ink focus:border-signal focus:outline-none focus:ring-1 focus:ring-signal"
                />
                <span className="text-sm text-ink-muted">to</span>
                <input
                  type="time"
                  value={row.close}
                  disabled={disabled}
                  onChange={(e) => patchDay(day, { close: e.target.value })}
                  aria-label={`${DAY_LABELS[day]} closing time`}
                  className="h-9 rounded-lg border border-line bg-white px-2 font-mono text-sm text-ink focus:border-signal focus:outline-none focus:ring-1 focus:ring-signal"
                />
                {overnight && (
                  <span className="text-xs text-construction" title="Closing time is on the next day">
                    overnight
                  </span>
                )}
              </div>
            ) : (
              <span className="text-sm text-ink-muted">Closed — calls go to voicemail</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
