import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createAuthProvider } from '../auth/index.js';
import type { HubConfig } from '../config.js';
import { createGraphClient, type GraphClient } from '../graph/index.js';
import {
  CalendarEventsCache,
  computeSevenDayWindow,
  isBlockingEvent,
  parseEventDateTimeMs,
  StateScheduler,
  type StateChangeEvent,
} from '../state/index.js';
import {
  applyLocalCors,
  extractDeviceKeyHeader,
  InMemoryRateLimiter,
  isValidDeviceKey,
  parseDeviceKeys,
  type RateLimiterOptions,
} from './security.js';

export {
  constantTimeCompare,
  InMemoryRateLimiter,
  isAllowedLocalOrigin,
  isValidDeviceKey,
  parseDeviceKeys,
} from './security.js';

export const DEFAULT_HEARTBEAT_MS = 20_000;

const idParamsSchema = z.object({
  id: z.string().trim().min(1, 'El identificador es obligatorio.'),
});

const isoDateStringSchema = z
  .string()
  .trim()
  .refine((val) => !Number.isNaN(Date.parse(val)), {
    message: 'Debe ser una fecha en formato ISO 8601 válido.',
  });

const eventsQuerySchema = z
  .object({
    from: isoDateStringSchema.optional(),
    to: isoDateStringSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.from && data.to) {
        return Date.parse(data.from) < Date.parse(data.to);
      }
      return true;
    },
    {
      message: 'El parámetro "from" debe ser anterior a "to".',
    },
  );

const streamQuerySchema = z.object({
  calendarId: z.string().trim().min(1).optional(),
  maxEvents: z.coerce.number().int().positive().optional(),
});

const bookBodySchema = z.object({
  minutes: z.union([z.literal(15), z.literal(30), z.literal(60)], {
    errorMap: () => ({ message: 'El campo "minutes" debe ser 15, 30 o 60.' }),
  }),
  subject: z.string().trim().optional(),
});

export interface RouteDependencies {
  graphClient?: GraphClient;
  cache?: CalendarEventsCache;
  scheduler?: StateScheduler;
  rateLimiterOptions?: RateLimiterOptions;
  heartbeatIntervalMs?: number;
  nowFn?: () => Date;
}

function createNoopGraphClient(): GraphClient {
  return {
    async listCalendars() {
      return [];
    },
    async listEvents() {
      return [];
    },
    async createEvent() {
      throw new Error('Graph client no configurado.');
    },
  };
}

function resolveGraphClient(config: HubConfig, deps: RouteDependencies): GraphClient {
  if (deps.graphClient) {
    return deps.graphClient;
  }

  try {
    const tokenProvider = createAuthProvider(config);
    return createGraphClient({ config, tokenProvider });
  } catch {
    return createNoopGraphClient();
  }
}

function writeSseEvent(reply: FastifyReply, eventName: string, payload: unknown): void {
  reply.raw.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function writeSseHeartbeat(reply: FastifyReply, timestamp: string): void {
  reply.raw.write(`: heartbeat ${timestamp}\n\n`);
}

/**
 * Registra los middlewares de seguridad y las rutas de la API local del Hub.
 */
export async function registerRoutes(
  app: FastifyInstance,
  config: HubConfig,
  deps: RouteDependencies = {},
): Promise<{
  cache: CalendarEventsCache;
  scheduler: StateScheduler;
}> {
  const allowedDeviceKeys = parseDeviceKeys(config.DEVICE_KEYS);
  const rateLimiter = new InMemoryRateLimiter(deps.rateLimiterOptions);
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const nowFn = deps.nowFn ?? (() => new Date());

  const cache =
    deps.cache ??
    new CalendarEventsCache({
      ignoreAllDay: config.IGNORE_ALL_DAY,
      timezone: config.TIMEZONE,
    });

  const graphClient = resolveGraphClient(config, deps);

  const scheduler =
    deps.scheduler ??
    new StateScheduler({
      graphClient,
      cache,
      pollSeconds: config.POLL_SECONDS,
      timezone: config.TIMEZONE,
      nowFn,
    });

  // Hook global: CORS restringido a red local, preflight OPTIONS, Rate Limiting y X-Device-Key
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const corsAllowed = applyLocalCors(request, reply);
    if (!corsAllowed) {
      await reply.code(403).send({
        error: 'ForbiddenOrigin',
        message: 'Origen no permitido. El Hub solo acepta clientes en la red local.',
      });
      return;
    }

    if (request.method === 'OPTIONS') {
      await reply.code(204).send();
      return;
    }

    if (!request.url.startsWith('/api/')) {
      return;
    }

    const providedKey = extractDeviceKeyHeader(request);
    const rateKey = `${request.ip}:${providedKey ?? 'anon'}`;
    const rateResult = rateLimiter.consume(rateKey);

    reply.header('X-RateLimit-Remaining', String(rateResult.remaining));
    if (!rateResult.allowed) {
      reply.header('Retry-After', String(rateResult.retryAfterSeconds));
      await reply.code(429).send({
        error: 'TooManyRequests',
        message: 'Se ha superado el límite de peticiones permitidas.',
      });
      return;
    }

    if (!isValidDeviceKey(providedKey, allowedDeviceKeys)) {
      await reply.code(401).send({
        error: 'UnauthorizedDevice',
        message: 'Cabecera X-Device-Key ausente o no autorizada.',
      });
      return;
    }
  });

  // GET /api/health
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      service: 'roomboard-hub',
      authMode: config.AUTH_MODE,
      timezone: config.TIMEZONE,
      cachedCalendars: cache.getCalendars().length,
      timestamp: nowFn().toISOString(),
    };
  });

  // GET /api/calendars
  app.get('/api/calendars', async (_request, reply) => {
    try {
      let calendars = cache.getCalendars();
      if (calendars.length === 0) {
        calendars = await graphClient.listCalendars();
        cache.setCalendars(calendars);
      }
      return { calendars };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      requestLogError(app, error, 'Error al obtener la lista de calendarios');
      return reply.code(502).send({
        error: 'GraphUpstreamError',
        message: `No se pudieron obtener los calendarios: ${detail}`,
      });
    }
  });

  // GET /api/calendars/:id/events?from=&to=
  app.get('/api/calendars/:id/events', async (request, reply) => {
    const paramsResult = idParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: paramsResult.error.issues[0]?.message ?? 'Parámetro :id inválido.',
      });
    }

    const queryResult = eventsQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message:
          queryResult.error.issues[0]?.message ?? 'Parámetros de consulta from/to inválidos.',
      });
    }

    const calendarId = paramsResult.data.id;
    const defaultWindow = computeSevenDayWindow(nowFn(), config.TIMEZONE);
    const fromIso = queryResult.data.from ?? defaultWindow.from;
    const toIso = queryResult.data.to ?? defaultWindow.to;

    try {
      const snapshot = cache.getSnapshot(calendarId);
      const fromMs = Date.parse(fromIso);
      const toMs = Date.parse(toIso);

      const isCoveredByCache =
        snapshot !== null &&
        fromMs >= Date.parse(snapshot.window.from) &&
        toMs <= Date.parse(snapshot.window.to);

      if (isCoveredByCache) {
        const events = cache.getEvents(calendarId, fromIso, toIso);
        return { calendarId, from: fromIso, to: toIso, events };
      }

      const events = await graphClient.listEvents(calendarId, fromIso, toIso);
      if (!queryResult.data.from && !queryResult.data.to) {
        cache.setEvents(calendarId, events, nowFn(), defaultWindow);
      }

      return { calendarId, from: fromIso, to: toIso, events };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      requestLogError(app, error, `Error al obtener eventos del calendario ${calendarId}`);
      return reply.code(502).send({
        error: 'GraphUpstreamError',
        message: `No se pudieron obtener los eventos: ${detail}`,
      });
    }
  });

  // GET /api/rooms/:id/status
  app.get('/api/rooms/:id/status', async (request, reply) => {
    const paramsResult = idParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: paramsResult.error.issues[0]?.message ?? 'Parámetro :id inválido.',
      });
    }

    const roomId = paramsResult.data.id;
    try {
      if (!cache.getSnapshot(roomId)) {
        await scheduler.refreshCalendar(roomId, nowFn());
      } else {
        cache.recomputeStatus(roomId, nowFn());
      }

      const status = cache.getStatus(roomId, nowFn());
      return status;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      requestLogError(app, error, `Error al calcular el estado de la sala ${roomId}`);
      return reply.code(502).send({
        error: 'GraphUpstreamError',
        message: `No se pudo obtener el estado de la sala: ${detail}`,
      });
    }
  });

  // POST /api/rooms/:id/book
  app.post('/api/rooms/:id/book', async (request, reply) => {
    const paramsResult = idParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: paramsResult.error.issues[0]?.message ?? 'Parámetro :id inválido.',
      });
    }

    const bodyResult = bookBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: bodyResult.error.issues[0]?.message ?? 'Cuerpo de petición inválido.',
      });
    }

    const roomId = paramsResult.data.id;
    const { minutes, subject } = bodyResult.data;
    const startTime = nowFn();
    const endTime = new Date(startTime.getTime() + minutes * 60 * 1000);
    const startMs = startTime.getTime();
    const endMs = endTime.getTime();

    try {
      // 1. Asegurar que tenemos eventos actualizados para comprobar solapamiento
      if (!cache.getSnapshot(roomId)) {
        await scheduler.refreshCalendar(roomId, startTime);
      }

      const existingEvents = cache.getEvents(
        roomId,
        new Date(startMs - 60 * 60 * 1000),
        new Date(endMs + 60 * 60 * 1000),
      );

      // 2. Comprobar solapamiento con cualquier evento bloqueante existente
      const hasConflict = existingEvents.some((evt) => {
        if (!isBlockingEvent(evt, { ignoreAllDay: config.IGNORE_ALL_DAY })) {
          return false;
        }
        const eStart = parseEventDateTimeMs(evt.start, config.TIMEZONE);
        const eEnd = parseEventDateTimeMs(evt.end, config.TIMEZONE);
        // Solapamiento: el evento existente empieza antes de que termine el nuevo y termina después de que empiece
        return eStart < endMs && eEnd > startMs;
      });

      if (hasConflict) {
        return reply.code(409).send({
          error: 'Conflict',
          message:
            'La sala no está libre para el intervalo seleccionado; ya existe una reunión solapada.',
        });
      }

      // 3. Crear el evento en Microsoft Graph
      const createdEvent = await graphClient.createEvent(roomId, {
        subject: subject || `Reserva rápida (${minutes} min)`,
        start: startTime.toISOString(),
        end: endTime.toISOString(),
      });

      // 4. Refrescar el estado de la sala y emitir evento
      await scheduler.refreshCalendar(roomId, startTime);
      const updatedStatus = cache.getStatus(roomId, startTime);

      return reply.code(201).send({
        status: 'booked',
        roomId,
        event: createdEvent,
        roomStatus: updatedStatus,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      requestLogError(app, error, `Error al realizar reserva rápida en ${roomId}`);
      return reply.code(502).send({
        error: 'GraphUpstreamError',
        message: `No se pudo crear la reserva en Microsoft Graph: ${detail}`,
      });
    }
  });

  // GET /api/stream (Server-Sent Events)
  app.get('/api/stream', async (request, reply) => {
    const queryResult = streamQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'Parámetros de stream inválidos.',
      });
    }

    const filterCalendarId = queryResult.data.calendarId;
    const maxEvents = queryResult.data.maxEvents;

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let emittedCount = 0;
    let closed = false;

    const cleanup = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeatTimer);
      scheduler.off('statusChange', onStatusChange);
      scheduler.off('eventsChange', onEventsChange);
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    const checkLimit = (): void => {
      if (maxEvents !== undefined && emittedCount >= maxEvents) {
        cleanup();
      }
    };

    const onStatusChange = (change: StateChangeEvent): void => {
      if (closed) {
        return;
      }
      if (filterCalendarId && change.calendarId !== filterCalendarId) {
        return;
      }
      writeSseEvent(reply, 'status', {
        calendarId: change.calendarId,
        status: change.status,
        timestamp: change.timestamp,
      });
      emittedCount += 1;
      checkLimit();
    };

    const onEventsChange = (change: StateChangeEvent): void => {
      if (closed) {
        return;
      }
      if (filterCalendarId && change.calendarId !== filterCalendarId) {
        return;
      }
      writeSseEvent(reply, 'events', {
        calendarId: change.calendarId,
        events: change.events,
        timestamp: change.timestamp,
      });
      emittedCount += 1;
      checkLimit();
    };

    scheduler.on('statusChange', onStatusChange);
    scheduler.on('eventsChange', onEventsChange);

    const heartbeatTimer = setInterval(() => {
      if (closed) {
        return;
      }
      writeSseHeartbeat(reply, nowFn().toISOString());
    }, heartbeatIntervalMs);

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });

  return { cache, scheduler };
}

function requestLogError(app: FastifyInstance, error: unknown, context: string): void {
  app.log.error({ err: error }, context);
}
