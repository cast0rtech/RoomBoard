import type { CalendarEvent } from '../graph/index.js';

export type RoomState = 'free' | 'busy';

export interface RoomStatus {
  state: RoomState;
  current: CalendarEvent | null;
  next: CalendarEvent | null;
  until: string | null;
}

export interface ComputeRoomStatusOptions {
  /** Ignorar eventos de día completo (`isAllDay = true`). Por defecto: `true` */
  ignoreAllDay?: boolean;
  /** Alias por compatibilidad */
  ignoreAllDayEvents?: boolean;
  /** Zona horaria IANA para interpretar fechas locales sin sufijo Z ni offset */
  timezone?: string;
}

const EXPLICIT_OFFSET_REGEX = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_ISO_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?$/;

function getTimeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = Number(part.value);
    }
  }

  const year = map.year ?? 1970;
  const month = (map.month ?? 1) - 1;
  const day = map.day ?? 1;
  const hour = map.hour === 24 ? 0 : (map.hour ?? 0);
  const minute = map.minute ?? 0;
  const second = map.second ?? 0;

  const asUtcMs = Date.UTC(year, month, day, hour, minute, second);
  const truncatedUtcMs = Math.floor(utcMs / 1000) * 1000;
  return asUtcMs - truncatedUtcMs;
}

/**
 * Convierte una cadena de fecha ISO 8601 a milisegundos epoch UTC.
 * Si la fecha incluye `Z` u offset explícito (`+02:00`), la interpreta directamente.
 * Si es una fecha local sin offset (como devuelve Graph con `Prefer: outlook.timezone`),
 * aplica la zona horaria IANA indicada (`timezone`, por defecto `UTC`).
 */
export function parseEventDateTimeMs(dateTimeStr: string, timezone = 'UTC'): number {
  const trimmed = dateTimeStr.trim();
  if (EXPLICIT_OFFSET_REGEX.test(trimmed)) {
    return Date.parse(trimmed);
  }

  const match = LOCAL_ISO_REGEX.exec(trimmed);
  if (!match) {
    return Date.parse(trimmed);
  }

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? '0');
  const fractionRaw = (match[7] ?? '0').slice(0, 3).padEnd(3, '0');
  const millisecond = Number(fractionRaw);

  const wallAsUtcMs = Date.UTC(year, month, day, hour, minute, second, millisecond);
  if (timezone.toUpperCase() === 'UTC') {
    return wallAsUtcMs;
  }

  // Dos pasadas para resolver correctamente cambios de hora (DST)
  const firstOffset = getTimeZoneOffsetMs(wallAsUtcMs, timezone);
  const firstGuess = wallAsUtcMs - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(firstGuess, timezone);
  return wallAsUtcMs - secondOffset;
}

/**
 * Determina si un evento bloquea la sala según las reglas de negocio:
 * - No está cancelado (`!isCancelled`)
 * - `showAs !== 'free'`
 * - Si `ignoreAllDay` está activo (por defecto `true`), no es de día completo (`!isAllDay`)
 */
export function isBlockingEvent(
  event: CalendarEvent,
  options: ComputeRoomStatusOptions = {},
): boolean {
  const ignoreAllDay = options.ignoreAllDay ?? options.ignoreAllDayEvents ?? true;
  if (event.isCancelled) {
    return false;
  }
  if (event.showAs === 'free') {
    return false;
  }
  if (ignoreAllDay && event.isAllDay) {
    return false;
  }
  return true;
}

interface ParsedEventEntry {
  event: CalendarEvent;
  startMs: number;
  endMs: number;
}

/**
 * Calcula el estado libre/ocupada de una sala en el instante `now`.
 * Reglas:
 * - Ocupada (`busy`) si existe algún evento bloqueante con `start <= now < end`.
 * - En caso de citas activas solapadas, `current` es la cita activa que comenzó antes
 *   (o la de mayor duración en caso de empate) y `until` refleja el final más tardío entre las activas.
 * - `next` es la próxima cita bloqueante con `start > now`.
 */
export function computeRoomStatus(
  events: readonly CalendarEvent[],
  now: Date = new Date(),
  options: ComputeRoomStatusOptions = {},
): RoomStatus {
  const nowMs = now.getTime();
  const timezone = options.timezone ?? 'UTC';

  const blockingEntries: ParsedEventEntry[] = [];

  for (const event of events) {
    if (!isBlockingEvent(event, options)) {
      continue;
    }
    const startMs = parseEventDateTimeMs(event.start, timezone);
    const endMs = parseEventDateTimeMs(event.end, timezone);
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs) {
      blockingEntries.push({ event, startMs, endMs });
    }
  }

  blockingEntries.sort((a, b) => {
    if (a.startMs !== b.startMs) {
      return a.startMs - b.startMs;
    }
    return b.endMs - a.endMs;
  });

  const activeEntries = blockingEntries.filter(
    (entry) => entry.startMs <= nowMs && nowMs < entry.endMs,
  );

  const nextEntry =
    blockingEntries.find((entry) => entry.startMs > nowMs) ?? null;

  if (activeEntries.length > 0) {
    const primaryActive = activeEntries[0]!;
    let latestActiveEntry = primaryActive;
    for (const active of activeEntries) {
      if (active.endMs > latestActiveEntry.endMs) {
        latestActiveEntry = active;
      }
    }

    return {
      state: 'busy',
      current: primaryActive.event,
      next: nextEntry ? nextEntry.event : null,
      until: latestActiveEntry.event.end,
    };
  }

  return {
    state: 'free',
    current: null,
    next: nextEntry ? nextEntry.event : null,
    until: nextEntry ? nextEntry.event.start : null,
  };
}

/** Alias mantenido por compatibilidad */
export const evaluateRoomStatus = computeRoomStatus;

