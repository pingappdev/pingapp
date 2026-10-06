import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { cardWebhookEvents } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import { hash, parseProviderJson, sanitizeEvent, verifyWebhook } from '../cards/domain.js';
import { providerScope, unavailable } from '../cards/settings.js';

const routes: FastifyPluginAsync = async (app) => {
  // Encapsulated parser applies only to this autoloaded module, preserving browser JSON parsing.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 64 * 1024 }, (_request, body, done) => done(null, body));
  app.post('/webhooks/izipay', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!config.IZIPAY_WEBHOOK_SECRET) throw unavailable();
    const body = request.body;
    if (!Buffer.isBuffer(body) || !verifyWebhook(config.IZIPAY_WEBHOOK_SECRET, body, request.headers['x-izipay-signature'])) throw errors.unauthenticated();
    let event: ReturnType<typeof sanitizeEvent>;
    try { event = sanitizeEvent(parseProviderJson(body.toString('utf8'))); } catch { throw errors.validation('Invalid card event.'); }
    const payloadHash = hash(body);
    const [inserted] = await db.insert(cardWebhookEvents).values({ providerScope, providerEventId: event.eventId, eventType: event.type,
      eventAt: event.eventAt ? new Date(event.eventAt) : null, payloadHash, payload: event.payload,
    }).onConflictDoNothing({ target: [cardWebhookEvents.providerScope, cardWebhookEvents.providerEventId] }).returning({ id: cardWebhookEvents.id });
    if (!inserted) {
      const [previous] = await db.select({ hash: cardWebhookEvents.payloadHash }).from(cardWebhookEvents).where(and(eq(cardWebhookEvents.providerScope, providerScope), eq(cardWebhookEvents.providerEventId, event.eventId)));
      if (!previous || previous.hash !== payloadHash) throw errors.conflict('This card event ID already has a different payload.');
    }
    // The worker scans this durable inbox; Redis enqueue is not an acknowledgment condition.
    return { received: true };
  });
};
export default routes;
