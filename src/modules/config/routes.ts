import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config.js';
import { chain } from '../../lib/chain.js';
import { getEscrowFee } from '../../lib/router.js';

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
      features: { intents: !config.ROUTER_ENABLED, escrow: config.ROUTER_ENABLED, sms: config.SMS_ENABLED },
      router: { enabled: config.ROUTER_ENABLED, address: config.ROUTER_ADDRESS,
        escrowFeeWei: config.ROUTER_ENABLED ? (await getEscrowFee()).toString() : '0',
        claimTipWei: config.ESCROW_CLAIM_TIP_WEI },
      limits: {
        intentTtlDays: config.INTENT_TTL_DAYS,
        recentlyLinkedDays: config.RECENTLY_LINKED_DAYS,
        minSendUsd: config.MIN_SEND_USD,
      },
    };
  });
};

export default routes;
