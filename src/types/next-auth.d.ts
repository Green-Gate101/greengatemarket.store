import { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: string;
      /** Password fingerprint at sign-in — see passwordFingerprint(). */
      pwf?: string;
    } & DefaultSession['user'];
  }
}
