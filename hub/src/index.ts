import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type HubConfig } from './config.js';
import { registerRoutes, type RouteDependencies } from './routes/index.js';

export async function buildServer(
  config: HubConfig = loadConfig(),
  deps: RouteDependencies = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  });

  await registerRoutes(app, config, deps);

  return app;
}

async function start(): Promise<void> {
  const config = loadConfig();
  const app = Fastify({ logger: true });
  const { scheduler } = await registerRoutes(app, config);

  app.addHook('onClose', async () => {
    scheduler.stop();
  });

  try {
    scheduler.start(true);
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info(`RoomBoard Hub escuchando en el puerto ${config.PORT}`);
  } catch (error) {
    scheduler.stop();
    app.log.error(error, 'Error al iniciar RoomBoard Hub');
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void start();
}
