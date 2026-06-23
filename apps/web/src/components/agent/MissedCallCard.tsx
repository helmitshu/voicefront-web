'use client';

import { useEffect, useState } from 'react';
import { AgentApi, FeaturesApi, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';

const DEFAULT_TEMPLATE =
  "Hi, this is {businessName} — sorry we couldn't finish up on your call just now. Reply here and we'll get someone out to help. Reply STOP to opt out.";

/**
 * Message editor for the MISSED_CALL_TEXTBACK feature — the text sent when a
 * caller hangs up without booking or leaving a job. Only renders once the
 * operator has entitled the feature. Blank = the platform default.
 */
export function MissedCallCard() {
  const { toast } = useToast();
  const [show, setShow] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [template, setTemplate] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([FeaturesApi.list(), AgentApi.get()])
      .then(([{ features }, { settings }]) => {
        if (!alive) return;
        const f = features.find((x) => x.key === 'MISSED_CALL_TEXTBACK');
        setShow(!!f && f.available && f.entitled);
        setEnabled(!!f && f.effective);
        setTemplate(settings.missedCallTemplate ?? '');
      })
      .catch(() => alive && setShow(false));
    return () => {
      alive = false;
    };
  }, []);

  async function save() {
    setSaving(true);
    try {
      await AgentApi.update({ missedCallTemplate: template.trim() });
      toast('Message saved.', 'success');
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
        title="Missed-call text-back"
        description="When a caller hangs up without booking or leaving a job, the receptionist texts them so the lead isn’t lost."
      />
      {!enabled && (
        <p className="mb-4 rounded-xl border border-construction/30 bg-construction-soft/50 px-4 py-2.5 text-[13px] font-medium text-construction">
          Text-back is off — turn on “Missed-call text-back” under Add-on features to use this.
        </p>
      )}
      <Textarea
        label="Message"
        rows={3}
        value={template}
        onChange={(e) => setTemplate(e.target.value)}
        placeholder={DEFAULT_TEMPLATE}
        hint="Use {businessName} for your company name. Leave blank to use the default above."
        maxLength={320}
      />
      <div className="mt-5 flex justify-end">
        <Button loading={saving} onClick={save}>Save message</Button>
      </div>
    </Card>
  );
}
