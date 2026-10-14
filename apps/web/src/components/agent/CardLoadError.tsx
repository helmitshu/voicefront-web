'use client';

import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

/**
 * Honest failure state for a settings card whose data could not be loaded.
 * A load failure is NOT the same as "not configured" or "not entitled", and
 * the card must say which one happened — with a way to retry in place.
 */
export function CardLoadError({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader title={title} />
      <p className="mt-3 rounded-xl border border-danger/25 bg-danger-soft/50 px-4 py-4 text-sm text-ink">
        Couldn&apos;t load this section. {message}
      </p>
      <div className="mt-3">
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </Card>
  );
}
