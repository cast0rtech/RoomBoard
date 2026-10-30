import type { CalendarEvent, CalendarItem } from '../graph/index.js';
import {
  computeRoomStatus,
  parseEventDateTimeMs,
  type ComputeRoomStatusOptions,
  type RoomStatus,
} from './roomStatus.js';

export interface DateWindow {
  from: string;
  to: string;
}

export interface CalendarCacheSnapshot {
  calendarId: string;
  events: CalendarEvent[];
  status: RoomStatus;
  window: DateWindow;
  updatedAt: string;
}

export interface CacheUpdateResult {
  calendarId: string;
  statusChanged: boolean;
  eventsChanged: boolean;
  previousStatus: RoomStatus | null;
  status: RoomStatus;
  events: CalendarEvent[];
}

/** Calcula la ventana temporal desde hoy hasta el final del día dentro de 14 días. */
export function computeFourteenDayWindow(now: Date = new Date(), timezone = 'UTC'): DateWindow {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(now);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  const localMidnightStr = `${map.year}-${map.month}-${map.day}T00:00:00`;
  const startMs = parseEventDateTimeMs(localMidnightStr, timezone);

  const endDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const endParts = formatter.formatToParts(endDate);
  const endMap: Record<string, string> = {};
  for (const part of endParts) {
    if (part.type !== 'literal') {
      endMap[part.type] = part.value;
    }
  }

  const localEndOfDayStr = `${endMap.year}-${endMap.month}-${endMap.day}T23:59:59.999`;
  const endMs = parseEventDateTimeMs(localEndOfDayStr, timezone);

  return {
    from: new Date(startMs).toISOString(),
    to: new Date(endMs).toISOString(),
  };
}

/** Alias de compatibilidad para consumidores antiguos. */
export const computeSevenDayWindow = computeFourteenDayWindow;

function serializeEventsDigest(events: readonly CalendarEvent[]): string {
  return JSON.stringify(
    [...events]
      .sort((a, b) => a.id.localeCompare(b.id) || a.start.localeCompare(b.start))
      .map((e) => ({
        id: e.id,
        subject: e.subject,
        start: e.start,
        end: e.end,
        organizer: e.organizer,
        isAllDay: e.isAllDay,
        isCancelled: e.isCancelled,
        showAs: e.showAs,
        location: e.location,
      })),
  );
}

function serializeStatusDigest(status: RoomStatus): string {
  return JSON.stringify({
    state: status.state,
    currentId: status.current?.id ?? null,
    currentEnd: status.current?.end ?? null,
    nextId: status.next?.id ?? null,
    nextStart: status.next?.start ?? null,
    until: status.until,
  });
}

interface InternalCalendarEntry {
  events: CalendarEvent[];
  eventsDigest: string;
  status: RoomStatus;
  statusDigest: string;
  window: DateWindow;
  updatedAt: string;
}

/**
 * Caché en memoria de calendarios, eventos (ventana de 14 días) y estado por sala.
 */
export class CalendarEventsCache {
  private readonly entries = new Map<string, InternalCalendarEntry>();
  private calendars: CalendarItem[] = [];
  private readonly options: ComputeRoomStatusOptions;

  constructor(options: ComputeRoomStatusOptions = {}) {
    this.options = options;
  }

  public setCalendars(calendars: readonly CalendarItem[]): void {
    this.calendars = [...calendars];
  }

  public getCalendars(): CalendarItem[] {
    return [...this.calendars];
  }

  public getCalendarIds(): string[] {
    const ids = new Set<string>(this.calendars.map((c) => c.id));
    for (const key of this.entries.keys()) {
      ids.add(key);
    }
    return [...ids];
  }

  /**
   * Actualiza los eventos en caché de un calendario y recalcula su estado libre/ocupada.
   */
  public setEvents(
    calendarId: string,
    events: readonly CalendarEvent[],
    now: Date = new Date(),
    windowOverride?: DateWindow,
  ): CacheUpdateResult {
    const existing = this.entries.get(calendarId);
    const timezone = this.options.timezone ?? 'UTC';
    const window = windowOverride ?? computeFourteenDayWindow(now, timezone);

    const clonedEvents = [...events];
    const nextEventsDigest = serializeEventsDigest(clonedEvents);
    const nextStatus = computeRoomStatus(clonedEvents, now, this.options);
    const nextStatusDigest = serializeStatusDigest(nextStatus);

    const eventsChanged = !existing || existing.eventsDigest !== nextEventsDigest;
    const statusChanged = !existing || existing.statusDigest !== nextStatusDigest;

    this.entries.set(calendarId, {
      events: clonedEvents,
      eventsDigest: nextEventsDigest,
      status: nextStatus,
      statusDigest: nextStatusDigest,
      window,
      updatedAt: now.toISOString(),
    });

    return {
      calendarId,
      statusChanged,
      eventsChanged,
      previousStatus: existing?.status ?? null,
      status: nextStatus,
      events: clonedEvents,
    };
  }

  /**
   * Recalcula el estado de un calendario con la hora actual `now` usando los eventos ya cacheados.
   */
  public recomputeStatus(calendarId: string, now: Date = new Date()): CacheUpdateResult | null {
    const existing = this.entries.get(calendarId);
    if (!existing) {
      return null;
    }

    const nextStatus = computeRoomStatus(existing.events, now, this.options);
    const nextStatusDigest = serializeStatusDigest(nextStatus);
    const statusChanged = existing.statusDigest !== nextStatusDigest;

    existing.status = nextStatus;
    existing.statusDigest = nextStatusDigest;
    existing.updatedAt = now.toISOString();

    return {
      calendarId,
      statusChanged,
      eventsChanged: false,
      previousStatus: existing.status,
      status: nextStatus,
      events: [...existing.events],
    };
  }

  /**
   * Obtiene los eventos en caché de un calendario, filtrando opcionalmente por rango `[from, to]`.
   */
  public getEvents(
    calendarId: string,
    from?: string | Date,
    to?: string | Date,
  ): CalendarEvent[] {
    const entry = this.entries.get(calendarId);
    if (!entry) {
      return [];
    }

    const timezone = this.options.timezone ?? 'UTC';
    const fromMs =
      from !== undefined
        ? from instanceof Date
          ? from.getTime()
          : parseEventDateTimeMs(from, timezone)
        : undefined;
    const toMs =
      to !== undefined
        ? to instanceof Date
          ? to.getTime()
          : parseEventDateTimeMs(to, timezone)
        : undefined;

    return entry.events.filter((event) => {
      const startMs = parseEventDateTimeMs(event.start, timezone);
      const endMs = parseEventDateTimeMs(event.end, timezone);
      if (fromMs !== undefined && !Number.isNaN(fromMs) && endMs <= fromMs) {
        return false;
      }
      if (toMs !== undefined && !Number.isNaN(toMs) && startMs >= toMs) {
        return false;
      }
      return true;
    });
  }

  /**
   * Devuelve el estado actual de la sala a partir de su caché en memoria.
   */
  public getStatus(calendarId: string, now?: Date): RoomStatus {
    const entry = this.entries.get(calendarId);
    if (!entry) {
      return {
        state: 'free',
        current: null,
        next: null,
        until: null,
      };
    }

    if (now) {
      return computeRoomStatus(entry.events, now, this.options);
    }

    return entry.status;
  }

  public getSnapshot(calendarId: string): CalendarCacheSnapshot | null {
    const entry = this.entries.get(calendarId);
    if (!entry) {
      return null;
    }

    return {
      calendarId,
      events: [...entry.events],
      status: entry.status,
      window: entry.window,
      updatedAt: entry.updatedAt,
    };
  }
}

