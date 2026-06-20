'use client';

import { useEffect, useState } from 'react';
import { ApiError, ScreeningApi, type BlockedCallerDto, type ScreeningOverview } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Toggle } from '@/components/ui/Toggle';
import { Spinner } from '@/components/ui/Spinner';
import { formatPhone } from '@/lib/format';

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

interface CallScreeningCardProps {
  /** Opt-in: refuse calls with no caller ID. Part of the main settings save. */
  rejectAnonymous: boolean;
  onRejectAnonymousChange: (value: boolean) => void;
  readOnly: boolean;
}

/**
 * Spam / call screening. Two safe layers, both biased toward letting calls
 * through so a real customer is never silently refused:
 *   1. a manual block list (only numbers the owner explicitly blocks), and
 *   2. an OPT-IN anonymous-caller refusal (off by default).
 * The block list manages itself via its own endpoints; the anonymous toggle is
 * lifted to the parent so it saves with the rest of the receptionist settings.
 */
export function CallScreeningCard({ rejectAnonymous, onRejectAnonymousChange, readOnly }: CallScreeningCardProps) {
  const { toast } = useToast();
  const [data, setData] = useState<ScreeningOverview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [newNumber, setNewNumber] = useState('');
  const [newReason, setNewReason] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    ScreeningApi.overview()
      .then(setData)
      .catch(() => setLoadFailed(true));
  }, []);

  async function addBlock() {
    const phone = newNumber.replace(/[\s().-]/g, '');
    if (!E164_REGEX.test(phone)) {
      toast('Use a valid phone number, e.g. +15551234567.', 'error');
      return;
    }
    setAdding(true);
    try {
      const { blocked } = await ScreeningApi.block(phone, newReason.trim() || undefined);
      setData((d) =>
        d
          ? { ...d, blocked: [blocked, ...d.blocked.filter((b) => b.id !== blocked.id)] }
          : d,
      );
      setNewNumber('');
      setNewReason('');
      toast(`${formatPhone(blocked.phone)} will no longer be connected.`, 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not block that number.', 'error');
    } finally {
      setAdding(false);
    }
  }

  async function removeBlock(b: BlockedCallerDto) {
    setRemovingId(b.id);
    try {
      await ScreeningApi.unblock(b.id);
      setData((d) => (d ? { ...d, blocked: d.blocked.filter((x) => x.id !== b.id) } : d));
      toast(`${formatPhone(b.phone)} unblocked.`, 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not unblock that number.', 'error');
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Spam & call screening"
        description="Stop robocalls and known spammers from draining your minutes — without ever turning away a real customer. Only numbers you block here are refused."
      />

      {data && data.screenedLast30Days > 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-clinic/20 bg-clinic-soft/40 px-4 py-3">
          <span className="font-display text-2xl font-bold tabular-nums text-[#0b8a74]">
            {data.screenedLast30Days}
          </span>
          <p className="text-sm text-ink-muted">
            spam {data.screenedLast30Days === 1 ? 'call' : 'calls'} blocked in the last 30 days — none of
            them touched your minutes.
          </p>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-5">
        {/* Opt-in anonymous refusal */}
        <div className="flex items-center justify-between gap-4 rounded-xl border border-line/60 bg-paper/60 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-ink">Refuse calls with no caller ID</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              Off by default — some real customers withhold their number, so only turn this on if hidden-number
              robocalls are a problem for you.
            </p>
          </div>
          <Toggle checked={rejectAnonymous} onChange={onRejectAnonymousChange} disabled={readOnly} />
        </div>

        {/* Block list */}
        <div className="rounded-xl border border-line/60 bg-paper/40 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">Blocked numbers</p>

          {!readOnly && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
              <div className="sm:w-44">
                <Input
                  aria-label="Number to block"
                  placeholder="+15551234567"
                  value={newNumber}
                  onChange={(e) => setNewNumber(e.target.value)}
                  className="font-mono"
                />
              </div>
              <div className="flex-1">
                <Input
                  aria-label="Reason (optional)"
                  placeholder="Reason (optional) — e.g. robocall"
                  value={newReason}
                  onChange={(e) => setNewReason(e.target.value)}
                />
              </div>
              <Button size="sm" loading={adding} onClick={addBlock} className="sm:mt-0">
                Block
              </Button>
            </div>
          )}

          <div className="mt-4">
            {loadFailed ? (
              <p className="text-sm text-ink-muted">Couldn&apos;t load your blocked numbers.</p>
            ) : !data ? (
              <div className="flex h-12 items-center">
                <Spinner className="h-4 w-4 text-signal" />
              </div>
            ) : data.blocked.length === 0 ? (
              <p className="text-sm text-ink-muted">
                No blocked numbers yet. Block a spammer here, or from any call in your call history.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-line/60">
                {data.blocked.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-medium text-ink">{formatPhone(b.phone)}</p>
                      {b.reason && <p className="truncate text-xs text-ink-muted">{b.reason}</p>}
                    </div>
                    {!readOnly && (
                      <button
                        type="button"
                        disabled={removingId === b.id}
                        onClick={() => removeBlock(b)}
                        className="shrink-0 text-[13px] font-medium text-ink-muted transition-colors hover:text-danger disabled:opacity-50"
                      >
                        {removingId === b.id ? 'Removing…' : 'Unblock'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
