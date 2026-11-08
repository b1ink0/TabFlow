import { describe, expect, it, vi } from 'vitest';
import {
  authorizeGoogleCalendar,
  CALENDAR_SCOPE,
  fetchTodayCalendarEvents,
  revokeGoogleCalendarToken,
} from '../src/providers/google-calendar';

describe('Google Calendar read-only adapter', () => {
  it('uses PKCE and exchanges a code without a client secret', async () => {
    let authorization = new URL('https://accounts.google.com');
    const identity = {
      getRedirectURL: (path?: string) => `https://extension.chromiumapp.org/${path || ''}`,
      launchWebAuthFlow: vi.fn(async ({ url }: { url: string }) => {
        authorization = new URL(url);
        const callback = new URL('https://extension.chromiumapp.org/calendar');
        callback.searchParams.set('state', authorization.searchParams.get('state')!);
        callback.searchParams.set('code', 'temporary-code');
        return callback.toString();
      }),
    };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('client_id')).toBe('public.apps.googleusercontent.com');
      expect(body.has('client_secret')).toBe(false);
      expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      expect(body.get('grant_type')).toBe('authorization_code');
      return new Response(JSON.stringify({ access_token: 'short-lived-token', expires_in: 3600 }), {
        status: 200,
      });
    });

    const result = await authorizeGoogleCalendar(
      'public.apps.googleusercontent.com',
      identity,
      fetcher as typeof fetch,
    );
    expect(authorization.searchParams.get('scope')).toBe(CALENDAR_SCOPE);
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toBeTruthy();
    expect(result.accessToken).toBe('short-lived-token');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects a mismatched OAuth state before exchanging a code', async () => {
    const identity = {
      getRedirectURL: () => 'https://extension.chromiumapp.org/calendar',
      launchWebAuthFlow: async () =>
        'https://extension.chromiumapp.org/calendar?state=wrong&code=stolen',
    };
    const fetcher = vi.fn();
    await expect(
      authorizeGoogleCalendar(
        'public.apps.googleusercontent.com',
        identity,
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow(/could not be verified/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requests only today’s events with a bearer token and excludes cancelled events', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(String(input));
      expect(requestUrl.pathname).toBe('/calendar/v3/calendars/primary/events');
      expect(requestUrl.searchParams.get('singleEvents')).toBe('true');
      expect(requestUrl.searchParams.get('orderBy')).toBe('startTime');
      expect(requestUrl.searchParams.get('maxResults')).toBe('2500');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer token' });
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'event-1',
              summary: 'Design review',
              status: 'confirmed',
              htmlLink: 'https://calendar.google.com/event?eid=one',
              start: { dateTime: '2026-10-10T10:00:00+05:30' },
              end: { dateTime: '2026-10-10T10:30:00+05:30' },
            },
            {
              id: 'cancelled',
              summary: 'Cancelled',
              status: 'cancelled',
              start: { date: '2026-10-10' },
              end: { date: '2026-10-11' },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const events = await fetchTodayCalendarEvents(
      'token',
      new Date('2026-10-10T08:00:00+05:30'),
      fetcher as typeof fetch,
    );
    expect(events).toEqual([
      {
        id: 'event-1',
        title: 'Design review',
        start: '2026-10-10T10:00:00+05:30',
        end: '2026-10-10T10:30:00+05:30',
        allDay: false,
        htmlLink: 'https://calendar.google.com/event?eid=one',
      },
    ]);
  });

  it('revokes the current access token on disconnect', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(new URLSearchParams(String(init?.body)).get('token')).toBe('token');
      return new Response(null, { status: 200 });
    });
    await revokeGoogleCalendarToken('token', fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
