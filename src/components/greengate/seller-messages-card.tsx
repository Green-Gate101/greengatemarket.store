'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { readJson } from '@/lib/utils';

interface Message { id: string; fromAdmin: boolean; body: string; createdAt: string }
const MAX = 2000;
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' });

/**
 * Text conversation between the seller and the Green Gate team (plain text,
 * one thread per store). Available even while a subscription is unpaid.
 */
export function SellerMessagesCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const thread = useQuery<{ messages: Message[]; unread: number }>({
    queryKey: ['seller-messages'],
    queryFn: async () => {
      const res = await fetch('/api/seller/messages?read=1');
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error ?? 'Could not load your messages');
      return data;
    },
    refetchInterval: 30_000,
  });
  const count = thread.data?.messages.length ?? 0;
  // Follow the newest message (the list is capped at 200, so its length can stay the same).
  const newestId = count ? thread.data!.messages[count - 1].id : '';
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [newestId]);

  const send = useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch('/api/seller/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error ?? 'Could not send your message.');
      return data;
    },
    onSuccess: () => {
      setText('');
      void queryClient.invalidateQueries({ queryKey: ['seller-messages'] });
    },
    onError: (e: Error) => toast({ title: 'Messages', description: e.message, variant: 'destructive' }),
  });

  return (
    <section className="mt-6 rounded-lg border bg-card p-4 sm:p-6" aria-labelledby="messages-heading" data-testid="seller-messages">
      <h2 id="messages-heading" className="flex items-center gap-2 text-lg font-bold">
        <MessageSquare className="h-5 w-5 text-primary" aria-hidden /> Messages with Green Gate
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">Text only. Write to the Green Gate team about billing, your store, orders or anything else.</p>

      <div ref={listRef} className="mt-3 max-h-80 space-y-2 overflow-y-auto rounded-md border bg-background p-3" aria-live="polite">
        {thread.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : thread.isError ? (
          <p className="flex flex-wrap items-center gap-2 text-xs" role="alert">
            We could not load your messages.
            <Button size="sm" variant="outline" onClick={() => void thread.refetch()}>Try again</Button>
          </p>
        ) : count === 0 ? (
          <p className="text-xs text-muted-foreground">No messages yet.</p>
        ) : (
          thread.data!.messages.map((m) => (
            <div key={m.id} className={`flex ${m.fromAdmin ? 'justify-start' : 'justify-end'}`}>
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.fromAdmin ? 'bg-secondary text-secondary-foreground' : 'bg-primary text-primary-foreground'}`} data-testid={m.fromAdmin ? 'msg-admin' : 'msg-seller'}>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className="mt-1 text-[10px] opacity-75">{m.fromAdmin ? 'Green Gate' : 'You'} · {when(m.createdAt)}</p>
              </div>
            </div>
          ))
        )}
      </div>

      <form
        className="mt-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && !send.isPending) send.mutate(text);
        }}
      >
        <label htmlFor="seller-message" className="sr-only">Message to Green Gate</label>
        <Textarea
          id="seller-message"
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX))}
          onKeyDown={(e) => {
            // Ctrl/⌘ + Enter sends (Enter alone starts a new line).
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim() && !send.isPending) {
              e.preventDefault();
              send.mutate(text);
            }
          }}
          placeholder="Write a message… (Ctrl+Enter sends)"
          rows={3}
          maxLength={MAX}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">{text.length}/{MAX}</span>
          <Button type="submit" size="sm" disabled={!text.trim() || send.isPending} data-testid="send-message">
            <Send className="h-4 w-4" aria-hidden /> {send.isPending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </form>
    </section>
  );
}
