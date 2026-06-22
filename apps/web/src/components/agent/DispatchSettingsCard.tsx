'use client';

import { useEffect, useState } from 'react';
import { AgentApi, FeaturesApi, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';

interface Contact {
  name: string;
  phone: string;
}

/**
 * On-call roster editor for the ON_CALL_DISPATCH feature. Only renders when the
 * operator has entitled the feature for this workspace. The receptionist rings
 * these contacts top-to-bottom on an emergency, escalating to the next when one
 * doesn't accept — so the order matters, hence the move up/down controls.
 */
export function DispatchSettingsCard() {
  const { toast } = useToast();
  const [show, setShow] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [roster, setRoster] = useState<Contact[]>([]);
  const [escalation, setEscalation] = useState('120');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([FeaturesApi.list(), AgentApi.get()])
      .then(([{ features }, { settings }]) => {
        if (!alive) return;
        const f = features.find((x) => x.key === 'ON_CALL_DISPATCH');
        // Show the editor whenever the operator has made the feature available
        // to this workspace, so they can set up the roster before flipping it on.
        setShow(!!f && f.available && f.entitled);
        setEnabled(!!f && f.effective);
        setRoster(settings.onCallRoster ?? []);
        setEscalation(String(settings.dispatchEscalationSeconds ?? 120));
      })
      .catch(() => alive && setShow(false));
    return () => {
      alive = false;
    };
  }, []);

  function update(i: number, patch: Partial<Contact>) {
    setRoster((r) => r.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function move(i: number, dir: -1 | 1) {
    setRoster((r) => {
      const j = i + dir;
      if (j < 0 || j >= r.length) return r;
      const copy = [...r];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }

  async function save() {
    const cleaned = roster
      .map((c) => ({ name: c.name.trim(), phone: c.phone.replace(/[\s().-]/g, '') }))
      .filter((c) => c.name && c.phone);
    setSaving(true);
    try {
      await AgentApi.update({
        onCallRoster: cleaned,
        dispatchEscalationSeconds: Math.min(600, Math.max(30, Number(escalation) || 120)),
      });
      setRoster(cleaned);
      toast('On-call roster saved.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save. Check the phone numbers.', 'error');
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
        title="On-call dispatch"
        description="When an emergency comes in, the receptionist rings these people in order and escalates to the next if there’s no answer — then tells the caller help is on the way."
      />
      {!enabled && (
        <p className="mb-4 rounded-xl border border-construction/30 bg-construction-soft/50 px-4 py-2.5 text-[13px] font-medium text-construction">
          Dispatch is currently off — turn on “On-call dispatch & escalation” under Add-on features to use this roster.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {roster.length === 0 && (
          <p className="text-sm text-ink-muted">No one on call yet. Add your first contact below.</p>
        )}
        {roster.map((c, i) => (
          <div key={i} className="flex items-end gap-2">
            <span className="pb-2.5 font-mono text-xs font-semibold text-ink-muted">{i + 1}</span>
            <div className="flex-1">
              <Input label={i === 0 ? 'Name' : undefined} value={c.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Mike (on-call)" />
            </div>
            <div className="flex-1">
              <Input label={i === 0 ? 'Mobile' : undefined} value={c.phone} onChange={(e) => update(i, { phone: e.target.value })} placeholder="+15551234567" className="font-mono" />
            </div>
            <div className="flex items-center gap-1 pb-1">
              <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="rounded-md px-1.5 py-1 text-ink-muted transition-colors hover:bg-paper hover:text-ink disabled:opacity-30">↑</button>
              <button type="button" aria-label="Move down" disabled={i === roster.length - 1} onClick={() => move(i, 1)} className="rounded-md px-1.5 py-1 text-ink-muted transition-colors hover:bg-paper hover:text-ink disabled:opacity-30">↓</button>
              <button type="button" aria-label="Remove" onClick={() => setRoster((r) => r.filter((_, idx) => idx !== i))} className="rounded-md px-2 py-1 text-[13px] font-medium text-ink-muted transition-colors hover:bg-danger-soft/60 hover:text-danger">Remove</button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <Button variant="secondary" size="sm" onClick={() => setRoster((r) => (r.length < 10 ? [...r, { name: '', phone: '' }] : r))} disabled={roster.length >= 10}>
          + Add contact
        </Button>
        <div className="w-40">
          <Input
            label="Escalate after (seconds)"
            type="number"
            min={30}
            max={600}
            value={escalation}
            onChange={(e) => setEscalation(e.target.value)}
            hint="Wait this long for an accept before ringing the next person."
          />
        </div>
      </div>

      <div className="mt-5 flex justify-end">
        <Button loading={saving} onClick={save}>Save roster</Button>
      </div>
    </Card>
  );
}
