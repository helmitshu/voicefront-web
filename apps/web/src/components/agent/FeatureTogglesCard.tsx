'use client';

import { useEffect, useState } from 'react';
import { FeaturesApi, ApiError, type FeatureState, type FeatureKey } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader } from '@/components/ui/Card';
import { Toggle } from '@/components/ui/Toggle';
import { Spinner } from '@/components/ui/Spinner';

/**
 * The customer's view of their gated add-on features. Only entitled features
 * show up; a feature the operator hasn't let them self-manage renders as a
 * read-only "Managed by VoiceFront" row, so the control model is visible but
 * the switch isn't theirs to flip. The server enforces all of this regardless.
 */
export function FeatureTogglesCard() {
  const { toast } = useToast();
  const [features, setFeatures] = useState<FeatureState[] | null>(null);
  const [saving, setSaving] = useState<FeatureKey | null>(null);

  useEffect(() => {
    let alive = true;
    FeaturesApi.list()
      .then(({ features }) => alive && setFeatures(features))
      .catch(() => alive && setFeatures([]));
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(feature: FeatureState, next: boolean) {
    setSaving(feature.key);
    // Optimistic flip; revert on failure.
    setFeatures((cur) => cur?.map((f) => (f.key === feature.key ? { ...f, enabled: next } : f)) ?? cur);
    try {
      const { feature: updated } = await FeaturesApi.setEnabled(feature.key, next);
      setFeatures((cur) => cur?.map((f) => (f.key === updated.key ? updated : f)) ?? cur);
      toast(next ? `${feature.label} turned on.` : `${feature.label} turned off.`, 'success');
    } catch (err) {
      setFeatures((cur) => cur?.map((f) => (f.key === feature.key ? { ...f, enabled: !next } : f)) ?? cur);
      toast(err instanceof ApiError ? err.message : 'Could not update.', 'error');
    } finally {
      setSaving(null);
    }
  }

  if (features === null) {
    return (
      <Card>
        <div className="flex h-24 items-center justify-center">
          <Spinner className="h-5 w-5 text-signal" />
        </div>
      </Card>
    );
  }

  // Only surface features the operator has entitled for this workspace.
  const visible = features.filter((f) => f.entitled);
  if (visible.length === 0) return null;

  return (
    <Card>
      <CardHeader title="Add-on features" description="Optional capabilities enabled for your workspace." />
      <div className="flex flex-col divide-y divide-line/60">
        {visible.map((f) => (
          <div key={f.key} className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-ink">{f.label}</p>
                {!f.selfManage && (
                  <span className="rounded-full bg-paper px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-inset ring-line">
                    Managed by VoiceFront
                  </span>
                )}
              </div>
              <p className="mt-0.5 max-w-prose text-[13px] leading-relaxed text-ink-muted">{f.description}</p>
              {!f.available && f.unavailableReason && (
                <p className="mt-1 text-[12px] font-medium text-construction">{f.unavailableReason}</p>
              )}
            </div>
            <Toggle
              checked={f.enabled}
              disabled={!f.available || !f.selfManage || saving === f.key}
              onChange={(next) => toggle(f, next)}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}
