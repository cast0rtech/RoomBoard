export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigurationError';
  }
}

export class AuthTokenError extends Error {
  public override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AuthTokenError';
    this.cause = cause;
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ejecuta una operación asíncrona con reintentos exponenciales ante fallos transitorios.
 * No reintenta errores de configuración (`AuthConfigurationError`).
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 300);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AuthConfigurationError) {
        throw error;
      }

      lastError = error;

      if (attempt < maxAttempts) {
        options.onRetry?.(attempt, error);
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
        await sleep(delayMs);
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new AuthTokenError(
    `Fallo al obtener el token de acceso tras ${maxAttempts} intento(s): ${detail}`,
    lastError,
  );
}

