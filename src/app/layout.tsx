import type { Metadata } from 'next';
import './globals.css';
import Providers from './providers';

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';
const DESCRIPTION =
  'SplitLab is an agency-first A/B testing and AI landing-page platform. Build landing pages with AI, run A/B and split tests on your own custom domains, and optimize conversion with real-time analytics.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'SplitLab — A/B Testing & AI Landing Page Builder',
    template: '%s | SplitLab',
  },
  description: DESCRIPTION,
  applicationName: 'SplitLab',
  keywords: [
    'A/B testing',
    'split testing',
    'landing page optimization',
    'landing page conversion optimization',
    'conversion rate optimization',
    'landing page builder',
    'AI landing page builder',
    'A/B testing software',
    'A/B testing for agencies',
    'landing page A/B testing',
  ],
  authors: [{ name: 'SplitLab' }],
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'SplitLab',
    title: 'SplitLab — A/B Testing & AI Landing Page Builder',
    description: DESCRIPTION,
    images: [{ url: '/android-chrome-512x512.png', width: 512, height: 512, alt: 'SplitLab' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SplitLab — A/B Testing & AI Landing Page Builder',
    description: DESCRIPTION,
    images: ['/android-chrome-512x512.png'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1, 'max-video-preview': -1 },
  },
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Microsoft Clarity — analytics for the SplitLab site itself (not client variant pages). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","y8nhv3omn8");`,
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body className="min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
