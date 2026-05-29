import Link from 'next/link';

export const metadata = { title: 'Privacy Policy | SplitLab' };

export default function PrivacyPage() {
  return (
    <div style={{ fontFamily: "'Outfit', sans-serif", background: '#0B1120', color: '#F1F5F9', minHeight: '100vh' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '80px 24px' }}>
        <Link href="/" style={{ color: '#3D8BDA', fontSize: 14, textDecoration: 'none', display: 'inline-block', marginBottom: 32 }}>
          &larr; Back to home
        </Link>
        <h1 style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.025em', marginBottom: 8 }}>Privacy Policy</h1>
        <p style={{ color: '#64748B', fontSize: 14, marginBottom: 40 }}>Last updated: May 26, 2026</p>

        <div style={{ color: '#94A3B8', fontSize: 15, lineHeight: 1.75, display: 'flex', flexDirection: 'column', gap: 28 }}>
          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>1. Information We Collect</h2>
            <p>When you create an account we collect your name, email address, and password (stored as a bcrypt hash). When visitors interact with pages served through SplitLab, we collect anonymous visitor identifiers (stored in cookies), page URLs, and interaction events such as page views and button clicks. We do not collect personally identifiable information from end-user visitors unless explicitly configured by the workspace owner.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>2. How We Use Your Information</h2>
            <p>We use account information to provide and maintain your access to the platform. Anonymous visitor data is used to run A/B tests, calculate conversion rates, and determine statistical significance. We may use your email to send transactional messages such as team invitations and account notifications.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>3. Cookies</h2>
            <p>SplitLab sets a <code style={{ background: '#1E293B', padding: '2px 6px', borderRadius: 4, fontSize: 13 }}>sl_visitor</code> cookie (90-day expiry) to assign a consistent anonymous visitor ID, and per-test cookies to ensure visitors see the same variant across sessions. These cookies contain no personal information.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>4. Data Sharing</h2>
            <p>We do not sell your data. We may share data with third-party service providers that help us operate the platform (e.g., hosting, email delivery) under strict confidentiality agreements. We will disclose information if required by law.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>5. Data Retention</h2>
            <p>Account data is retained for as long as your account is active. Event data (page views, conversions) is retained for the duration of your subscription. You may request deletion of your data by contacting us.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>6. Security</h2>
            <p>We use industry-standard measures to protect your data, including encrypted connections (TLS), hashed passwords, and role-based access controls within the platform.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>7. Contact</h2>
            <p>If you have questions about this Privacy Policy, please <Link href="/contact" style={{ color: '#3D8BDA' }}>contact us</Link>.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
