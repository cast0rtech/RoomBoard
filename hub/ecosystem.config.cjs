/**
 * Configuración de PM2 para ejecutar RoomBoard Hub como servicio en segundo plano en Windows.
 * Para arrancar:
 *   pm2 start ecosystem.config.cjs
 * Para configurar arranque automático en Windows:
 *   npm install -g pm2-windows-startup
 *   pm2-startup install
 *   pm2 save
 */
module.exports = {
  apps: [
    {
      name: 'roomboard-hub',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
      // Logs y rotación
      output: './logs/hub-out.log',
      error: './logs/hub-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      max_size: '10M',
      retain: '7',
      compress: true,
    },
  ],
};
