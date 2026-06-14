'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AgentApi,
  ApiError,
  CallsApi,
  mediaUrl,
  type CallDetailDto,
} from '@/lib/api';
import { formatCents, formatDateTime, formatDuration, formatPhone } from '@/lib/format';
import { Card, CardHeader, CallStatusBadge, EmptyState } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { AudioPlayer } from '@/components/calls/AudioPlayer';
import { TranscriptView } from '@/components/calls/TranscriptView';

const CHANNEL_LABEL: Record<string, string> = {
  phone: 'Phone call',
  web: 'Browser test',
};

export default function CallDetailPage({ params }: { params: { id: string } }) {
  const [call, setCall] = useState<CallDetailDto | null>(null);
  const [mediaToken, setMediaToken] = useState<string | null>(null);
  const [personaName, setPersonaName] = useState('Receptionist');
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      CallsApi.detail(params.id),
      // Persona name is cosmetic — fall back quietly if it can't load.
      AgentApi.get().catch(() => null),
    ])
      .then(([detail, settingsRes]) => {
        if (cancelled) return;
        setCall(detail.call);
        setMediaToken(detail.mediaToken);
        if (settingsRes) setPersonaName(settingsRes.settings.displayName);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError) setError({ status: err.status, message: err.message });
        else setError({ status: 0, message: 'Could not load this call.' });
      });
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  if (error) {
    return (
      <EmptyState
        title={error.status === 404 ? 'Call not found' : "Couldn't load this call"}
        description={
          error.status === 404
            ? 'It may have been removed, or the link is for a different workspace.'
            : error.message
        }
        action={
          <Link href="/dashboard/calls">
            <Button variant="secondary">Back to call history</Button>
          </Link>
        }
      />
    );
  }

  if (!call) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-signal" />
      </div>
    );
  }

  const meta: Array<{ label: string; value: string }> = [
    { label: 'Duration', value: formatDuration(call.durationSeconds) },
    { label: 'Cost', value: formatCents(call.costCents) },
    { label: 'Channel', value: CHANNEL_LABEL[call.channel] ?? call.channel },
    { label: 'Started', value: formatDateTime(call.startedAt) },
  ];
  if (call.endedAt) meta.push({ label: 'Ended', value: formatDateTime(call.endedAt) });

  return (
    <div className="flex animate-fade-up flex-col gap-6">
      <div>
        <Link
          href="/dashboard/calls"
          className="group inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted transition-colors hover:text-signal-deep"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="h-3.5 w-3.5 transition-transform duration-150 group-hover:-translate-x-0.5"
          >
            <path d="M10 3 5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Call history
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">
            {formatPhone(call.callerNumber)}
          </h2>
          <CallStatusBadge status={call.status} />
        </div>
        <p className="mt-1.5 text-sm text-ink-muted">{formatDateTime(call.startedAt)}</p>
      </div>

      <Card>
        <CardHeader title="Recording" />
        {mediaToken ? (
          <AudioPlayer src={mediaUrl(mediaToken)} fallbackDurationSeconds={call.durationSeconds} />
        ) : (
          <p className="rounded-xl bg-paper px-4 py-3 text-sm text-ink-muted">
            No recording is available for this call.
          </p>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="AI summary" />
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
              {call.summary ?? 'No summary was generated for this call.'}
            </p>
          </Card>

          <Card>
            <CardHeader title="Transcript" />
            {call.transcript ? (
              <TranscriptView transcript={call.transcript} personaName={personaName} />
            ) : (
              <p className="text-sm text-ink-muted">No transcript is available for this call.</p>
            )}
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader title="Details" />
          <dl className="flex flex-col divide-y divide-line/60">
            {meta.map((item) => (
              <div key={item.label} className="flex items-baseline justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <dt className="text-[13px] text-ink-muted">{item.label}</dt>
                <dd className="text-right font-mono text-[13px] font-medium text-ink">{item.value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );
}
