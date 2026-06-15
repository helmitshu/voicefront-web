'use client';

import { useEffect, useRef, useState } from 'react';
import { DocumentsApi, ApiError, type DocumentDto } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';

/** Common business document formats Vapi can index (mirrors the API allowlist). */
const ACCEPT = '.pdf,.txt,.doc,.docx,.csv,.md,.tsv,.yaml,.yml,.json,.xml,.log';
const MAX_BYTES = 20 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusBadge(status: string) {
  if (status === 'done') return <Badge tone="success" dot>Ready</Badge>;
  if (status === 'failed') return <Badge tone="danger" dot>Failed</Badge>;
  return <Badge tone="warning" dot>Processing</Badge>;
}

export function DocumentsEditor({
  disabled = false,
  assistantConnected = false,
}: {
  disabled?: boolean;
  /** When true, uploads/removals push to the live voice agent — affects the note we show. */
  assistantConnected?: boolean;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [documents, setDocuments] = useState<DocumentDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    DocumentsApi.list()
      .then(({ documents }) => {
        if (!cancelled) setDocuments(documents);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : 'Could not load documents.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset the input so picking the same file again still fires onChange.
    event.target.value = '';
    if (!file) return;

    if (file.size === 0) {
      toast('That file looks empty.', 'error');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast('That file is over the 20 MB limit.', 'error');
      return;
    }

    setUploading(true);
    try {
      const { document, sync } = await DocumentsApi.upload(file);
      setDocuments((current) => [document, ...(current ?? [])]);
      toast(`Added “${document.fileName}” to your receptionist's knowledge.`, 'success');
      if (assistantConnected && sync && !sync.synced && sync.reason) toast(sync.reason, 'info');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Upload failed. Please try again.', 'error');
    } finally {
      setUploading(false);
    }
  }

  async function onRemove(doc: DocumentDto) {
    setRemovingId(doc.id);
    try {
      await DocumentsApi.remove(doc.id);
      setDocuments((current) => (current ?? []).filter((d) => d.id !== doc.id));
      toast(`Removed “${doc.fileName}”.`, 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not remove that document.', 'error');
    } finally {
      setRemovingId(null);
    }
  }

  if (loadError) {
    return (
      <p className="rounded-xl border border-danger/20 bg-danger-soft/40 px-4 py-3 text-sm text-danger">
        {loadError}
      </p>
    );
  }

  if (documents === null) {
    return (
      <div className="flex h-20 items-center justify-center">
        <Spinner className="h-5 w-5 text-signal" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={onPick}
        disabled={disabled || uploading}
      />

      {documents.length === 0 ? (
        <EmptyState
          title="No documents yet"
          description="Upload a file with your services, pricing, promotions, location, parking, or insurance info — your receptionist will answer callers' questions from it."
          action={
            !disabled && (
              <Button loading={uploading} onClick={() => inputRef.current?.click()}>
                Upload a document
              </Button>
            )
          }
        />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {documents.map((doc) => (
              <li
                key={doc.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-line/70 bg-paper/50 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-signal-soft/60 text-signal-deep ring-1 ring-inset ring-signal/15"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-4 w-4">
                      <path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z" />
                      <path d="M9 1.5V5.5H13" />
                    </svg>
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{doc.fileName}</p>
                    <p className="text-xs text-ink-muted">{formatBytes(doc.sizeBytes)}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {statusBadge(doc.status)}
                  {!disabled && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={removingId === doc.id}
                      onClick={() => onRemove(doc)}
                      aria-label={`Remove ${doc.fileName}`}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {!disabled && (
            <div>
              <Button variant="secondary" loading={uploading} onClick={() => inputRef.current?.click()}>
                Upload another
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
