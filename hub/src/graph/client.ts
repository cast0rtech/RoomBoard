import type { AuthTokenProvider } from '../auth/index.js';
import type { HubConfig } from '../config.js';
import {
  createGraphPageSchema,
  graphCalendarResponseSchema,
  graphEventResponseSchema,
  mapGraphCalendar,
  mapGraphEvent,
  type CalendarItem,
  type Event,
} from './schemas.js';

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
export const EVENT_SELECT_FIELDS =
  'id,subject,start,end,organizer,isAllDay,isCancelled,showAs,location';
export const CALENDAR_SELECT_FIELDS = 'id,name,owner';

const calendarPageSchema = createGraphPageSchema(graphCalendarResponseSchema);
const eventPageSchema = createGraphPageSchema(graphEventResponseSchema);

export class GraphApiError extends Error {
  public readonly statusCode: number;
  public readonly responseBody: string;

  constructor(message: string, statusCode: number, responseBody = '') {
    super(message);
    this.name = 'GraphApiError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export interface GraphClientLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface GraphClientOptions {
  config: HubConfig;
  tokenProvider: AuthTokenProvider;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  maxRateLimitRetries?: number;
  defaultRetryAfterMs?: number;
  logger?: GraphClientLogger;
}

export interface GraphClient {
  listCalendars(): Promise<CalendarItem[]>;
  listEvents(calendarId: string, from: string | Date, to: string | Date): Promise<Event[]>;
}

const defaultLogger: GraphClientLogger = {
  info: (msg: string) => console.info(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extrae el tiempo de espera en milisegundos de la cabecera `Retry-After` (segundos o fecha HTTP).
 */
export function parseRetryAfterMs(
  retryAfterHeader: string | null,
  fallbackMs = 2000,
): number {
  if (!retryAfterHeader) {
    return fallbackMs;
  }

  const trimmed = retryAfterHeader.trim();
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const retryDateMs = Date.parse(trimmed);
  if (!Number.isNaN(retryDateMs)) {
    return Math.max(0, retryDateMs - Date.now());
  }

  return fallbackMs;
}

function parseRoomMailboxes(rawMailboxes: string): string[] {
  return rawMailboxes
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function toIsoDateString(value: string | Date, fieldName: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`La fecha "${fieldName}" no es válida.`);
    }
    return value.toISOString();
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`El parámetro "${fieldName}" debe estar en formato ISO 8601 válido.`);
  }
  return value;
}

/**
 * Crea un cliente HTTP para Microsoft Graph v1.0 con soporte para modo `delegated` y `app`,
 * paginación `@odata.nextLink`, cabecera `Prefer: outlook.timezone`, manejo de 429 y renovación en 401.
 */
export function createGraphClient(options: GraphClientOptions): GraphClient {
  const { config, tokenProvider } = options;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const sleepFn = options.sleepFn ?? defaultSleep;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? 3;
  const defaultRetryAfterMs = options.defaultRetryAfterMs ?? 2000;
  const logger = options.logger ?? defaultLogger;

  async function requestJson(url: string): Promise<unknown> {
    let tokenRefreshedAfter401 = false;
    let rateLimitAttempt = 0;
    let currentToken = await tokenProvider.getAccessToken(false);

    while (true) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${currentToken}`,
        Accept: 'application/json',
        Prefer: `outlook.timezone="${config.TIMEZONE}"`,
      };

      const response = await fetchFn(url, {
        method: 'GET',
        headers,
      });

      if (response.status === 401 && !tokenRefreshedAfter401) {
        tokenRefreshedAfter401 = true;
        logger.warn('[Graph] Recibido 401 Unauthorized. Renovando token de acceso y reintentando...');
        currentToken = await tokenProvider.getAccessToken(true);
        continue;
      }

      if (response.status === 429) {
        if (rateLimitAttempt >= maxRateLimitRetries) {
          const errorBody = await response.text();
          throw new GraphApiError(
            `Microsoft Graph devolvió 429 tras ${maxRateLimitRetries} reintentos.`,
            429,
            errorBody,
          );
        }

        rateLimitAttempt += 1;
        const retryAfterHeader = response.headers.get('retry-after');
        const waitMs = parseRetryAfterMs(retryAfterHeader, defaultRetryAfterMs);
        logger.warn(
          `[Graph] Límite de peticiones alcanzado (429). Esperando ${waitMs} ms antes del reintento ${rateLimitAttempt}/${maxRateLimitRetries}...`,
        );
        await sleepFn(waitMs);
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new GraphApiError(
          `Error en petición a Microsoft Graph (${response.status}): ${errorBody}`,
          response.status,
          errorBody,
        );
      }

      return response.json();
    }
  }

  async function listDelegatedCalendars(): Promise<CalendarItem[]> {
    const calendars: CalendarItem[] = [];
    const initialUrl = new URL(`${GRAPH_BASE_URL}/me/calendars`);
    initialUrl.searchParams.set('$select', CALENDAR_SELECT_FIELDS);

    let nextUrl: string | undefined = initialUrl.toString();

    while (nextUrl) {
      const rawJson = await requestJson(nextUrl);
      const page = calendarPageSchema.parse(rawJson);
      for (const rawCalendar of page.value) {
        calendars.push(mapGraphCalendar(rawCalendar));
      }
      nextUrl = page['@odata.nextLink'];
    }

    return calendars;
  }

  async function listAppRoomCalendars(): Promise<CalendarItem[]> {
    const mailboxes = parseRoomMailboxes(config.ROOM_MAILBOXES);
    if (mailboxes.length === 0) {
      throw new Error(
        'ROOM_MAILBOXES está vacío. En modo "app" debes especificar al menos un buzón de sala.',
      );
    }

    const calendars: CalendarItem[] = [];
    for (const mailbox of mailboxes) {
      const url = new URL(
        `${GRAPH_BASE_URL}/users/${encodeURIComponent(mailbox)}/calendar`,
      );
      url.searchParams.set('$select', CALENDAR_SELECT_FIELDS);

      const rawJson = await requestJson(url.toString());
      calendars.push(mapGraphCalendar(rawJson, mailbox));
    }

    return calendars;
  }

  function buildCalendarViewUrl(calendarId: string, startIso: string, endIso: string): string {
    const encodedId = encodeURIComponent(calendarId);
    const basePath =
      config.AUTH_MODE === 'app'
        ? `${GRAPH_BASE_URL}/users/${encodedId}/calendar/calendarView`
        : `${GRAPH_BASE_URL}/me/calendars/${encodedId}/calendarView`;

    const url = new URL(basePath);
    url.searchParams.set('startDateTime', startIso);
    url.searchParams.set('endDateTime', endIso);
    url.searchParams.set('$select', EVENT_SELECT_FIELDS);
    return url.toString();
  }

  return {
    async listCalendars(): Promise<CalendarItem[]> {
      if (config.AUTH_MODE === 'app') {
        return listAppRoomCalendars();
      }
      return listDelegatedCalendars();
    },

    async listEvents(
      calendarId: string,
      from: string | Date,
      to: string | Date,
    ): Promise<Event[]> {
      if (!calendarId.trim()) {
        throw new Error('calendarId es obligatorio para consultar eventos.');
      }

      const startIso = toIsoDateString(from, 'from');
      const endIso = toIsoDateString(to, 'to');

      const events: Event[] = [];
      let nextUrl: string | undefined = buildCalendarViewUrl(calendarId, startIso, endIso);

      while (nextUrl) {
        const rawJson = await requestJson(nextUrl);
        const page = eventPageSchema.parse(rawJson);
        for (const rawEvent of page.value) {
          events.push(mapGraphEvent(rawEvent));
        }
        nextUrl = page['@odata.nextLink'];
      }

      return events;
    },

  };
}
