'use client';

import { useEffect, useState } from 'react';
import { AgentApi, FeaturesApi, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';

/**
 * Service-area editor for the SERVICE_AREA feature. The receptionist uses this
 * list to confirm a job address is in range before booking and to flag
 * out-of-area calls. Only renders once the operator has entitled the feature.
 */
export function ServiceAreaCard() {
  const { toast } = useToast();
  const [show, setShow] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [zipsText, setZipsText] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([FeaturesApi.list(), AgentApi.get()])
      .then(([{ features }, { settings }]) => {
        if (!alive) return;
        const f = features.find((x) => x.key === 'SERVICE_AREA');
        setShow(!!f && f.available && f.entitled);
        setEnabled(!!f && f.effective);
        setZipsText((settings.serviceAreaZips ?? []).join(', '));
        setNote(settings.serviceAreaNote ?? '');
      })
      .catch(() => alive && setShow(false));
    return () => {
      alive = false;
    };
  }, []);

  async function save() {
    const zips = zipsText
      .split(/[,\n]/)
      .map((z) => z.trim())
      .filter(Boolean)
      .slice(0, 60);
    setSaving(true);
    try {
      await AgentApi.update({ serviceAreaZips: zips, serviceAreaNote: note.trim() });
      setZipsText(zips.join(', '));
      toast('Service area saved.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save.', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (show === null) {
    return (
      <Card>
        <div className="flex h-20 items-center justify-center">
          <Spinner className="h-5 w-5 text-signal" />
        </div>
      </Card>
    );
  }
  if (!show) return null;

  return (
    <Card>
      <CardHeader
        title="Service area"
        description="The ZIP codes or cities you serve. The receptionist confirms a job address is in range before booking and flags out-of-area calls."
      />
      {!enabled && (
        <p className="mb-4 rounded-xl border border-construction/30 bg-construction-soft/50 px-4 py-2.5 text-[13px] font-medium text-construction">
          Service-area check is off — turn on “Service-area check” under Add-on features to use this.
        </p>
      )}
      <Textarea
        label="ZIP codes / cities"
        rows={3}
        value={zipsText}
        onChange={(e) => setZipsText(e.target.value)}
        placeholder="V5K, V5L, V6A, Burnaby, North Vancouver"
        hint="Separate with commas or new lines."
      />
      <div className="mt-4">
        <Input
          label="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Within 25 miles of downtown — travel fee beyond that"
          maxLength={200}
        />
      </div>
      <div className="mt-5 flex justify-end">
        <Button loading={saving} onClick={save}>Save service area</Button>
      </div>
    </Card>
  );
}
