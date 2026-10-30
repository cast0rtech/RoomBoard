import { EventEmitter } from 'node:events';
import type { CalendarEvent, GraphClient } from '../graph/index.js';
import {
  CalendarEventsCache,
  computeFourteenDayWindow,
  type CacheUpdateResult,
} from './cache.js';
import type { RoomStatus } from './roomStatus.js';

export interface StateChangeEvent {
  calendarId: string;
  statusChanged: boolean;
  eventsChanged: boolean;
  status: RoomStatus;
  events: CalendarEvent[];
  timestamp: string;
}

export interface SchedulerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface StateSchedulerOptions {
  graphClient: GraphClient;
  cache: CalendarEventsCache;
  pollSeconds: number;
  syncCalendarIds?: readonly string[];
  timezone?: string;
  nowFn?: () => Date;
  logger?: SchedulerLogger;
}

const defaultLogger: SchedulerLogger = {
  info: (msg: string) => console.info(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

/**
 * Sincroniza los calendarios habilitados y eventos de las próximas dos semanas.
 * Refresca cada 20 minutos de lunes a viernes entre 07:00 y 17:00, y cada 2 horas fuera de ese horario.
 */
export class StateScheduler extends EventEmitter {
  private readonly graphClient: GraphClient;
  private readonly cache: CalendarEventsCache;
  private readonly syncCalendarIds: Set<string> | null;
  private readonly timezone: string;
  private readonly nowFn: () => Date;
  private readonly logger: SchedulerLogger;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private isRefreshing = false;

  constructor(options: StateSchedulerOptions) {
    super();
    this.graphClient = options.graphClient;
    this.cache = options.cache;
    this.syncCalendarIds = options.syncCalendarIds?.length
      ? new Set(options.syncCalendarIds)
      : null;
    this.timezone = options.timezone ?? 'UTC';
    this.nowFn = options.nowFn ?? (() => new Date());
    this.logger = options.logger ?? defaultLogger;
  }

  /**
   * Ejecuta un ciclo completo de sincronización para todos los calendarios disponibles.
   */
  public async refreshAll(now: Date = this.nowFn()): Promise<StateChangeEvent[]> {
    if (this.isRefreshing) {
      return [];
    }

    this.isRefreshing = true;
    const changes: StateChangeEvent[] = [];

    try {
      const availableCalendars = await this.graphClient.listCalendars();
      const calendars = this.syncCalendarIds
        ? availableCalendars.filter((calendar) => this.syncCalendarIds!.has(calendar.id))
        : availableCalendars;
      this.cache.setCalendars(calendars);

      const window = computeFourteenDayWindow(now, this.timezone);

      for (const calendar of calendars) {
        try {
          const events = await this.graphClient.listEvents(
            calendar.id,
            window.from,
            window.to,
          );
          const update = this.cache.setEvents(calendar.id, events, now, window);
          const change = this.emitIfChanged(update, now);
          if (change) {
            changes.push(change);
          }
        } catch (calendarError) {
          const detail =
            calendarError instanceof Error ? calendarError.message : String(calendarError);
          this.logger.error(
            `[Scheduler] Error al refrescar eventos del calendario "${calendar.id}": ${detail}`,
          );
          this.emit('error', calendarError);
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Scheduler] Error al listar calendarios: ${detail}`);
      this.emit('error', error);
    } finally {
      this.isRefreshing = false;
    }

    return changes;
  }

  /**
   * Refresca un único calendario desde Microsoft Graph y emite `'change'` si hubo cambios.
   */
  public async refreshCalendar(
    calendarId: string,
    now: Date = this.nowFn(),
  ): Promise<CacheUpdateResult> {
    if (this.syncCalendarIds && !this.syncCalendarIds.has(calendarId)) {
      throw new Error(`El calendario \"${calendarId}\" no está habilitado para sincronización.`);
    }
    const window = computeFourteenDayWindow(now, this.timezone);
    const events = await this.graphClient.listEvents(calendarId, window.from, window.to);
    const update = this.cache.setEvents(calendarId, events, now, window);
    this.emitIfChanged(update, now);
    return update;
  }

  /**
   * Inicia el refresco adaptativo en horario de oficina y fuera de él.
   */
  public start(runImmediately = true): void {
    if (this.started) {
      return;
    }
    this.started = true;

    if (runImmediately) {
      void this.refreshAll();
    }

    this.scheduleNextRefresh();
  }

  /**
   * Detiene el planificador periódico.
   */
  public stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNextRefresh(): void {
    if (!this.started) return;
    const now = this.nowFn();
    const localClock = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.timezone,
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const parts = localClock.formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const weekday = values.weekday ?? 'Mon';
    const hour = Number(values.hour ?? 0);
    const minute = Number(values.minute ?? 0);
    const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
    const isOfficeHours = isWeekday && hour >= 7 && hour < 17;
    const intervalMs = isOfficeHours ? 20 * 60 * 1000 : 2 * 60 * 60 * 1000;
    let boundaryMs = Number.POSITIVE_INFINITY;
    for (let delta = 60_000; delta <= 48 * 60 * 60 * 1000; delta += 60_000) {
      const future = localClock.formatToParts(new Date(now.getTime() + delta));
      const f = Object.fromEntries(future.map((part) => [part.type, part.value]));
      const futureHour = Number(f.hour ?? 0);
      const futureMinute = Number(f.minute ?? 0);
      const futureWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(f.weekday ?? '');
      const futureOffice = futureWeekday && futureHour >= 7 && futureHour < 17;
      if (futureOffice !== isOfficeHours || (isOfficeHours && futureHour === 17 && futureMinute === 0)) {
        boundaryMs = delta;
        break;
      }
    }
    const delayMs = Math.min(intervalMs, boundaryMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refreshAll().finally(() => {
        this.scheduleNextRefresh();
      });
    }, delayMs);
  }

  private emitIfChanged(update: CacheUpdateResult, now: Date): StateChangeEvent | null {
    if (!update.statusChanged && !update.eventsChanged) {
      return null;
    }

    const changeEvent: StateChangeEvent = {
      calendarId: update.calendarId,
      statusChanged: update.statusChanged,
      eventsChanged: update.eventsChanged,
      status: update.status,
      events: update.events,
      timestamp: now.toISOString(),
    };

    this.emit('change', changeEvent);
    if (update.statusChanged) {
      this.emit('statusChange', changeEvent);
    }
    if (update.eventsChanged) {
      this.emit('eventsChange', changeEvent);
    }

    return changeEvent;
  }
}

