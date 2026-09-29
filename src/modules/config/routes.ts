import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config.js';
import { chain } from '../../lib/chain.js';

const routes: FastifyPluginAsync = async (app) => {
  app.get('/config', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    return {
      chain: {
        id: chain.id,
        name: chain.name,
        explorerUrl: chain.explorerUrl,
        publicRpcUrl: chain.publicRpcUrl,
        nativeSymbol: 'ETH',
        isTestnet: chain.isTestnet,
      },
      features: { intents: true, sms: config.SMS_ENABLED },
      limits: {
        intentTtlDays: config.INTENT_TTL_DAYS,
        recentlyLinkedDays: config.RECENTLY_LINKED_DAYS,
        minSendUsd: config.MIN_SEND_USD,
      },
    };
  });
};

export default routes;
