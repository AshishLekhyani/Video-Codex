import { NextRequest } from 'next/server';
import { getProgress } from '../progressStore';

// Server-Sent Events stream of a conversion job's progress, polled from the
// in-memory progressStore that the POST /api/convert handler writes to.
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id) {
    return new Response('Missing id', { status: 400 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let interval: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        if (closed) return;
        const state = getProgress(id) ?? { stage: 'waiting', percent: 0, done: false };
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(state)}\n\n`));
        } catch {
          closed = true;
          clearInterval(interval);
          return;
        }
        if (state.done) {
          closed = true;
          clearInterval(interval);
          controller.close();
        }
      };

      send();
      interval = setInterval(send, 300);

      request.signal.addEventListener('abort', () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      closed = true;
      clearInterval(interval);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

export const dynamic = 'force-dynamic';
