import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const booleanStringSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const rawEnvSchema = z.object({
  AUTH_MODE: z.enum(['delegated', 'app']).default('delegated'),
  TENANT_ID: z.string().min(1).default('common'),
  CLIENT_ID: z.string().min(1).default('unconfigured-client-id'),
  CLIENT_SECRET: z.string().optional(),
  ROOM_MAILBOXES: z.string().optional().default(''),
  TIMEZONE: z.string().min(1).default('Europe/Madrid'),
  PORT: z.coerce.number().int().positive().default(8080),
  DEVICE_KEYS: z.string().min(1).default('dev-device-key'),
  POLL_SECONDS: z.coerce.number().int().positive().default(45),
  IGNORE_ALL_DAY: booleanStringSchema.optional(),
  IGNORE_ALL_DAY_EVENTS: booleanStringSchema.optional(),
});

export interface HubConfig {
  AUTH_MODE: 'delegated' | 'app';
  TENANT_ID: string;
  CLIENT_ID: string;
  CLIENT_SECRET?: string;
  ROOM_MAILBOXES: string;
  TIMEZONE: string;
  PORT: number;
  DEVICE_KEYS: string;
  POLL_SECONDS: number;
  IGNORE_ALL_DAY: boolean;
  IGNORE_ALL_DAY_EVENTS: boolean;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): HubConfig {
  const parsed = rawEnvSchema.parse(rawEnv);
  const ignoreAllDay = parsed.IGNORE_ALL_DAY ?? parsed.IGNORE_ALL_DAY_EVENTS ?? true;

  return {
    AUTH_MODE: parsed.AUTH_MODE,
    TENANT_ID: parsed.TENANT_ID,
    CLIENT_ID: parsed.CLIENT_ID,
    CLIENT_SECRET: parsed.CLIENT_SECRET,
    ROOM_MAILBOXES: parsed.ROOM_MAILBOXES,
    TIMEZONE: parsed.TIMEZONE,
    PORT: parsed.PORT,
    DEVICE_KEYS: parsed.DEVICE_KEYS,
    POLL_SECONDS: parsed.POLL_SECONDS,
    IGNORE_ALL_DAY: ignoreAllDay,
    IGNORE_ALL_DAY_EVENTS: ignoreAllDay,
  };
}
