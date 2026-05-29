import Link from 'next/link';

export const metadata = { title: 'Terms of Service | SplitLab' };

export default function TermsPage() {
  return (
    <div style={{ fontFamily: "'Outfit', sans-serif", background: '#0B1120', color: '#F1F5F9', minHeight: '100vh' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '80px 24px' }}>
        <Link href="/" style={{ color: '#3D8BDA', fontSize: 14, textDecoration: 'none', display: 'inline-block', marginBottom: 32 }}>
          &larr; Back to home
        </Link>
        <h1 style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.025em', marginBottom: 8 }}>Terms of Service</h1>
        <p style={{ color: '#64748B', fontSize: 14, marginBottom: 40 }}>Last updated: May 26, 2026</p>

        <div style={{ color: '#94A3B8', fontSize: 15, lineHeight: 1.75, display: 'flex', flexDirection: 'column', gap: 28 }}>
          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>1. Acceptance of Terms</h2>
            <p>By accessing or using SplitLab (&quot;the Service&quot;), you agree to be bound by these Terms of Service. If you do not agree, do not use the Service.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>2. Description of Service</h2>
            <p>SplitLab is an A/B testing and landing page management platform. We provide tools to create, serve, and analyze landing page variants across custom domains.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>3. Accounts</h2>
            <p>You are responsible for maintaining the security of your account credentials. You must provide accurate information when creating an account. You are responsible for all activity that occurs under your account.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>4. Acceptable Use</h2>
            <p>You agree not to use the Service to: (a) violate any applicable laws or regulations; (b) host or distribute malicious content; (c) interfere with or disrupt the Service; (d) attempt to gain unauthorized access to any part of the Service; or (e) use the Service in any way that could harm other users.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>5. Content</h2>
            <p>You retain ownership of all content you upload to SplitLab, including landing page HTML, images, and scripts. You grant us a limited license to host and serve that content as necessary to operate the Service. You are solely responsible for ensuring your content complies with applicable laws.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>6. Payment &amp; Billing</h2>
            <p>Paid plans are billed monthly. Plan changes take effect immediately. Downgrades do not receive prorated refunds for the remaining billing period. We reserve the right to change pricing with 30 days notice.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>7. Termination</h2>
            <p>We may suspend or terminate your access to the Service at any time for violation of these Terms. You may cancel your account at any time. Upon termination, your data may be deleted after a reasonable retention period.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>8. Limitation of Liability</h2>
            <p>The Service is provided &quot;as is&quot; without warranties of any kind. To the maximum extent permitted by law, SplitLab shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of the Service.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>9. Changes to Terms</h2>
            <p>We reserve the right to update these Terms at any time. Continued use of the Service after changes constitutes acceptance of the updated Terms.</p>
          </section>

          <section>
            <h2 style={{ color: '#F1F5F9', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>10. Contact</h2>
            <p>Questions about these Terms? <Link href="/contact" style={{ color: '#3D8BDA' }}>Contact us</Link>.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
