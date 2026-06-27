import type { Metadata } from 'next';
import { LegalShell, LegalSection } from '@/components/marketing/LegalShell';

export const metadata: Metadata = {
  title: 'Terms of Service — VoiceFront',
  description: 'The terms that govern your use of the VoiceFront AI receptionist service.',
};

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Service" lastUpdated="June 27, 2026">
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use of the VoiceFront AI
        receptionist platform (the &ldquo;Service&rdquo;) operated by{' '}
        <strong>[LEGAL ENTITY NAME]</strong> (&ldquo;VoiceFront,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;). By
        creating a workspace or using the Service, you agree to these Terms on behalf of your business
        (&ldquo;Customer,&rdquo; &ldquo;you&rdquo;). If you do not agree, do not use the Service.
      </p>

      <LegalSection heading="1. The Service">
        <p>
          VoiceFront provides an AI-powered virtual receptionist that answers inbound phone calls, books and
          manages appointments, captures job and message requests, and transfers calls, on your behalf. The
          Service uses automated speech recognition, large language models, and text-to-speech, and may record
          and transcribe calls for quality, training, and record-keeping.
        </p>
      </LegalSection>

      <LegalSection heading="2. Accounts and eligibility">
        <p>
          Access is currently provided by invitation. You must provide accurate information, keep your
          credentials secure, and are responsible for all activity under your workspace. You must be at least 18
          and authorized to bind your business. You are responsible for your team members&rsquo; use of the
          Service.
        </p>
      </LegalSection>

      <LegalSection heading="3. Your responsibilities and compliance">
        <p>You are solely responsible for ensuring your use of the Service complies with all laws, including:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong>Call recording consent.</strong> Recording laws vary by jurisdiction, and some require all
            parties to consent. You are responsible for any disclosures or consents required for calls handled by
            the Service, including configuring an appropriate recording notice in your greeting.
          </li>
          <li>
            <strong>SMS and calling laws.</strong> If you enable SMS (confirmations, reminders, missed-call
            text-backs) or outbound calling, you are responsible for compliance with the TCPA, CAN-SPAM, A2P 10DLC
            registration, and obtaining any required consent from recipients.
          </li>
          <li>
            <strong>No sensitive data without arrangements.</strong> Do not use the Service to process protected
            health information (PHI) or other regulated data unless you have a separate written agreement with us
            (e.g., a Business Associate Agreement) permitting it.
          </li>
          <li>
            <strong>Lawful, non-abusive use.</strong> No unlawful, fraudulent, harassing, or infringing use, and
            no attempts to disrupt or reverse-engineer the Service.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="4. AI limitations — important">
        <p>
          The Service relies on automated AI that can misunderstand callers, mis-transcribe details, or produce
          incorrect responses. It is a productivity tool, not a substitute for professional judgment, and it does
          not provide medical, legal, financial, or other professional advice. You are responsible for reviewing
          appointments, messages, and other outputs, and for any decisions made based on them.
        </p>
      </LegalSection>

      <LegalSection heading="5. Fees and payment">
        <p>
          Fees, included call minutes, and any overage rates are as set out in your order, quote, or invoice.
          Unless stated otherwise, fees are billed in advance, are non-refundable except as required by law, and
          are exclusive of taxes. We may suspend or limit the Service for non-payment or when a usage limit is
          reached. We may change pricing on renewal with prior notice.
        </p>
      </LegalSection>

      <LegalSection heading="6. Third-party services">
        <p>
          The Service is built on third-party providers including Vapi, OpenAI, Deepgram, Twilio, Google, and
          Railway. Your use may be subject to their terms, and we are not responsible for their acts or
          omissions. Calendar and other integrations you connect are governed by those providers&rsquo; terms.
        </p>
      </LegalSection>

      <LegalSection heading="7. Data and privacy">
        <p>
          Our handling of personal information is described in our{' '}
          <a href="/privacy" className="font-medium text-signal-deep underline">
            Privacy Policy
          </a>
          . As between the parties, you own your customer and call data; you grant us a limited license to
          process it to provide and improve the Service, subject to the Privacy Policy.
        </p>
      </LegalSection>

      <LegalSection heading="8. Intellectual property">
        <p>
          We retain all rights in the Service, including our software, models, prompts, and branding. You retain
          rights in your data and content. Feedback you provide may be used by us without obligation.
        </p>
      </LegalSection>

      <LegalSection heading="9. Term, suspension, and termination">
        <p>
          These Terms apply while you use the Service. Either party may terminate as set out in your order or for
          material breach. We may suspend the Service for non-payment, legal risk, or abuse. On termination, your
          right to use the Service ends; we will handle your data as described in the Privacy Policy.
        </p>
      </LegalSection>

      <LegalSection heading="10. Disclaimers">
        <p>
          THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE,&rdquo; WITHOUT WARRANTIES OF ANY
          KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR
          PURPOSE, AND NON-INFRINGEMENT. We do not warrant that the Service will be uninterrupted, error-free, or
          that AI outputs will be accurate.
        </p>
      </LegalSection>

      <LegalSection heading="11. Limitation of liability">
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEITHER PARTY WILL BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL,
          CONSEQUENTIAL, OR EXEMPLARY DAMAGES, OR LOST PROFITS OR REVENUE. OUR TOTAL LIABILITY ARISING OUT OF OR
          RELATED TO THE SERVICE WILL NOT EXCEED THE AMOUNTS YOU PAID US IN THE <strong>[12]</strong> MONTHS
          BEFORE THE EVENT GIVING RISE TO THE CLAIM.
        </p>
      </LegalSection>

      <LegalSection heading="12. Indemnification">
        <p>
          You will indemnify and hold us harmless from claims arising out of your use of the Service in violation
          of these Terms or law, including claims relating to call recording, SMS, or data you process through the
          Service.
        </p>
      </LegalSection>

      <LegalSection heading="13. Changes to these Terms">
        <p>
          We may update these Terms from time to time. Material changes will be communicated, and continued use
          after the effective date constitutes acceptance.
        </p>
      </LegalSection>

      <LegalSection heading="14. Governing law and contact">
        <p>
          These Terms are governed by the laws of <strong>[GOVERNING LAW / JURISDICTION]</strong>, without regard
          to conflict-of-laws rules. Questions about these Terms can be sent to{' '}
          <strong>[CONTACT EMAIL]</strong>, <strong>[LEGAL ENTITY NAME, MAILING ADDRESS]</strong>.
        </p>
      </LegalSection>
    </LegalShell>
  );
}
