import type { Metadata } from 'next';
import { LegalShell, LegalSection } from '@/components/marketing/LegalShell';

export const metadata: Metadata = {
  title: 'Privacy Policy — VoiceFront',
  description: 'How VoiceFront collects, uses, and protects personal information.',
};

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" lastUpdated="June 27, 2026">
      <p>
        This Privacy Policy explains how <strong>[LEGAL ENTITY NAME]</strong> (&ldquo;VoiceFront,&rdquo;
        &ldquo;we&rdquo;) collects, uses, and shares information when you use our AI receptionist platform (the
        &ldquo;Service&rdquo;). For business customers, you are the controller of your callers&rsquo; data and we
        process it on your behalf as described in our Terms of Service.
      </p>

      <LegalSection heading="Information we collect">
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong>Account information</strong> — business name, your name, email, password, and workspace
            settings.
          </li>
          <li>
            <strong>Call data</strong> — audio recordings, transcripts, AI-generated summaries and call outcomes,
            caller phone numbers, call duration, and timing.
          </li>
          <li>
            <strong>Appointment &amp; message data</strong> — names, phone numbers, requested times, job details,
            and other information callers provide.
          </li>
          <li>
            <strong>Integration data</strong> — calendar availability and events, and uploaded knowledge-base
            documents, when you connect those features.
          </li>
          <li>
            <strong>Usage &amp; technical data</strong> — log data and metrics used to operate, secure, and
            improve the Service.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="Call recording and SMS">
        <p>
          The Service records and transcribes calls so they can be summarized and stored in your dashboard. You
          are responsible for providing any recording notices or consents required in your jurisdiction. Where
          you enable SMS, message recipients can opt out by replying STOP, and we honor those opt-outs.
        </p>
      </LegalSection>

      <LegalSection heading="How we use information">
        <p>
          We use information to provide the Service (answering calls, booking, messaging), to display your call
          history and analytics, to secure and troubleshoot the platform, to bill for usage, and to improve the
          Service. We do not sell personal information.
        </p>
      </LegalSection>

      <LegalSection heading="Service providers (sub-processors)">
        <p>We share data with vendors that help us run the Service, only as needed to provide it:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li><strong>Vapi</strong> — telephony and voice-agent orchestration.</li>
          <li><strong>OpenAI</strong> — the language model that powers the receptionist.</li>
          <li><strong>Deepgram</strong> — speech-to-text transcription.</li>
          <li><strong>Twilio</strong> — SMS and, where used, voice connectivity.</li>
          <li><strong>Google</strong> — calendar integration and knowledge-base file search, when connected.</li>
          <li><strong>Railway</strong> — application hosting and database infrastructure.</li>
        </ul>
        <p>We may also disclose information to comply with law or to protect rights, safety, and our Service.</p>
      </LegalSection>

      <LegalSection heading="Data retention">
        <p>
          We retain account and call records for as long as your workspace is active. Call transcripts and
          recordings are scrubbed after a retention period (currently 365 days), keeping non-sensitive billing and
          analytics metadata. If a workspace is deleted, it is recoverable for a short window (currently 30 days)
          and then permanently purged. Specific retention periods may be set out in your agreement.
        </p>
      </LegalSection>

      <LegalSection heading="Security">
        <p>
          We use technical and organizational measures to protect information, including encryption of sensitive
          configuration values and access controls. No method of transmission or storage is perfectly secure, and
          we cannot guarantee absolute security.
        </p>
      </LegalSection>

      <LegalSection heading="Your rights">
        <p>
          Depending on your location, you may have rights to access, correct, delete, or export personal
          information, or to object to or restrict certain processing (for example, under GDPR or CCPA). For
          caller data processed on a business customer&rsquo;s behalf, please direct requests to that business;
          we will assist them as required. To exercise rights or ask questions, contact us at{' '}
          <strong>[CONTACT EMAIL]</strong>.
        </p>
      </LegalSection>

      <LegalSection heading="International transfers and children">
        <p>
          We may process information in countries other than yours, with appropriate safeguards where required.
          The Service is for businesses and is not directed to children under 18.
        </p>
      </LegalSection>

      <LegalSection heading="Changes and contact">
        <p>
          We may update this Policy from time to time and will update the date above. Questions or requests can be
          sent to <strong>[CONTACT EMAIL]</strong>, <strong>[LEGAL ENTITY NAME, MAILING ADDRESS]</strong>.
        </p>
      </LegalSection>
    </LegalShell>
  );
}
