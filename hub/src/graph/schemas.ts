import { z } from 'zod';

/** Valores posibles de disponibilidad en Microsoft Graph v1.0 (`freeBusyStatus`) */
export const showAsSchema = z.enum([
  'free',
  'tentative',
  'busy',
  'oof',
  'workingElsewhere',
  'unknown',
]);

export type ShowAsStatus = z.infer<typeof showAsSchema>;

/** Modelo interno de evento validado con Zod */
export const eventSchema = z.object({
  id: z.string().min(1),
  subject: z.string(),
  start: z.string().min(1),
  end: z.string().min(1),
  organizer: z.string().nullable(),
  isAllDay: z.boolean(),
  isCancelled: z.boolean().default(false),
  showAs: showAsSchema,
  location: z.string().nullable(),
});

export type Event = z.infer<typeof eventSchema>;
export type CalendarEvent = Event;

/** Modelo interno de calendario disponible */
export const calendarItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ownerAddress: z.string().optional(),
  mailbox: z.string().optional(),
});

export type CalendarItem = z.infer<typeof calendarItemSchema>;

/** Esquema de respuesta de un calendario individual en Microsoft Graph v1.0 */
export const graphCalendarResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullish(),
  owner: z
    .object({
      name: z.string().nullish(),
      address: z.string().nullish(),
    })
    .nullish(),
});

export type GraphCalendarResponse = z.infer<typeof graphCalendarResponseSchema>;

/** Esquema de respuesta de un evento individual en Microsoft Graph v1.0 (`calendarView`) */
export const graphEventResponseSchema = z.object({
  id: z.string().min(1),
  subject: z.string().nullish(),
  start: z.object({
    dateTime: z.string().min(1),
    timeZone: z.string().nullish(),
  }),
  end: z.object({
    dateTime: z.string().min(1),
    timeZone: z.string().nullish(),
  }),
  organizer: z
    .object({
      emailAddress: z
        .object({
          name: z.string().nullish(),
          address: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
  isAllDay: z.boolean().nullish(),
  isCancelled: z.boolean().nullish(),
  showAs: z.string().nullish(),
  location: z
    .object({
      displayName: z.string().nullish(),
    })
    .nullish(),
});

export type GraphEventResponse = z.infer<typeof graphEventResponseSchema>;

/** Esquema genérico para respuestas paginadas de Graph (`value` + `@odata.nextLink`) */
export function createGraphPageSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    value: z.array(itemSchema),
    '@odata.nextLink': z.string().url().optional(),
  });
}

function normalizeShowAs(rawShowAs: string | null | undefined): ShowAsStatus {
  const parsed = showAsSchema.safeParse(rawShowAs);
  return parsed.success ? parsed.data : 'unknown';
}

function normalizeGraphDateTime(dateTime: string, timeZone?: string | null): string {
  const trimmed = dateTime.trim();
  if (
    timeZone?.toUpperCase() === 'UTC' &&
    !trimmed.endsWith('Z') &&
    !/[+-]\d{2}:\d{2}$/.test(trimmed)
  ) {
    return `${trimmed}Z`;
  }
  return trimmed;
}

/**
 * Transforma un evento crudo de Microsoft Graph v1.0 al modelo interno `Event` y lo valida con Zod.
 */
export function mapGraphEvent(raw: unknown): Event {
  const graphEvent = graphEventResponseSchema.parse(raw);

  const organizerName = graphEvent.organizer?.emailAddress?.name?.trim();
  const organizerEmail = graphEvent.organizer?.emailAddress?.address?.trim();
  const organizer = organizerName || organizerEmail || null;

  const locationName = graphEvent.location?.displayName?.trim() || null;

  return eventSchema.parse({
    id: graphEvent.id,
    subject: graphEvent.subject?.trim() || 'Ocupado',
    start: normalizeGraphDateTime(graphEvent.start.dateTime, graphEvent.start.timeZone),
    end: normalizeGraphDateTime(graphEvent.end.dateTime, graphEvent.end.timeZone),
    organizer,
    isAllDay: Boolean(graphEvent.isAllDay),
    isCancelled: Boolean(graphEvent.isCancelled),
    showAs: normalizeShowAs(graphEvent.showAs),
    location: locationName,
  });
}

/**
 * Transforma un calendario crudo de Microsoft Graph v1.0 al modelo interno `CalendarItem`.
 */
export function mapGraphCalendar(raw: unknown, mailboxOverride?: string): CalendarItem {
  const graphCal = graphCalendarResponseSchema.parse(raw);
  const ownerAddress = graphCal.owner?.address?.trim() || mailboxOverride;
  const displayName =
    (mailboxOverride
      ? graphCal.owner?.name?.trim() || graphCal.name?.trim() || mailboxOverride
      : graphCal.name?.trim() || graphCal.owner?.name?.trim()) || 'Calendario';

  return calendarItemSchema.parse({
    id: mailboxOverride ?? graphCal.id,
    name: displayName,
    ownerAddress: ownerAddress || undefined,
    mailbox: mailboxOverride,
  });
}
