import { EventEmitter } from 'node:events';
import type { CalendarEvent, GraphClient } from '../graph/index.js';
import {
  CalendarEventsCache,
  computeSevenDayWindow,
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
 * Planificador periódico que sincroniza calendarios y eventos (ventana de hoy + 7 días)
 * cada `POLL_SECONDS` y emite un evento `'change'` cuando cambia el estado libre/ocupada o las citas.
 */
export class StateScheduler extends EventEmitter {
  private readonly graphClient: GraphClient;
  private readonly cache: CalendarEventsCache;
  private readonly pollIntervalMs: number;
  private readonly timezone: string;
  private readonly nowFn: () => Date;
  private readonly logger: SchedulerLogger;
  private timer: NodeJS.Timeout | null = null;
  private isRefreshing = false;

  constructor(options: StateSchedulerOptions) {
    super();
    this.graphClient = options.graphClient;
    this.cache = options.cache;
    this.pollIntervalMs = Math.max(1, options.pollSeconds) * 1000;
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
      const calendars = await this.graphClient.listCalendars();
      this.cache.setCalendars(calendars);

      const window = computeSevenDayWindow(now, this.timezone);

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
    const window = computeSevenDayWindow(now, this.timezone);
    const events = await this.graphClient.listEvents(calendarId, window.from, window.to);
    const update = this.cache.setEvents(calendarId, events, now, window);
    this.emitIfChanged(update, now);
    return update;
  }

  /**
   * Inicia la ejecución periódica cada `POLL_SECONDS`.
   */
  public start(runImmediately = true): void {
    if (this.timer) {
      return;
    }

    if (runImmediately) {
      void this.refreshAll();
    }

    this.timer = setInterval(() => {
      void this.refreshAll();
    }, this.pollIntervalMs);
  }

  /**
   * Detiene el planificador periódico.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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

