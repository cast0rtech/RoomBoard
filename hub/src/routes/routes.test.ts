import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { HubConfig } from '../config.js';
import type { CalendarEvent, GraphClient } from '../graph/index.js';
import { CalendarEventsCache, StateScheduler } from '../state/index.js';
import { registerRoutes } from './index.js';

function createTestConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    AUTH_MODE: 'delegated',
    TENANT_ID: 'tenant-id',
    CLIENT_ID: 'client-id',
    CLIENT_SECRET: undefined,
    ROOM_MAILBOXES: '',
    TIMEZONE: 'Europe/Madrid',
    PORT: 8080,
    DEVICE_KEYS: 'clave-tablet-1, clave-pc',
    POLL_SECONDS: 45,
    IGNORE_ALL_DAY: true,
    IGNORE_ALL_DAY_EVENTS: true,
    ...overrides,
  };
}

function createSampleEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-100',
    subject: 'Comité de Producto',
    organizer: 'Laura Martínez',
    start: '2026-10-30T10:00:00.000Z',
    end: '2026-10-30T11:00:00.000Z',
    isAllDay: false,
    isCancelled: false,
    showAs: 'busy',
    location: 'Sala Goya',
    ...overrides,
  };
}

describe('Rutas API del Hub con fastify.inject (hub/src/routes)', () => {
  it('verifica X-Device-Key en tiempo constante y bloquea peticiones no autorizadas (401)', async () => {
    const app = Fastify();
    await registerRoutes(app, createTestConfig());

    const missingKeyRes = await app.inject({
      method: 'GET',
      url: '/api/health',
    });
    expect(missingKeyRes.statusCode).toBe(401);

    const wrongKeyRes = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-device-key': 'clave-falsa' },
    });
    expect(wrongKeyRes.statusCode).toBe(401);

    const validKeyRes = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-device-key': 'clave-pc' },
    });
    expect(validKeyRes.statusCode).toBe(200);
    expect(validKeyRes.json()).toMatchObject({
      status: 'ok',
      service: 'roomboard-hub',
      timezone: 'Europe/Madrid',
    });

    await app.close();
  });

  it('aplica CORS restringido a red local y rechaza orígenes externos con 403', async () => {
    const app = Fastify();
    await registerRoutes(app, createTestConfig());

    const localOriginRes = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        'x-device-key': 'clave-tablet-1',
        origin: 'http://192.168.1.50:8080',
      },
    });
    expect(localOriginRes.statusCode).toBe(200);
    expect(localOriginRes.headers['access-control-allow-origin']).toBe(
      'http://192.168.1.50:8080',
    );

    const externalOriginRes = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        'x-device-key': 'clave-tablet-1',
        origin: 'https://atacante.ejemplo.com',
      },
    });
    expect(externalOriginRes.statusCode).toBe(403);

    await app.close();
  });

  it('aplica rate limiting básico devolviendo 429 y cabecera Retry-After', async () => {
    const app = Fastify();
    await registerRoutes(app, createTestConfig(), {
      rateLimiterOptions: { maxRequests: 2, windowMs: 60_000 },
    });

    const first = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-device-key': 'clave-tablet-1' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-device-key': 'clave-tablet-1' },
    });
    expect(second.statusCode).toBe(200);

    const third = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-device-key': 'clave-tablet-1' },
    });
    expect(third.statusCode).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();

    await app.close();
  });

  it('sirve /api/calendars, /api/calendars/:id/events (con validación Zod) y /api/rooms/:id/status', async () => {
    const fixedNow = new Date('2026-10-30T10:30:00.000Z');
    const sampleEvent = createSampleEvent();

    const fakeGraphClient: GraphClient = {
      listCalendars: vi.fn().mockResolvedValue([
        { id: 'sala-goya', name: 'Sala Goya', ownerAddress: 'goya@empresa.com' },
      ]),
      listEvents: vi.fn().mockResolvedValue([sampleEvent]),
      createEvent: vi.fn(),
    };

    const app = Fastify();
    await registerRoutes(app, createTestConfig(), {
      graphClient: fakeGraphClient,
      nowFn: () => fixedNow,
    });

    // 1. GET /api/calendars
    const calRes = await app.inject({
      method: 'GET',
      url: '/api/calendars',
      headers: { 'x-device-key': 'clave-tablet-1' },
    });
    expect(calRes.statusCode).toBe(200);
    expect(calRes.json()).toEqual({
      calendars: [{ id: 'sala-goya', name: 'Sala Goya', ownerAddress: 'goya@empresa.com' }],
    });

    // 2. GET /api/calendars/:id/events con fechas válidas e inválidas
    const invalidEventsRes = await app.inject({
      method: 'GET',
      url: '/api/calendars/sala-goya/events?from=fecha-invalida',
      headers: { 'x-device-key': 'clave-tablet-1' },
    });
    expect(invalidEventsRes.statusCode).toBe(400);

    const invertedRangeRes = await app.inject({
      method: 'GET',
      url: '/api/calendars/sala-goya/events?from=2026-10-31T00:00:00Z&to=2026-10-30T00:00:00Z',
      headers: { 'x-device-key': 'clave-tablet-1' },
    });
    expect(invertedRangeRes.statusCode).toBe(400);

    const validEventsRes = await app.inject({
      method: 'GET',
      url: '/api/calendars/sala-goya/events?from=2026-10-30T08:00:00Z&to=2026-10-30T18:00:00Z',
      headers: { 'x-device-key': 'clave-tablet-1' },
    });
    expect(validEventsRes.statusCode).toBe(200);
    expect(validEventsRes.json().events).toHaveLength(1);
    expect(validEventsRes.json().events[0].subject).toBe('Comité de Producto');

    // 3. GET /api/rooms/:id/status
    const statusRes = await app.inject({
      method: 'GET',
      url: '/api/rooms/sala-goya/status',
      headers: { 'x-device-key': 'clave-tablet-1' },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json()).toEqual({
      state: 'busy',
      current: sampleEvent,
      next: null,
      until: '2026-10-30T11:00:00.000Z',
    });

    await app.close();
  });

  it('GET /api/stream emite eventos SSE "status", "events" y heartbeat', async () => {
    const fixedNow = new Date('2026-10-30T10:30:00.000Z');
    const sampleEvent = createSampleEvent();

    const fakeGraphClient: GraphClient = {
      listCalendars: vi.fn().mockResolvedValue([{ id: 'sala-goya', name: 'Sala Goya' }]),
      listEvents: vi.fn().mockResolvedValue([sampleEvent]),
      createEvent: vi.fn(),
    };

    const cache = new CalendarEventsCache({
      ignoreAllDay: true,
      timezone: 'Europe/Madrid',
    });
    const scheduler = new StateScheduler({
      graphClient: fakeGraphClient,
      cache,
      pollSeconds: 45,
      timezone: 'Europe/Madrid',
      nowFn: () => fixedNow,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const app = Fastify();
    await registerRoutes(app, createTestConfig(), {
      graphClient: fakeGraphClient,
      cache,
      scheduler,
      heartbeatIntervalMs: 15,
      nowFn: () => fixedNow,
    });

    // Disparamos un refresco poco después de abrir el stream; maxEvents=2 cierra el stream tras recibir "status" y "events"
    setTimeout(() => {
      void scheduler.refreshAll(fixedNow);
    }, 30);

    const streamRes = await app.inject({
      method: 'GET',
      url: '/api/stream?maxEvents=2',
      headers: { 'x-device-key': 'clave-tablet-1' },
    });

    expect(streamRes.statusCode).toBe(200);
    expect(streamRes.headers['content-type']).toContain('text/event-stream');
    expect(streamRes.body).toContain(': heartbeat');
    expect(streamRes.body).toContain('event: status');
    expect(streamRes.body).toContain('event: events');
    expect(streamRes.body).toContain('"calendarId":"sala-goya"');

    await app.close();
  });

  it('POST /api/rooms/:id/book gestiona reservas rápidas, valida duración y detecta solapamientos (409)', async () => {
    const fixedNow = new Date('2026-10-30T10:00:00.000Z');
    const eventsInRoom: CalendarEvent[] = [];

    const fakeGraphClient: GraphClient = {
      listCalendars: vi.fn().mockResolvedValue([{ id: 'sala-sol', name: 'Sala Sol' }]),
      listEvents: vi.fn(async () => eventsInRoom),
      createEvent: vi.fn(async (_calId, input) => {
        const created: CalendarEvent = {
          id: 'booking-1',
          subject: input.subject || 'Reserva rápida',
          start: String(input.start),
          end: String(input.end),
          isAllDay: false,
          isCancelled: false,
          showAs: 'busy',
        };
        eventsInRoom.push(created);
        return created;
      }),
    };

    const app = Fastify();
    await registerRoutes(app, createTestConfig(), {
      graphClient: fakeGraphClient,
      nowFn: () => fixedNow,
    });

    // 1. Duración inválida (distinta de 15, 30 o 60) -> 400
    const invalidMinutesRes = await app.inject({
      method: 'POST',
      url: '/api/rooms/sala-sol/book',
      headers: { 'x-device-key': 'clave-tablet-1' },
      payload: { minutes: 45 },
    });
    expect(invalidMinutesRes.statusCode).toBe(400);

    // 2. Reserva exitosa de 30 minutos cuando la sala está libre -> 201
    const successfulBookingRes = await app.inject({
      method: 'POST',
      url: '/api/rooms/sala-sol/book',
      headers: { 'x-device-key': 'clave-tablet-1' },
      payload: { minutes: 30, subject: 'Reunión rápida' },
    });
    expect(successfulBookingRes.statusCode).toBe(201);
    expect(successfulBookingRes.json()).toMatchObject({
      status: 'booked',
      roomId: 'sala-sol',
      event: { id: 'booking-1', subject: 'Reunión rápida' },
      roomStatus: { state: 'busy' },
    });

    // 3. Intento de reserva solapada en ese mismo intervalo -> 409
    const conflictingBookingRes = await app.inject({
      method: 'POST',
      url: '/api/rooms/sala-sol/book',
      headers: { 'x-device-key': 'clave-tablet-1' },
      payload: { minutes: 15 },
    });
    expect(conflictingBookingRes.statusCode).toBe(409);
    expect(conflictingBookingRes.json()).toMatchObject({
      error: 'Conflict',
    });

    await app.close();
  });
});
