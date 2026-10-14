import type { Metadata } from 'next';
import { LegalShell, LegalSection } from '@/components/marketing/LegalShell';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How VoiceFront collects, uses, and protects personal information.',
};

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" lastUpdated="October 14, 2026">
      <p>
        VoiceFront is an AI receptionist service for clinics and service businesses. Our receptionist answers
        phone calls, books appointments, and takes messages on behalf of the businesses that use it. This policy
        explains, in plain language, what personal information we collect, why we collect it, and the choices
        you have.
      </p>

      <LegalSection heading="Who we are">
        <p>
          VoiceFront provides the service described on this site. If you have a question about privacy or about
          this policy, contact our privacy contact at{' '}
          <a href="mailto:helmitshu@gmail.com" className="font-medium text-signal-deep underline">
            helmitshu@gmail.com
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection heading="What we collect">
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong>Account information.</strong> When you sign up, we collect your name, your email address, and
            details about your business. If you sign up with Google, we receive your name and email address from
            Google. We use this information only to create your account and keep it secure.
          </li>
          <li>
            <strong>Call data.</strong> When our receptionist answers calls for a clinic, we handle the call
            audio, the transcript, a summary of the call, and the appointment details the caller shares. The
            clinic can see these records in its account.
          </li>
          <li>
            <strong>Demo information.</strong> When a visitor asks us to place a demo call, we collect their
            name, email address, phone number, and business website so we can place the demo call.
          </li>
          <li>
            <strong>Technical data.</strong> We collect basic technical data, such as log records, that we need
            to run the site, keep it secure, and fix problems.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="Signing in with Google">
        <p>
          You can sign in to VoiceFront with your Google account. When you do, Google sends us your name, your
          email address, and your profile picture. We use this information only to create your account and sign
          you in. Signing in with Google does not give us access to your Gmail, your Drive, or any other Google
          data.
        </p>
        <p>
          A clinic can also choose to connect its calendar to VoiceFront. We use a connected calendar only to
          check availability and book appointments.
        </p>
      </LegalSection>

      <LegalSection heading="How we use information">
        <p>
          We use the information we collect to run the answering and booking service, to show each clinic its own
          call records, to keep the service working and secure, to improve the service, and to meet our legal
          obligations.
        </p>
        <p>
          We do not sell personal information. We never use one clinic&rsquo;s call data for another clinic, and
          we do not use call data to train models for other customers.
        </p>
      </LegalSection>

      <LegalSection heading="Who processes information for us">
        <p>
          We use other companies to help us run VoiceFront. Our cloud hosting providers store and run the
          service. Our telephony providers connect and carry the phone calls. Our AI and speech providers turn
          speech into text, work out what callers are asking for, and produce the voice that answers. These
          providers process information only so we can provide the service.
        </p>
      </LegalSection>

      <LegalSection heading="How long we keep information">
        <p>
          We keep account information and call data while an account is active. A clinic can ask us to delete
          its data at any time by contacting us. When a clinic asks, we delete its data within a reasonable
          period, except for any records the law requires us to keep.
        </p>
      </LegalSection>

      <LegalSection heading="Security">
        <p>
          We encrypt data while it travels between systems. We limit access to personal information to the
          people and systems that need it to run the service. We store passwords as hashes, never as plain text.
          When you sign in with Google, Google runs the sign in itself, and we never see your Google password.
        </p>
      </LegalSection>

      <LegalSection heading="Privacy law in Canada">
        <p>
          VoiceFront is based in Canada. We handle personal information in line with Canada&rsquo;s PIPEDA and
          with the provincial privacy laws that apply to us. You can ask us what personal information we hold
          about you, and you can ask us to correct anything that is wrong.
        </p>
      </LegalSection>

      <LegalSection heading="Changes to this policy">
        <p>
          We may update this policy from time to time. When we do, we will post the updated policy on this page
          and change the date at the top.
        </p>
      </LegalSection>

      <LegalSection heading="Contact us">
        <p>
          For anything about privacy or this policy, contact our privacy contact at{' '}
          <a href="mailto:helmitshu@gmail.com" className="font-medium text-signal-deep underline">
            helmitshu@gmail.com
          </a>
          .
        </p>
      </LegalSection>
    </LegalShell>
  );
}
