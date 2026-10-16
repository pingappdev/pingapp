import { sql } from "../../src/db/client.js";
import { redis } from "../../src/lib/redis.js";
import { sendEscrowInvite } from "../../src/modules/escrows/events.js";

const escrowId = process.env.PINGAPP_SMS_RESTART_ESCROW_ID;
if (!escrowId) throw new Error("Missing disposable escrow id.");

let providerCalls = 0;
try {
  await sendEscrowInvite(escrowId, async () => {
    providerCalls += 1;
    return { providerMsgId: "fresh-process-fake", priceEur: null };
  });
  process.stdout.write(`SMS_RESTART_PROVIDER_CALLS=${providerCalls}\n`);
} finally {
  await redis.quit();
  await sql.end();
}
