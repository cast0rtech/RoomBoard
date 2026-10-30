import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Compara dos cadenas en tiempo constante mediante el digest SHA-256 de ambas
 * para evitar fugas de información por longitud o tiempo de comparación.
 */
export function constantTimeCompare(input: string, expected: string): boolean {
  const inputHash = createHash('sha256').update(input, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(inputHash, expectedHash);
}

/**
 * Verifica en tiempo constante si `providedKey` coincide con alguna de las claves de `allowedKeys`.
 * Recorre todas las claves configuradas sin cortocircuitar.
 */
export function isValidDeviceKey(
  providedKey: string | undefined,
  allowedKeys: readonly string[],
): boolean {
  if (!providedKey || allowedKeys.length === 0) {
    return false;
  }

  let matched = false;
  for (const allowed of allowedKeys) {
    if (constantTimeCompare(providedKey, allowed)) {
      matched = true;
    }
  }
  return matched;
}

export function parseDeviceKeys(rawDeviceKeys: string): string[] {
  return rawDeviceKeys
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

/**
 * Comprueba si un encabezado `Origin` pertenece a localhost o red privada local (RFC 1918).
 */
export function isAllowedLocalOrigin(origin: string | undefined): boolean {
  if (!origin) {
    // Peticiones de clientes nativos (Flutter Windows / Android) no suelen enviar Origin
    return true;
  }

  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();

    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return true;
    }
    if (host.startsWith('192.168.') || host.startsWith('10.')) {
      return true;
    }
    const match172 = /^172\.(\d{1,3})\./.exec(host);
    if (match172) {
      const secondOctet = Number(match172[1]);
      if (secondOctet >= 16 && secondOctet <= 31) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
}

interface RateBucket {
  count: number;
  resetAtMs: number;
}

/**
 * Limitador de tasa básico en memoria por IP / clave de dispositivo.
 */
export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequests = options.maxRequests ?? 120;
  }

  public consume(clientKey: string, nowMs = Date.now()): {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
  } {
    const existing = this.buckets.get(clientKey);
    if (!existing || nowMs >= existing.resetAtMs) {
      const bucket: RateBucket = {
        count: 1,
        resetAtMs: nowMs + this.windowMs,
      };
      this.buckets.set(clientKey, bucket);
      return {
        allowed: true,
        remaining: Math.max(0, this.maxRequests - 1),
        retryAfterSeconds: 0,
      };
    }

    existing.count += 1;
    if (existing.count > this.maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((existing.resetAtMs - nowMs) / 1000),
      );
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds,
      };
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - existing.count),
      retryAfterSeconds: 0,
    };
  }
}

/**
 * Extrae la clave de dispositivo de la cabecera `X-Device-Key`.
 */
export function extractDeviceKeyHeader(request: FastifyRequest): string | undefined {
  const header = request.headers['x-device-key'];
  if (Array.isArray(header)) {
    return header[0]?.trim();
  }
  return header?.trim();
}

/**
 * Aplica cabeceras CORS restringidas a orígenes de red local.
 */
export function applyLocalCors(request: FastifyRequest, reply: FastifyReply): boolean {
  const origin = request.headers.origin;
  if (!isAllowedLocalOrigin(origin)) {
    return false;
  }

  if (origin) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
  }
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Device-Key');
  return true;
}
