import fastifyFactory from 'fastify';
import fastifyHelmet from 'fastify-helmet';
import fastifyCors from 'fastify-cors';
import fastifyRateLimit from 'fastify-rate-limit';

// @ts-ignore
import fastifyCompress from 'fastify-compress';

import authPlugin from './auth';
import routes from './routes';
// TODO uncomment this
//import transactionsMonitorCron  from './plugins/tx-monitor';

const fastify = fastifyFactory({
  logger: true,
});

fastify.register(fastifyHelmet, {
  hidePoweredBy: true,
});

fastify.register(fastifyRateLimit, {
  max: 40,
  timeWindow: '1 minute'
})

fastify.register(fastifyCors, {});
fastify.register(fastifyCompress, {});

fastify.register(authPlugin);
fastify.register(routes);
// TODO uncomment this
//fastify.register(transactionsMonitorCron);

const start = async () => {
  try {
    await fastify.listen(process.env.PORT ? parseInt(process.env.PORT) : 8080, '0.0.0.0');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
