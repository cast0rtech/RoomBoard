import { describe, expect, it, vi } from 'vitest';
import type { AuthTokenProvider } from '../auth/index.js';
import type { HubConfig } from '../config.js';
import {
  createGraphClient,
  EVENT_SELECT_FIELDS,
  GraphApiError,
  mapGraphEvent,
  type GraphClientLogger,
} from './index.js';

function createConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    AUTH_MODE: 'delegated',
    TENANT_ID: 'tenant-123',
    CLIENT_ID: 'client-123',
    CLIENT_SECRET: 'secret-123',
    ROOM_MAILBOXES: 'sala.norte@empresa.com, sala.sur@empresa.com',
    TIMEZONE: 'Europe/Madrid',
    PORT: 8080,
    DEVICE_KEYS: 'key-1',
    POLL_SECONDS: 45,
    IGNORE_ALL_DAY: true,
    IGNORE_ALL_DAY_EVENTS: true,
    ...overrides,
  };
}

function createSilentLogger(): GraphClientLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createJsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

describe('Cliente Microsoft Graph v1.0 (hub/src/graph)', () => {
  it('listCalendars() en modo delegated consulta GET /me/calendars y sigue @odata.nextLink', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          value: [
            {
              id: 'cal-1',
              name: 'Calendario Principal',
              owner: { name: 'Ana', address: 'ana@empresa.com' },
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars?$skip=1',
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          value: [
            {
              id: 'cal-2',
              name: 'Sala Juntas',
              owner: { name: 'Sala Juntas', address: 'juntas@empresa.com' },
            },
          ],
        }),
      );

    const tokenProvider: AuthTokenProvider = {
      getAccessToken: vi.fn().mockResolvedValue('token-delegated'),
    };

    const client = createGraphClient({
      config: createConfig({ AUTH_MODE: 'delegated' }),
      tokenProvider,
      fetchFn: fetchMock,
      logger: createSilentLogger(),
    });

    const calendars = await client.listCalendars();

    expect(calendars).toEqual([
      {
        id: 'cal-1',
        name: 'Calendario Principal',
        ownerAddress: 'ana@empresa.com',
        mailbox: undefined,
      },
      {
        id: 'cal-2',
        name: 'Sala Juntas',
        ownerAddress: 'juntas@empresa.com',
        mailbox: undefined,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://graph.microsoft.com/v1.0/me/calendars?%24select=id%2Cname%2Cowner',
    );
  });

  it('listCalendars() en modo app consulta los buzones configurados en ROOM_MAILBOXES', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          id: 'graph-cal-norte',
          name: 'Calendar',
          owner: { name: 'Sala Norte', address: 'sala.norte@empresa.com' },
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          id: 'graph-cal-sur',
          name: 'Calendar',
          owner: { name: 'Sala Sur', address: 'sala.sur@empresa.com' },
        }),
      );

    const tokenProvider: AuthTokenProvider = {
      getAccessToken: vi.fn().mockResolvedValue('token-app'),
    };

    const client = createGraphClient({
      config: createConfig({ AUTH_MODE: 'app' }),
      tokenProvider,
      fetchFn: fetchMock,
      logger: createSilentLogger(),
    });

    const calendars = await client.listCalendars();

    expect(calendars).toEqual([
      {
        id: 'sala.norte@empresa.com',
        name: 'Sala Norte',
        ownerAddress: 'sala.norte@empresa.com',
        mailbox: 'sala.norte@empresa.com',
      },
      {
        id: 'sala.sur@empresa.com',
        name: 'Sala Sur',
        ownerAddress: 'sala.sur@empresa.com',
        mailbox: 'sala.sur@empresa.com',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      'https://graph.microsoft.com/v1.0/users/sala.norte%40empresa.com/calendar',
    );
  });

  it('listEvents() usa calendarView con $select mínimo, cabecera Prefer: outlook.timezone y paginación @odata.nextLink', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          value: [
            {
              id: 'evt-1',
              subject: 'Daily Sync',
              start: { dateTime: '2026-10-30T09:00:00', timeZone: 'Europe/Madrid' },
              end: { dateTime: '2026-10-30T09:30:00', timeZone: 'Europe/Madrid' },
              organizer: {
                emailAddress: { name: 'Carlos Gómez', address: 'carlos@empresa.com' },
              },
              isAllDay: false,
              isCancelled: false,
              showAs: 'busy',
              location: { displayName: 'Sala Norte' },
            },
          ],
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView?$skip=1',
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          value: [
            {
              id: 'evt-2',
              subject: 'Revisión de arquitectura',
              start: { dateTime: '2026-10-30T11:00:00', timeZone: 'Europe/Madrid' },
              end: { dateTime: '2026-10-30T12:00:00', timeZone: 'Europe/Madrid' },
              organizer: {
                emailAddress: { name: '', address: 'arquitectura@empresa.com' },
              },
              isAllDay: false,
              isCancelled: false,
              showAs: 'tentative',
              location: { displayName: '' },
            },
          ],
        }),
      );

    const tokenProvider: AuthTokenProvider = {
      getAccessToken: vi.fn().mockResolvedValue('token-delegated'),
    };

    const client = createGraphClient({
      config: createConfig({ AUTH_MODE: 'delegated', TIMEZONE: 'Europe/Madrid' }),
      tokenProvider,
      fetchFn: fetchMock,
      logger: createSilentLogger(),
    });

    const events = await client.listEvents(
      'cal-1',
      '2026-10-30T00:00:00Z',
      '2026-10-30T23:59:59Z',
    );

    expect(events).toEqual([
      {
        id: 'evt-1',
        subject: 'Daily Sync',
        start: '2026-10-30T09:00:00',
        end: '2026-10-30T09:30:00',
        organizer: 'Carlos Gómez',
        isAllDay: false,
        isCancelled: false,
        showAs: 'busy',
        location: 'Sala Norte',
      },
      {
        id: 'evt-2',
        subject: 'Revisión de arquitectura',
        start: '2026-10-30T11:00:00',
        end: '2026-10-30T12:00:00',
        organizer: 'arquitectura@empresa.com',
        isAllDay: false,
        isCancelled: false,
        showAs: 'tentative',
        location: null,
      },
    ]);

    const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(firstUrl.origin + firstUrl.pathname).toBe(
      'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView',
    );
    expect(firstUrl.searchParams.get('startDateTime')).toBe('2026-10-30T00:00:00Z');
    expect(firstUrl.searchParams.get('endDateTime')).toBe('2026-10-30T23:59:59Z');
    expect(firstUrl.searchParams.get('$select')).toBe(EVENT_SELECT_FIELDS);

    const firstInit = fetchMock.mock.calls[0]?.[1];
    const headers = firstInit?.headers as Record<string, string>;
    expect(headers.Prefer).toBe('outlook.timezone="Europe/Madrid"');
    expect(headers.Authorization).toBe('Bearer token-delegated');
  });

  it('gestiona respuestas 429 respetando Retry-After antes de reintentar', async () => {
    const sleepCalls: number[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('Too Many Requests', {
          status: 429,
          headers: { 'Retry-After': '4' },
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          value: [
            {
              id: 'cal-ok',
              name: 'Sala Principal',
            },
          ],
        }),
      );

    const tokenProvider: AuthTokenProvider = {
      getAccessToken: vi.fn().mockResolvedValue('token-valid'),
    };

    const client = createGraphClient({
      config: createConfig(),
      tokenProvider,
      fetchFn: fetchMock,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
      logger: createSilentLogger(),
    });

    const calendars = await client.listCalendars();
    expect(calendars).toHaveLength(1);
    expect(sleepCalls).toEqual([4000]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gestiona respuestas 401 renovando el token (forceRefresh=true) y reintentando la petición', async () => {
    const getAccessTokenMock = vi
      .fn<(forceRefresh?: boolean) => Promise<string>>()
      .mockImplementation(async (forceRefresh) =>
        forceRefresh ? 'token-renovado' : 'token-expirado',
      );

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        createJsonResponse({
          value: [
            {
              id: 'cal-1',
              name: 'Calendario Renovado',
            },
          ],
        }),
      );

    const client = createGraphClient({
      config: createConfig(),
      tokenProvider: { getAccessToken: getAccessTokenMock },
      fetchFn: fetchMock,
      logger: createSilentLogger(),
    });

    const calendars = await client.listCalendars();
    expect(calendars[0]?.name).toBe('Calendario Renovado');
    expect(getAccessTokenMock).toHaveBeenCalledTimes(2);
    expect(getAccessTokenMock).toHaveBeenNthCalledWith(1, false);
    expect(getAccessTokenMock).toHaveBeenNthCalledWith(2, true);

    const secondCallHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(secondCallHeaders.Authorization).toBe('Bearer token-renovado');
  });

  it('createEvent() envía POST a Graph con zona horaria y formato correcto', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      createJsonResponse({
        id: 'new-evt-123',
        subject: 'Reserva rápida (15 min)',
        start: { dateTime: '2026-10-30T10:00:00', timeZone: 'Europe/Madrid' },
        end: { dateTime: '2026-10-30T10:15:00', timeZone: 'Europe/Madrid' },
        showAs: 'busy',
        isAllDay: false,
        isCancelled: false,
      }),
    );

    const client = createGraphClient({
      config: createConfig({ AUTH_MODE: 'app' }),
      tokenProvider: { getAccessToken: async () => 'token-app' },
      fetchFn: fetchMock,
      logger: createSilentLogger(),
    });

    const created = await client.createEvent('sala.norte@empresa.com', {
      subject: 'Reserva rápida (15 min)',
      start: '2026-10-30T10:00:00Z',
      end: '2026-10-30T10:15:00Z',
    });

    expect(created.id).toBe('new-evt-123');
    expect(created.subject).toBe('Reserva rápida (15 min)');
    expect(created.showAs).toBe('busy');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] ?? [];
    expect(calledUrl).toBe(
      'https://graph.microsoft.com/v1.0/users/sala.norte%40empresa.com/events',
    );
    expect(calledInit?.method).toBe('POST');
    const parsedBody = JSON.parse(calledInit?.body as string);
    expect(parsedBody.subject).toBe('Reserva rápida (15 min)');
    expect(parsedBody.showAs).toBe('busy');
  });

  it('lanza GraphApiError ante errores no recuperables y valida eventos con Zod', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

    const client = createGraphClient({
      config: createConfig(),
      tokenProvider: { getAccessToken: async () => 'token' },
      fetchFn: fetchMock,
      logger: createSilentLogger(),
    });

    await expect(client.listCalendars()).rejects.toThrow(GraphApiError);
    expect(() => mapGraphEvent({ id: '' })).toThrow();
  });
});
