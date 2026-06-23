'use client';

import { useEffect, useState } from 'react';
import { AdminApi, ApiError, type FeatureState, type FeatureKey } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader } from '@/components/ui/Card';
import { Toggle } from '@/components/ui/Toggle';
import { Spinner } from '@/components/ui/Spinner';

/**
 * Operator control plane for a customer's gated features. Three switches per
 * feature encode the control model:
 *   - Entitled    — the master switch (off = feature unavailable to them).
 *   - Self-manage — may the customer flip the on/off from their own dashboard.
 *   - On now      — the actual state (operator sets it; client can too if granted).
 * Self-manage and On are inert until the feature is entitled.
 */
export function FeaturesPanel({ tenantId }: { tenantId: string }) {
  const { toast } = useToast();
  const [features, setFeatures] = useState<FeatureState[] | null>(null);
  const [busy, setBusy] = useState<FeatureKey | null>(null);

  useEffect(() => {
    let alive = true;
    AdminApi.listFeatures(tenantId)
      .then(({ features }) => alive && setFeatures(features))
      .catch(() => alive && setFeatures([]));
    return () => {
      alive = false;
    };
  }, [tenantId]);

  async function patch(f: FeatureState, change: Partial<{ entitled: boolean; selfManage: boolean; enabled: boolean }>) {
    setBusy(f.key);
    try {
      const { feature } = await AdminApi.setFeature(tenantId, f.key, change);
      setFeatures((cur) => cur?.map((x) => (x.key === feature.key ? feature : x)) ?? cur);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update.', 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Features"
        description="Grant optional capabilities, decide whether the customer can self-manage, and flip them on or off."
      />
      {features === null ? (
        <div className="flex h-24 items-center justify-center">
          <Spinner className="h-5 w-5 text-signal" />
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-line/60">
          {features.map((f) => (
            <div key={f.key} className="py-4 first:pt-0 last:pb-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-ink">{f.label}</p>
                {f.effective ? (
                  <span className="rounded-full bg-clinic-soft px-2 py-0.5 text-[11px] font-semibold text-[#0b8a74]">
                    Live
                  </span>
                ) : (
                  <span className="rounded-full bg-paper px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-inset ring-line">
                    Off
                  </span>
                )}
              </div>
              <p className="mt-0.5 max-w-prose text-[13px] leading-relaxed text-ink-muted">{f.description}</p>
              {!f.available && f.unavailableReason && (
                <p className="mt-1 text-[12px] font-medium text-construction">{f.unavailableReason}</p>
              )}
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Toggle
                  label="Entitled"
                  description="Available to this customer"
                  checked={f.entitled}
                  disabled={!f.available || busy === f.key}
                  onChange={(v) => patch(f, { entitled: v })}
                />
                <Toggle
                  label="Self-manage"
                  description="Customer can toggle it"
                  checked={f.selfManage}
                  disabled={!f.entitled || busy === f.key}
                  onChange={(v) => patch(f, { selfManage: v })}
                />
                <Toggle
                  label="On now"
                  description="Current state"
                  checked={f.enabled}
                  disabled={!f.entitled || busy === f.key}
                  onChange={(v) => patch(f, { enabled: v })}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
