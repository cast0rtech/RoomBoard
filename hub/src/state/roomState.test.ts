import { describe, expect, it, vi } from 'vitest';
import type { CalendarEvent, GraphClient } from '../graph/index.js';
import {
  CalendarEventsCache,
  computeRoomStatus,
  computeSevenDayWindow,
  StateScheduler,
  type StateChangeEvent,
} from './index.js';

function createEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    subject: 'Reunión de equipo',
    organizer: 'Ana Pérez',
    start: '2026-10-30T10:00:00.000Z',
    end: '2026-10-30T11:00:00.000Z',
    isAllDay: false,
    isCancelled: false,
    showAs: 'busy',
    location: 'Sala Norte',
    ...overrides,
  };
}

describe('computeRoomStatus — lógica de estado libre/ocupada', () => {
  it('1. Sala libre: sin citas o solo con citas futuras informa next y until', () => {
    const now = new Date('2026-10-30T09:00:00.000Z');
    expect(computeRoomStatus([], now)).toEqual({
      state: 'free',
      current: null,
      next: null,
      until: null,
    });

    const futureEvent = createEvent({
      id: 'evt-future',
      start: '2026-10-30T10:00:00.000Z',
      end: '2026-10-30T11:00:00.000Z',
    });

    const statusWithNext = computeRoomStatus([futureEvent], now);
    expect(statusWithNext).toEqual({
      state: 'free',
      current: null,
      next: futureEvent,
      until: '2026-10-30T10:00:00.000Z',
    });
  });

  it('2. Sala ocupada: cuando start < now < end devuelve state=busy, current, next y until', () => {
    const now = new Date('2026-10-30T10:30:00.000Z');
    const currentEvent = createEvent({
      id: 'evt-current',
      start: '2026-10-30T10:00:00.000Z',
      end: '2026-10-30T11:00:00.000Z',
    });
    const nextEvent = createEvent({
      id: 'evt-next',
      start: '2026-10-30T12:00:00.000Z',
      end: '2026-10-30T13:00:00.000Z',
    });

    const status = computeRoomStatus([nextEvent, currentEvent], now);
    expect(status.state).toBe('busy');
    expect(status.current?.id).toBe('evt-current');
    expect(status.next?.id).toBe('evt-next');
    expect(status.until).toBe('2026-10-30T11:00:00.000Z');
  });

  it('3. Límites exactos: ocupada justo al empezar (start === now) y libre justo al terminar (now === end)', () => {
    const event = createEvent({
      id: 'evt-boundary',
      start: '2026-10-30T10:00:00.000Z',
      end: '2026-10-30T11:00:00.000Z',
    });

    const atStart = computeRoomStatus([event], new Date('2026-10-30T10:00:00.000Z'));
    expect(atStart.state).toBe('busy');
    expect(atStart.current?.id).toBe('evt-boundary');
    expect(atStart.until).toBe('2026-10-30T11:00:00.000Z');

    const atEnd = computeRoomStatus([event], new Date('2026-10-30T11:00:00.000Z'));
    expect(atEnd.state).toBe('free');
    expect(atEnd.current).toBeNull();
    expect(atEnd.until).toBeNull();
  });

  it('4. Citas solapadas: prioriza la que empezó antes y extiende until al final más tardío de las activas', () => {
    const eventA = createEvent({
      id: 'evt-a',
      subject: 'Primera reunión',
      start: '2026-10-30T10:00:00.000Z',
      end: '2026-10-30T11:00:00.000Z',
    });
    const eventB = createEvent({
      id: 'evt-b',
      subject: 'Reunión solapada más larga',
      start: '2026-10-30T10:30:00.000Z',
      end: '2026-10-30T11:30:00.000Z',
    });

    // A las 10:15 solo A está activa y B figura como next
    const at1015 = computeRoomStatus(
      [eventB, eventA],
      new Date('2026-10-30T10:15:00.000Z'),
    );
    expect(at1015.state).toBe('busy');
    expect(at1015.current?.id).toBe('evt-a');
    expect(at1015.next?.id).toBe('evt-b');
    expect(at1015.until).toBe('2026-10-30T11:00:00.000Z');

    // A las 10:45 ambas están activas; current sigue siendo A y until se extiende hasta el fin de B
    const at1045 = computeRoomStatus(
      [eventB, eventA],
      new Date('2026-10-30T10:45:00.000Z'),
    );
    expect(at1045.state).toBe('busy');
    expect(at1045.current?.id).toBe('evt-a');
    expect(at1045.until).toBe('2026-10-30T11:30:00.000Z');
  });

  it('5. Citas canceladas y con showAs="free" se ignoran siempre', () => {
    const now = new Date('2026-10-30T10:30:00.000Z');
    const cancelled = createEvent({ id: 'evt-cancelled', isCancelled: true });
    const showAsFree = createEvent({ id: 'evt-free', showAs: 'free' });

    const status = computeRoomStatus([cancelled, showAsFree], now);
    expect(status.state).toBe('free');
    expect(status.current).toBeNull();
    expect(status.next).toBeNull();
  });

  it('6. Eventos de día completo se ignoran con ignoreAllDay=true y cuentan con ignoreAllDay=false', () => {
    const now = new Date('2026-10-30T10:30:00.000Z');
    const allDay = createEvent({
      id: 'evt-allday',
      subject: 'Festivo local',
      start: '2026-10-30T00:00:00.000Z',
      end: '2026-10-31T00:00:00.000Z',
      isAllDay: true,
    });

    const ignoredStatus = computeRoomStatus([allDay], now, { ignoreAllDay: true });
    expect(ignoredStatus.state).toBe('free');

    const includedStatus = computeRoomStatus([allDay], now, { ignoreAllDay: false });
    expect(includedStatus.state).toBe('busy');
    expect(includedStatus.current?.id).toBe('evt-allday');
  });

  it('7. Cambio de zona horaria y transición de horario de verano a invierno (DST)', () => {
    // Evento devuelto por Graph en hora local de Europe/Madrid (invierno: UTC+1)
    const localMadridEvent = createEvent({
      id: 'evt-madrid',
      start: '2026-10-30T10:00:00',
      end: '2026-10-30T11:00:00',
    });

    // 09:30 UTC son las 10:30 en Europe/Madrid (UTC+1), por tanto la sala está ocupada
    const nowUtc = new Date('2026-10-30T09:30:00.000Z');
    const madridStatus = computeRoomStatus([localMadridEvent], nowUtc, {
      timezone: 'Europe/Madrid',
    });
    expect(madridStatus.state).toBe('busy');
    expect(madridStatus.current?.id).toBe('evt-madrid');

    // En America/New_York (UTC-4 en esa fecha), las 09:30 UTC son las 05:30 locales -> aún libre
    const nyStatus = computeRoomStatus([localMadridEvent], nowUtc, {
      timezone: 'America/New_York',
    });
    expect(nyStatus.state).toBe('free');
    expect(nyStatus.next?.id).toBe('evt-madrid');

    // Cambio de hora en Europa (25 de octubre de 2026): cita con offset de verano (+02:00) y de invierno (+01:00)
    const dstEvent = createEvent({
      id: 'evt-dst',
      start: '2026-10-25T01:30:00+02:00', // 2026-10-24T23:30:00Z
      end: '2026-10-25T02:30:00+01:00', // 2026-10-25T01:30:00Z
    });
    const duringDstTransition = new Date('2026-10-25T00:15:00.000Z');
    const dstStatus = computeRoomStatus([dstEvent], duringDstTransition, {
      timezone: 'Europe/Madrid',
    });
    expect(dstStatus.state).toBe('busy');
  });
});

describe('CalendarEventsCache y StateScheduler', () => {
  it('calcula una ventana de hoy y los próximos 7 días y emite evento interno solo cuando hay cambios', async () => {
    const fixedNow = new Date('2026-10-30T10:15:00.000Z');
    const window = computeSevenDayWindow(fixedNow, 'Europe/Madrid');
    const windowDays =
      (Date.parse(window.to) - Date.parse(window.from)) / (1000 * 60 * 60 * 24);
    expect(windowDays).toBeGreaterThanOrEqual(7);
    expect(windowDays).toBeLessThanOrEqual(8.1);

    let graphEvents: CalendarEvent[] = [
      createEvent({
        id: 'evt-1',
        start: '2026-10-30T10:00:00.000Z',
        end: '2026-10-30T11:00:00.000Z',
      }),
    ];

    const fakeGraphClient: GraphClient = {
      listCalendars: vi.fn().mockResolvedValue([
        { id: 'sala-1', name: 'Sala 1' },
      ]),
      listEvents: vi.fn(async () => graphEvents),
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

    const emittedChanges: StateChangeEvent[] = [];
    scheduler.on('change', (change: StateChangeEvent) => {
      emittedChanges.push(change);
    });

    // Primer refresco: detecta cambio inicial y emite evento
    await scheduler.refreshAll(fixedNow);
    expect(emittedChanges).toHaveLength(1);
    expect(emittedChanges[0]?.status.state).toBe('busy');
    expect(cache.getStatus('sala-1').state).toBe('busy');

    // Segundo refresco con los mismos datos y misma hora: no emite evento duplicado
    await scheduler.refreshAll(fixedNow);
    expect(emittedChanges).toHaveLength(1);

    // Tercer refresco cuando la cita ya ha terminado (11:05): el estado pasa a 'free' y emite cambio
    const afterEndNow = new Date('2026-10-30T11:05:00.000Z');
    graphEvents = [...graphEvents];
    await scheduler.refreshAll(afterEndNow);
    expect(emittedChanges).toHaveLength(2);
    expect(emittedChanges[1]?.status.state).toBe('free');
    expect(emittedChanges[1]?.statusChanged).toBe(true);
  });
});
