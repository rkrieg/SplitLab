'use client';

import Link from 'next/link';
import { useState } from 'react';

export default function ContactPage() {
  const [form, setForm] = useState({ name: '', email: '', message: '' });
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error();
      setStatus('sent');
      setForm({ name: '', email: '', message: '' });
    } catch {
      setStatus('error');
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '12px 16px',
    background: '#111827',
    border: '1px solid #1E293B',
    borderRadius: 8,
    color: '#F1F5F9',
    fontSize: 15,
    fontFamily: 'inherit',
    outline: 'none',
    transition: 'border-color 0.2s',
  };

  return (
    <div style={{ fontFamily: "'Outfit', sans-serif", background: '#0B1120', color: '#F1F5F9', minHeight: '100vh' }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '80px 24px' }}>
        <Link href="/" style={{ color: '#3D8BDA', fontSize: 14, textDecoration: 'none', display: 'inline-block', marginBottom: 32 }}>
          &larr; Back to home
        </Link>
        <h1 style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.025em', marginBottom: 8 }}>Contact Us</h1>
        <p style={{ color: '#94A3B8', fontSize: 16, marginBottom: 40, lineHeight: 1.6 }}>
          Have a question, feedback, or need help? Send us a message and we&apos;ll get back to you.
        </p>

        {status === 'sent' ? (
          <div style={{
            background: 'rgba(34,197,94,0.1)',
            border: '1px solid rgba(34,197,94,0.2)',
            borderRadius: 12,
            padding: '24px',
            textAlign: 'center',
          }}>
            <p style={{ color: '#22C55E', fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Message sent!</p>
            <p style={{ color: '#94A3B8', fontSize: 14 }}>We&apos;ll get back to you as soon as possible.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 6, color: '#CBD5E1' }}>Name</label>
              <input
                type="text"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Your name"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 6, color: '#CBD5E1' }}>Email</label>
              <input
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="you@example.com"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 6, color: '#CBD5E1' }}>Message</label>
              <textarea
                required
                rows={5}
                value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
                placeholder="How can we help?"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </div>
            <button
              type="submit"
              disabled={status === 'sending'}
              style={{
                padding: '14px 28px',
                background: status === 'sending' ? '#2B6FB5' : '#3D8BDA',
                color: 'white',
                border: 'none',
                borderRadius: 10,
                fontSize: 16,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: status === 'sending' ? 'not-allowed' : 'pointer',
                transition: 'background 0.2s',
              }}
            >
              {status === 'sending' ? 'Sending...' : 'Send Message'}
            </button>
            {status === 'error' && (
              <p style={{ color: '#EF4444', fontSize: 14 }}>Something went wrong. Please try again.</p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
