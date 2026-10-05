'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { navigate } from './header';
import { useGuestCart } from './guest-cart';
import { Logo } from './brand';

type Mode = 'signin' | 'register' | 'forgot' | 'reset';

/** Google icon (official multi-colour G, inline to avoid an extra dependency). */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.2-2.1 3.7-5.1 3.7-8.6z" />
      <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.7-2.9c-1 .7-2.4 1.2-4.2 1.2-3.2 0-5.9-2.1-6.8-5.1L1.3 17.2C3.3 21.2 7.3 24 12 24z" />
      <path fill="#FBBC05" d="M5.2 14.3c-.2-.7-.4-1.5-.4-2.3s.2-1.6.4-2.3L1.3 6.8C.5 8.4 0 10.1 0 12s.5 3.6 1.3 5.2l3.9-2.9z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.2 15.2 0 12 0 7.3 0 3.3 2.8 1.3 6.8l3.9 2.9C6.1 6.7 8.8 4.8 12 4.8z" />
    </svg>
  );
}

export function AuthView({ initialMode }: { initialMode: Mode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
      <div className="rounded-lg border bg-card p-6 sm:p-8">
        <div className="mb-6 flex justify-center"><Logo /></div>
        <AuthPanel initialMode={initialMode} />
      </div>
    </main>
  );
}

function AuthPanel({ initialMode }: { initialMode: Mode }) {
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: me } = useQuery<{ googleEnabled: boolean }>({
    queryKey: ['me-flags'],
    queryFn: async () => (await fetch('/api/auth/me')).json(),
  });

  // A reset link (?reset=<token>) lands back on this view with the token.
  useEffect(() => {
    const token = searchParams.get('reset');
    if (token) {
      setResetToken(token);
      setMode('reset');
    }
  }, [searchParams]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === 'signin') {
        const res = await signIn('credentials', { email, password, redirect: false });
        if (res?.error) {
          toast({ title: 'Sign in failed', description: 'Check your email and password.', variant: 'destructive' });
        } else {
          await mergeGuestCart();
          toast({ title: 'Welcome back' });
          navigate({ name: 'store' });
        }
      } else if (mode === 'register') {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Registration failed');
        toast({ title: 'Account created', description: 'Check your email to verify your address, then sign in.' });
        setMode('signin');
      } else if (mode === 'forgot') {
        const res = await fetch('/api/auth/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Could not send the reset email');
        toast({ title: 'Check your email', description: data.message });
      } else {
        const res = await fetch('/api/auth/reset', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: resetToken, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Could not reset the password');
        toast({ title: 'Password updated', description: 'Sign in with your new password.' });
        setMode('signin');
      }
    } catch (err) {
      toast({ title: 'Something went wrong', description: err instanceof Error ? err.message : 'Please try again.', variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  /** Guest cart lines join the user's server cart on first sign-in. */
  const mergeGuestCart = async () => {
    const guest = useGuestCart.getState().lines;
    for (const line of guest) {
      await fetch('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: line.productId, variantId: line.variantId, quantity: line.quantity }),
      }).catch(() => undefined);
    }
    if (guest.length > 0) {
      useGuestCart.getState().clear();
      queryClient.invalidateQueries({ queryKey: ['cart'] });
    }
  };

  const googleSignIn = async () => {
    const googleReady = me?.googleEnabled;
    if (!googleReady) {
      toast({
        title: 'Google sign-in is not configured yet',
        description: 'The site owner must add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables (Google Cloud OAuth client) to enable it.',
        variant: 'destructive',
      });
      return;
    }
    await signIn('google', { callbackUrl: '/' });
  };

  return (
    <>
      <h1 className="text-center text-lg font-bold">
        {mode === 'signin' && 'Sign in to Green Gate'}
        {mode === 'register' && 'Create your account'}
        {mode === 'forgot' && 'Reset your password'}
        {mode === 'reset' && 'Choose a new password'}
      </h1>
      <p className="mt-1 text-center text-xs text-muted-foreground">
        {mode === 'register' ? 'One account for buying and selling.' : mode === 'signin' ? 'Shop, save items and track orders.' : ' '}
      </p>

      <form className="mt-6 space-y-4" onSubmit={submit}>
        {mode === 'register' && (
          <div>
            <Label htmlFor="auth-name">Full name</Label>
            <Input id="auth-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required minLength={2} />
          </div>
        )}
        {mode !== 'reset' && (
          <div>
            <Label htmlFor="auth-email">Email</Label>
            <Input id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </div>
        )}
        {mode !== 'forgot' && (
          <div>
            <div className="flex items-center justify-between">
              <Label htmlFor="auth-password">{mode === 'reset' ? 'New password' : 'Password'}</Label>
              {mode === 'signin' && (
                <button type="button" className="text-xs text-primary hover:underline" onClick={() => setMode('forgot')}>
                  Forgot password?
                </button>
              )}
            </div>
            <Input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'signin' ? undefined : 8}
            />
            {mode !== 'signin' && <p className="mt-1 text-[11px] text-muted-foreground">At least 8 characters with a letter and a number.</p>}
          </div>
        )}

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Please wait…'
            : mode === 'signin' ? 'Sign in'
            : mode === 'register' ? 'Create account'
            : mode === 'forgot' ? 'Send reset link'
            : 'Update password'}
        </Button>
      </form>

      {(mode === 'signin' || mode === 'register') && (
        <>
          <div className="my-5 flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">or</span>
            <Separator className="flex-1" />
          </div>
          <Button type="button" variant="outline" className="w-full" onClick={() => void googleSignIn()}>
            <GoogleIcon /> Continue with Google
          </Button>
        </>
      )}

      <p className="mt-6 text-center text-xs text-muted-foreground">
        {mode === 'signin' ? (
          <>New to Green Gate?{' '}
            <button className="font-medium text-primary hover:underline" onClick={() => setMode('register')}>Create an account</button>
          </>
        ) : (
          <button className="font-medium text-primary hover:underline" onClick={() => setMode('signin')}>Back to sign in</button>
        )}
      </p>
    </>
  );
}
