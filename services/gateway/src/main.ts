import { buildGateway } from './app';
import { loadEnv } from './env';

async function main() {
  const env = loadEnv();
  const app = await buildGateway(env);
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info({ port: env.PORT, host: env.HOST, rateLimitPerMin: env.RATE_LIMIT_PER_MIN }, `${env.SERVICE_NAME} listening`);

  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const deadline = setTimeout(() => {
      app.log.error('shutdown timed out; exiting');
      process.exit(1);
    }, 10_000);
    deadline.unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
