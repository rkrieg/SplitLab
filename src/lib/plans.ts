export interface Plan {
  id: 'free' | 'pro' | 'agency' | 'scale';
  label: string;
  price: string;
  sub: string;
  features: string[];
  cta: string;
  highlight: boolean;
  signupHref: string;
}

export const PLANS: Plan[] = [
  {
    id: 'free',
    label: 'Starter',
    price: 'Free',
    sub: 'Perfect for trying SplitLab out',
    features: ['1 active test', '2 variants per test', '1,000 visitors/mo', 'Basic analytics', 'Zero-config tracker.js'],
    cta: 'Get Started Free',
    highlight: false,
    signupHref: '/signup?plan=free',
  },
  {
    id: 'pro',
    label: 'Pro',
    price: '$49',
    sub: 'For marketers running real tests',
    features: ['10 active tests', 'Unlimited variants', '25,000 visitors/mo', '1 custom domain', 'CSV export', 'Conversion goals', 'Priority email support'],
    cta: 'Start Pro',
    highlight: false,
    signupHref: '/signup?plan=pro',
  },
  {
    id: 'agency',
    label: 'Agency',
    price: '$149',
    sub: 'For agencies managing multiple clients',
    features: ['50 active tests', 'Up to 10 clients', '100,000 visitors/mo', 'Up to 10 custom domains', 'Team seats', 'Custom scripts per variant', 'UTM personalization'],
    cta: 'Start Agency',
    highlight: true,
    signupHref: '/signup?plan=agency',
  },
  {
    id: 'scale',
    label: 'Scale',
    price: '$349',
    sub: 'For high-volume teams and networks',
    features: ['Unlimited tests', 'Unlimited clients', 'Unlimited visitors/mo', 'Unlimited custom domains', 'White-label branding', 'Webhook integrations', 'Priority support'],
    cta: 'Start Scale',
    highlight: false,
    signupHref: '/signup?plan=scale',
  },
];
