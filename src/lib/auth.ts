import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/supabase-server';
import { logEvent } from '@/lib/log';
import type { UserRole } from '@/types';

export const authOptions: NextAuthOptions = {
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const { data: user, error } = await db
          .from('users')
          .select('*')
          .eq('email', credentials.email.toLowerCase())
          .eq('status', 'active')
          .single();

        if (error || !user) return null;

        const passwordValid = await bcrypt.compare(
          credentials.password,
          user.password_hash
        );

        if (!passwordValid) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role as UserRole,
          plan: (user.plan as string) ?? 'free',
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id;
        token.role = user.role as UserRole;
        token.plan = user.plan ?? 'free';
        token.email = user.email;
        token.name = user.name;
      }

      if (trigger === 'update') {
        const upd = (session ?? {}) as { impersonateUserId?: string; stopImpersonating?: boolean };

        // ── Start impersonation ── only a real admin (not already impersonating)
        // may assume another account. The original admin id/email is stashed so
        // we can restore it and show a banner.
        if (upd.impersonateUserId && token.role === 'admin' && !token.impersonatorId) {
          const { data: t } = await db
            .from('users')
            .select('id, email, name, role, plan')
            .eq('id', upd.impersonateUserId)
            .single();
          if (t) {
            token.impersonatorId = token.id as string;
            token.impersonatorEmail = token.email as string | undefined;
            token.id = t.id;
            token.role = t.role as UserRole;
            token.plan = (t.plan as string) ?? 'free';
            token.email = t.email;
            token.name = t.name;
            void logEvent('admin_impersonate', 'info', 'start', {
              adminId: token.impersonatorId, adminEmail: token.impersonatorEmail, targetId: t.id, targetEmail: t.email,
            });
          }
        }
        // ── Stop impersonation ── restore the real admin.
        else if (upd.stopImpersonating && token.impersonatorId) {
          const adminId = token.impersonatorId as string;
          const { data: a } = await db
            .from('users')
            .select('id, email, name, role, plan')
            .eq('id', adminId)
            .single();
          if (a) {
            void logEvent('admin_impersonate', 'info', 'stop', { adminId: a.id, wasViewing: token.email });
            token.id = a.id;
            token.role = a.role as UserRole;
            token.plan = (a.plan as string) ?? 'free';
            token.email = a.email;
            token.name = a.name;
            delete token.impersonatorId;
            delete token.impersonatorEmail;
          }
        }
        // ── Normal refresh ── re-read plan/role (Stripe upgrade, invitee claim),
        // but never while impersonating (that would clobber the target identity).
        else if (token.id && !token.impersonatorId) {
          const { data } = await db
            .from('users')
            .select('plan, role')
            .eq('id', token.id as string)
            .single();
          if (data?.plan) token.plan = data.plan;
          if (data?.role) token.role = data.role as UserRole;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as UserRole;
        session.user.plan = (token.plan as string) ?? 'free';
        if (token.email) session.user.email = token.email as string;
        if (token.name) session.user.name = token.name as string;
        if (token.impersonatorId) {
          session.user.impersonatorId = token.impersonatorId as string;
          session.user.impersonatorEmail = token.impersonatorEmail as string | undefined;
        }
      }
      return session;
    },
  },
};
