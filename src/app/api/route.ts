import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: 'ok', service: 'green-gate', database: 'connected' });
  } catch {
    return NextResponse.json({ status: 'ok', service: 'green-gate', database: 'unavailable' });
  }
}
