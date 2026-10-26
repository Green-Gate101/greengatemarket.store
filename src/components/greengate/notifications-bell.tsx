'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { Bell, BellRing, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationsResponse {
  notifications: NotificationRow[];
  unread: number;
}

/** Relative time, compact and locale-stable. */
function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Header notification bell. Polls /api/notifications every 60s while signed
 * in, shows an unread badge and a scrollable panel with skeleton loading.
 * Clicking an item marks it read and follows its in-app link; unread items
 * keep the panel honest with a dot indicator.
 */
export function NotificationsBell() {
  const { status } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const signedIn = status === 'authenticated';

  const { data, isLoading } = useQuery<NotificationsResponse>({
    queryKey: ['notifications'],
    queryFn: async () => {
      const res = await fetch('/api/notifications');
      if (!res.ok) throw new Error('Could not load notifications');
      return res.json();
    },
    enabled: signedIn,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
    staleTime: 0,
  });

  // Reset the panel query state on sign-out.
  useEffect(() => {
    if (status === 'unauthenticated') queryClient.removeQueries({ queryKey: ['notifications'] });
  }, [status, queryClient]);

  if (!signedIn) return null;

  const unread = data?.unread ?? 0;

  const markRead = async (id: string) => {
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  const markAllRead = async () => {
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    }).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          {unread > 0 ? <BellRing className="h-[18px] w-[18px]" /> : <Bell className="h-[18px] w-[18px]" />}
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-sm bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(340px,calc(100vw-1rem))] p-0 sm:w-[380px]">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-semibold">Notifications</p>
          {unread > 0 && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void markAllRead()}>
              <Check className="h-3.5 w-3.5" /> Mark all read
            </Button>
          )}
        </div>

        <div className="max-h-96 overflow-y-auto">
          {isLoading ? (
            <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading notifications">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              ))}
            </div>
          ) : !data || data.notifications.length === 0 ? (
            <p className="px-4 py-10 text-center text-xs text-muted-foreground">
              No notifications yet. Order updates appear here.
            </p>
          ) : (
            <ul className="divide-y">
              {data.notifications.map((n) => {
                const isUnread = !n.readAt;
                const content = (
                  <div className="flex gap-2.5 px-4 py-3">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${isUnread ? 'bg-primary' : 'bg-transparent'}`} aria-hidden />
                    <div className="min-w-0">
                      <p className={`truncate text-sm ${isUnread ? 'font-semibold' : 'font-medium text-muted-foreground'}`}>
                        {n.title}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{n.body}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground/80">{timeAgo(n.createdAt)}</p>
                    </div>
                  </div>
                );
                return (
                  <li key={n.id}>
                    {n.link && /^https:\/\//.test(n.link) ? (
                      // Server-set links to Green Gate's other app (the admin console) open in a new tab.
                      <a
                        href={n.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block hover:bg-accent/60"
                        onClick={() => {
                          if (isUnread) void markRead(n.id);
                          setOpen(false);
                        }}
                      >
                        {content}
                      </a>
                    ) : n.link ? (
                      <Link
                        href={`#${n.link}`}
                        className="block hover:bg-accent/60"
                        onClick={() => {
                          if (isUnread) void markRead(n.id);
                          setOpen(false);
                        }}
                      >
                        {content}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className="block w-full text-left hover:bg-accent/60"
                        onClick={() => {
                          if (isUnread) void markRead(n.id);
                        }}
                      >
                        {content}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
