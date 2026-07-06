import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import AffiliatesClient from './AffiliatesClient';

export const dynamic = 'force-dynamic';

export interface AdminAffiliate {
  id: string;
  name: string;
  email: string;
  referral_code: string;
  payout_email: string | null;
  payout_method: string;
  status: string;
  created_at: string;
  referrals_total: number;
  referrals_paying: number;
  owed_cents: number;
  paid_cents: number;
  lifetime_cents: number;
}

async function getAffiliates(): Promise<AdminAffiliate[]> {
  const { data: affiliates } = await db
    .from('affiliates')
    .select('id, name, email, referral_code, payout_email, payout_method, status, created_at')
    .order('created_at', { ascending: false });

  if (!affiliates?.length) return [];

  const ids = affiliates.map(a => a.id);

  const { data: referrals } = await db
    .from('referrals')
    .select('affiliate_id, status')
    .in('affiliate_id', ids);

  const { data: commissions } = await db
    .from('commissions')
    .select('affiliate_id, amount_cents, status')
    .in('affiliate_id', ids);

  return affiliates.map(a => {
    const refs = (referrals ?? []).filter(r => r.affiliate_id === a.id);
    const comms = (commissions ?? []).filter(c => c.affiliate_id === a.id);
    const sum = (s: string) => comms.filter(c => c.status === s).reduce((t, c) => t + (c.amount_cents ?? 0), 0);
    const owed = sum('pending');
    const paid = sum('paid');
    return {
      ...a,
      referrals_total:  refs.length,
      referrals_paying: refs.filter(r => r.status === 'converted').length,
      owed_cents:       owed,
      paid_cents:       paid,
      lifetime_cents:   owed + paid,
    };
  });
}

export default async function AffiliatesPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');
  if (session.user.role !== 'admin') redirect('/dashboard');

  const affiliates = await getAffiliates();

  return (
    <>
      <Header title="Affiliates" subtitle="Referral partners, commissions owed, and payouts" />
      <div className="p-6">
        <AffiliatesClient affiliates={affiliates} />
      </div>
    </>
  );
}
