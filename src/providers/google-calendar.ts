import { z } from 'zod';
import type { CalendarEvent } from '../shared/types';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().optional(),
});
const eventResponseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().optional(),
        status: z.string().optional(),
        htmlLink: z
          .string()
          .url()
          .refine((link) => new URL(link).protocol === 'https:')
          .optional(),
        start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
        end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
      }),
    )
    .default([]),
});

interface IdentityApi {
  getRedirectURL(path?: string): string;
  launchWebAuthFlow(options: { url: string; interactive: boolean }): Promise<string | undefined>;
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function validateClientId(value: string): string {
  const clientId = value.trim();
  if (!clientId || clientId.length > 300 || !clientId.endsWith('.apps.googleusercontent.com'))
    throw new Error('Enter a valid Google OAuth client ID in Settings.');
  return clientId;
}

export async function authorizeGoogleCalendar(
  rawClientId: string,
  identity: IdentityApi = chrome.identity,
  fetcher: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresAt: number }> {
  const clientId = validateClientId(rawClientId);
  const redirectUri = identity.getRedirectURL('calendar');
  const state = randomBase64Url(32);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: CALENDAR_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'online',
    include_granted_scopes: 'false',
  }).toString();

  const callback = await identity.launchWebAuthFlow({
    url: authorizeUrl.toString(),
    interactive: true,
  });
  if (!callback) throw new Error('Google sign-in was cancelled.');
  let callbackUrl: URL;
  try {
    callbackUrl = new URL(callback);
  } catch {
    throw new Error('Google returned an invalid sign-in response.');
  }
  const expected = new URL(redirectUri);
  if (callbackUrl.origin !== expected.origin || callbackUrl.pathname !== expected.pathname)
    throw new Error('Google returned to an unexpected sign-in address.');
  if (callbackUrl.searchParams.get('state') !== state)
    throw new Error('Google sign-in could not be verified. Please try again.');
  const oauthError = callbackUrl.searchParams.get('error');
  if (oauthError)
    throw new Error(
      oauthError === 'access_denied' ? 'Calendar access was declined.' : 'Google sign-in failed.',
    );
  const code = callbackUrl.searchParams.get('code');
  if (!code) throw new Error('Google did not return an authorization code.');

  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!response.ok)
    throw new Error(
      'Google could not complete sign-in. Check the extension OAuth setup and try again.',
    );
  const token = tokenResponseSchema.parse(await response.json());
  return { accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
}

function localDayRange(now: Date): { timeMin: string; timeMax: string } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

export async function fetchTodayCalendarEvents(
  accessToken: string,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<CalendarEvent[]> {
  if (!accessToken) throw new Error('Connect Google Calendar to load today’s events.');
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.search = new URLSearchParams({
    ...localDayRange(now),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
  }).toString();
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (response.status === 401)
    throw new Error('Calendar access expired. Reconnect Google Calendar.');
  if (!response.ok) throw new Error('Could not load today’s Google Calendar events.');
  const result = eventResponseSchema.parse(await response.json());
  return result.items
    .filter((event) => event.status !== 'cancelled')
    .flatMap((event) => {
      const start = event.start.dateTime || event.start.date;
      const end = event.end.dateTime || event.end.date;
      if (!start || !end) return [];
      return [
        {
          id: event.id,
          title: (event.summary || '(No title)').slice(0, 300),
          start,
          end,
          allDay: Boolean(event.start.date && !event.start.dateTime),
          htmlLink: event.htmlLink || null,
        },
      ];
    });
}

export async function revokeGoogleCalendarToken(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!accessToken) return;
  const response = await fetcher('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: accessToken }),
  });
  if (!response.ok)
    throw new Error(
      'Google could not revoke this session. You can remove TabFlow access in your Google Account settings.',
    );
}
