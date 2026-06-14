'use client';

export interface StepDescriptor {
  key: string;
  title: string;
  description: string;
}

export function ProgressSteps({
  steps,
  currentIndex,
  completedCount,
  onSelect,
}: {
  steps: StepDescriptor[];
  currentIndex: number;
  /** Steps 0..completedCount-1 are done and revisitable. */
  completedCount: number;
  onSelect: (index: number) => void;
}) {
  return (
    <ol className="flex flex-col gap-1" aria-label="Setup progress">
      {steps.map((step, index) => {
        const done = index < completedCount;
        const current = index === currentIndex;
        const reachable = index <= completedCount;
        return (
          <li key={step.key}>
            <button
              type="button"
              disabled={!reachable}
              onClick={() => onSelect(index)}
              aria-current={current ? 'step' : undefined}
              className={`group flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                current ? 'bg-signal-soft' : reachable ? 'hover:bg-ink/5' : 'opacity-50'
              } ${reachable ? '' : 'cursor-not-allowed'}`}
            >
              <span
                aria-hidden
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  done
                    ? 'bg-signal text-white'
                    : current
                      ? 'border-2 border-signal text-signal-deep'
                      : 'border border-line text-ink-muted'
                }`}
              >
                {done ? '✓' : index + 1}
              </span>
              <span>
                <span className={`block text-sm font-semibold ${current ? 'text-signal-deep' : 'text-ink'}`}>
                  {step.title}
                </span>
                <span className="block text-xs text-ink-muted">{step.description}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
