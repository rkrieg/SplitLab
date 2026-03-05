import type { Metadata } from 'next';
import './globals.css';
import Providers from './providers';

export const metadata: Metadata = {
  title: 'SplitLab — A/B Testing Platform',
  description: 'Agency-grade landing page A/B testing and management platform.',
  icons: {
    icon: '/favicon.ico',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-slate-900">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
