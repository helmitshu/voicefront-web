'use client';

interface Turn {
  role: 'assistant' | 'caller' | 'system';
  text: string;
}

const SPEAKER_PATTERN = /^(AI|Assistant|Bot|Agent|User|Caller|Customer|Human)\s*:\s*(.*)$/i;

/**
 * Provider transcripts arrive as plain text with "AI:" / "User:" line
 * prefixes. Lines without a prefix continue the previous speaker's turn;
 * anything before the first prefix renders as a system note.
 */
export function parseTranscript(raw: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = SPEAKER_PATTERN.exec(trimmed);
    if (match) {
      const speaker = match[1].toLowerCase();
      const role: Turn['role'] = ['ai', 'assistant', 'bot', 'agent'].includes(speaker) ? 'assistant' : 'caller';
      turns.push({ role, text: match[2] });
    } else if (turns.length > 0) {
      turns[turns.length - 1].text += `\n${trimmed}`;
    } else {
      turns.push({ role: 'system', text: trimmed });
    }
  }
  return turns;
}

export function TranscriptView({ transcript, personaName }: { transcript: string; personaName: string }) {
  const turns = parseTranscript(transcript);

  if (turns.length === 0) {
    return <p className="text-sm text-ink-muted">The transcript for this call is empty.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {turns.map((turn, index) =>
        turn.role === 'system' ? (
          <p key={index} className="text-center text-xs text-ink-muted">
            {turn.text}
          </p>
        ) : (
          <div
            key={index}
            className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
              turn.role === 'assistant' ? 'self-start bg-signal-soft text-ink' : 'self-end bg-ink text-white'
            }`}
          >
            <span className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide opacity-60">
              {turn.role === 'assistant' ? personaName : 'Caller'}
            </span>
            {turn.text}
          </div>
        ),
      )}
    </div>
  );
}
