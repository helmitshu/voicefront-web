import { describe, it, expect } from 'vitest';
import { validatePublicUrl, extractClinicFacts } from './clinic-facts.service';

/**
 * The clinic-facts puller takes a URL from a public form and fetches it
 * server-side, so the URL validation is an SSRF boundary: these tests pin
 * down that private/loopback/link-local literals, credentials, and
 * non-http(s) schemes are refused, and that extraction only ever returns
 * capped, script-free facts.
 */

const FIXTURE_HTML = `<!doctype html>
<html>
<head>
  <meta property="og:title" content="Maple Dental Studio | Vancouver Dentist" />
  <title>Maple Dental Studio | Vancouver Dentist</title>
  <script>var bait = "We also do dentures and root scaling";</script>
  <style>.x { content: "bridges bridges"; }</style>
</head>
<body>
  <header>
    <p>Call us at +1 (604) 555-0182 to book.</p>
    <p>2145 West 4th Avenue, Vancouver, BC</p>
  </header>
  <section>
    <h2>Our hours</h2>
    <p>Monday to Friday: 8:00 AM to 5:00 PM</p>
    <p>Saturday: 9:00 AM to 2:00 PM</p>
  </section>
  <section>
    <h2>Services</h2>
    <p>We offer gentle cleanings, thorough exams, natural-looking fillings and crowns,
       root canal therapy, dental implants, Invisalign, and teeth whitening.</p>
  </section>
</body>
</html>`;

describe('validatePublicUrl', () => {
  it('rejects loopback, link-local, and private IP literals', () => {
    expect(validatePublicUrl('http://127.0.0.1/x')).toBeNull();
    expect(validatePublicUrl('http://169.254.169.254/')).toBeNull();
    expect(validatePublicUrl('http://10.0.0.5/')).toBeNull();
    expect(validatePublicUrl('http://192.168.1.10/')).toBeNull();
    expect(validatePublicUrl('http://172.16.0.9/')).toBeNull();
    expect(validatePublicUrl('http://172.31.255.255/')).toBeNull();
    expect(validatePublicUrl('https://[::1]/')).toBeNull();
    expect(validatePublicUrl('https://[fd00::1]/')).toBeNull();
    expect(validatePublicUrl('https://[fe80::1]/')).toBeNull();
  });

  it('rejects non-http schemes, credentials, and localhost', () => {
    expect(validatePublicUrl('ftp://example.com')).toBeNull();
    expect(validatePublicUrl('https://user:pass@mapledental.ca')).toBeNull();
    expect(validatePublicUrl('http://localhost:4000')).toBeNull();
    expect(validatePublicUrl('http://api.localhost/')).toBeNull();
    expect(validatePublicUrl('not a url')).toBeNull();
    expect(validatePublicUrl('')).toBeNull();
  });

  it('accepts ordinary public clinic sites', () => {
    const url = validatePublicUrl('https://mapledental.ca');
    expect(url).not.toBeNull();
    expect(url?.hostname).toBe('mapledental.ca');
    expect(validatePublicUrl('http://www.mapledental.ca/contact')).not.toBeNull();
    // 172.32.x is OUTSIDE 172.16.0.0/12 and must not be refused.
    expect(validatePublicUrl('http://172.32.0.9/')).not.toBeNull();
  });
});

describe('extractClinicFacts', () => {
  const facts = extractClinicFacts(FIXTURE_HTML, 'https://mapledental.ca');

  it('extracts the business name from og:title, first segment only', () => {
    expect(facts.businessName).toBe('Maple Dental Studio');
  });

  it('extracts the phone number', () => {
    expect(facts.phone).toBeDefined();
    expect(facts.phone).toContain('604');
    expect(facts.phone).toContain('555-0182');
  });

  it('extracts the street address', () => {
    expect(facts.address).toBeDefined();
    expect(facts.address).toContain('2145 West 4th Avenue');
  });

  it('extracts hours lines (day + time), capped and deduped', () => {
    expect(facts.hours).toHaveLength(2);
    expect(facts.hours?.[0]).toContain('Monday');
    expect(facts.hours?.[1]).toContain('Saturday');
  });

  it('extracts services from the lexicon', () => {
    expect(facts.services).toEqual(
      expect.arrayContaining(['Cleanings', 'Exams', 'Fillings', 'Crowns', 'Root canals', 'Implants', 'Invisalign', 'Whitening']),
    );
  });

  it('never leaks script or style content into the facts', () => {
    // "dentures" and "bridges" appear ONLY inside <script>/<style> in the
    // fixture, so neither may be extracted as a service.
    expect(facts.services).not.toContain('Dentures');
    expect(facts.services).not.toContain('Bridges');
  });

  it('falls back to <title> when there is no og:title', () => {
    const html = '<html><head><title>Riverside Dental - Burnaby</title></head><body></body></html>';
    expect(extractClinicFacts(html, 'https://riverside.example').businessName).toBe('Riverside Dental');
  });
});
