import {
  bigint,
  boolean,
  check,
  index,
  foreignKey,
  unique,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const id = () => uuid('id').defaultRandom().primaryKey();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: id(),
  address: text('address').notNull().unique(),
  displayName: text('display_name').notNull().default(''),
  phoneHmac: text('phone_hmac').unique(),
  phoneEnc: text('phone_enc'),
  phoneCountry: text('phone_country'),
  phoneMasked: text('phone_masked'),
  phoneLinkedAt: timestamp('phone_linked_at', { withTimezone: true }),
  createdAt: createdAt(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
}, (table) => [
  check('users_address_format_check', sql`${table.address} ~ '^0x[0-9a-f]{40}$'`),
  check('users_display_name_length_check', sql`char_length(${table.displayName}) <= 40`),
  check('users_phone_country_format_check', sql`${table.phoneCountry} is null or ${table.phoneCountry} ~ '^[A-Z]{2}$'`),
]);

export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  freshUntil: timestamp('fresh_until', { withTimezone: true }),
  userAgent: text('user_agent'),
  ipHash: text('ip_hash'),
}, (table) => [
  index('sessions_user_id_idx').on(table.userId),
]);

export const phoneClaims = pgTable('phone_claims', {
  id: id(),
  phoneHmac: text('phone_hmac').notNull(),
  phoneEnc: text('phone_enc').notNull(),
  phoneMasked: text('phone_masked').notNull(),
  claimantUserId: uuid('claimant_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('pending_review'),
  note: text('note'),
  createdAt: createdAt(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (table) => [
  check('phone_claims_status_check', sql`${table.status} in ('pending_review', 'approved', 'rejected', 'cancelled')`),
  uniqueIndex('phone_claims_pending_unique_idx')
    .on(table.phoneHmac, table.claimantUserId)
    .where(sql`${table.status} = 'pending_review'`),
  index('phone_claims_phone_hmac_idx').on(table.phoneHmac),
]);

export const contacts = pgTable('contacts', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  phoneHmac: text('phone_hmac'),
  phoneEnc: text('phone_enc'),
  phoneMasked: text('phone_masked'),
  address: text('address'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('contacts_name_length_check', sql`char_length(${table.name}) between 1 and 80`),
  check('contacts_phone_or_address_check', sql`${table.phoneHmac} is not null or ${table.address} is not null`),
  check('contacts_address_format_check', sql`${table.address} is null or ${table.address} ~ '^0x[0-9a-f]{40}$'`),
  uniqueIndex('contacts_user_phone_hmac_unique_idx')
    .on(table.userId, table.phoneHmac)
    .where(sql`${table.phoneHmac} is not null`),
  uniqueIndex('contacts_user_address_unique_idx')
    .on(table.userId, table.address)
    .where(sql`${table.address} is not null`),
  index('contacts_user_id_idx').on(table.userId),
]);

export const tokens = pgTable('tokens', {
  address: text('address').primaryKey(),
  chainId: integer('chain_id').notNull(),
  symbol: text('symbol').notNull(),
  name: text('name').notNull(),
  decimals: integer('decimals').notNull(),
  kind: text('kind').notNull(),
  logoUrl: text('logo_url'),
  multiplier: numeric('multiplier', { precision: 38, scale: 18, mode: 'string' }).notNull().default('1'),
  rhAssetId: text('rh_asset_id'),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(1000),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('tokens_address_format_check', sql`${table.address} ~ '^0x[0-9a-f]{40}$'`),
  check('tokens_kind_check', sql`${table.kind} in ('native', 'stable', 'wrapped', 'stock')`),
]);

export const transfers = pgTable('transfers', {
  id: id(),
  senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
  senderAddress: text('sender_address').notNull(),
  recipientAddress: text('recipient_address').notNull(),
  recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'set null' }),
  recipientPhoneHmac: text('recipient_phone_hmac'),
  recipientPhoneMasked: text('recipient_phone_masked'),
  tokenAddress: text('token_address').notNull().references(() => tokens.address),
  amountRaw: numeric('amount_raw', { precision: 78, scale: 0, mode: 'string' }).notNull(),
  txHash: text('tx_hash').notNull().unique(),
  status: text('status').notNull().default('submitted'),
  blockNumber: bigint('block_number', { mode: 'bigint' }),
  intentId: uuid('intent_id'),
  contactName: text('contact_name'),
  createdAt: createdAt(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
}, (table) => [
  check('transfers_sender_address_format_check', sql`${table.senderAddress} ~ '^0x[0-9a-f]{40}$'`),
  check('transfers_recipient_address_format_check', sql`${table.recipientAddress} ~ '^0x[0-9a-f]{40}$'`),
  check('transfers_status_check', sql`${table.status} in ('submitted', 'confirmed', 'failed', 'unverified', 'not_found')`),
  index('transfers_sender_created_at_idx').on(table.senderUserId, table.createdAt.desc()),
  index('transfers_recipient_created_at_idx').on(table.recipientUserId, table.createdAt.desc()),
  index('transfers_status_idx').on(table.status),
  index('transfers_intent_id_idx').on(table.intentId),
]);

export const intents = pgTable('intents', {
  id: id(),
  code: text('code').notNull().unique(),
  senderUserId: uuid('sender_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  recipientPhoneHmac: text('recipient_phone_hmac').notNull(),
  recipientPhoneEnc: text('recipient_phone_enc').notNull(),
  recipientPhoneMasked: text('recipient_phone_masked').notNull(),
  recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'set null' }),
  tokenAddress: text('token_address').notNull().references(() => tokens.address),
  amountRaw: numeric('amount_raw', { precision: 78, scale: 0, mode: 'string' }).notNull(),
  note: text('note'),
  status: text('status').notNull().default('pending'),
  smsStatus: text('sms_status').notNull(),
  transferId: uuid('transfer_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [
  check('intents_code_format_check', sql`${table.code} ~ '^[A-Za-z0-9]{10}$'`),
  check('intents_note_length_check', sql`${table.note} is null or char_length(${table.note}) <= 140`),
  check('intents_status_check', sql`${table.status} in ('pending', 'ready', 'completed', 'cancelled', 'expired')`),
  check('intents_sms_status_check', sql`${table.smsStatus} in ('sent', 'skipped_rate_limit', 'failed', 'disabled')`),
  index('intents_recipient_phone_status_idx').on(table.recipientPhoneHmac, table.status),
  index('intents_sender_created_at_idx').on(table.senderUserId, table.createdAt.desc()),
  index('intents_status_expires_at_idx').on(table.status, table.expiresAt),
]);

export const notifications = pgTable('notifications', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [
  check('notifications_type_check', sql`${table.type} in ('intent_ready', 'intent_expired', 'intent_incoming', 'transfer_received', 'transfer_failed', 'phone_claim_attempt', 'phone_claim_resolved', 'phone_removed_by_review')`),
  index('notifications_user_created_at_idx').on(table.userId, table.createdAt.desc()),
]);

export const smsLog = pgTable('sms_log', {
  id: id(),
  purpose: text('purpose').notNull(),
  phoneHmac: text('phone_hmac').notNull(),
  country: text('country'),
  providerMsgId: text('provider_msg_id'),
  success: boolean('success').notNull(),
  error: text('error'),
  priceEur: numeric('price_eur', { precision: 10, scale: 4, mode: 'string' }),
  createdAt: createdAt(),
}, (table) => [
  check('sms_log_purpose_check', sql`${table.purpose} in ('otp', 'intent', 'admin_test')`),
  check('sms_log_country_format_check', sql`${table.country} is null or ${table.country} ~ '^[A-Z]{2}$'`),
  index('sms_log_created_at_idx').on(table.createdAt),
  index('sms_log_phone_created_at_idx').on(table.phoneHmac, table.createdAt),
]);

export const auditEvents = pgTable('audit_events', {
  id: id(),
  userId: uuid('user_id'),
  type: text('type').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  ipHash: text('ip_hash'),
  createdAt: createdAt(),
}, (table) => [
  index('audit_events_user_created_at_idx').on(table.userId, table.createdAt),
]);

export const kv = pgTable('kv', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type PhoneClaim = typeof phoneClaims.$inferSelect;
export type NewPhoneClaim = typeof phoneClaims.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Token = typeof tokens.$inferSelect;
export type NewToken = typeof tokens.$inferInsert;
export type Transfer = typeof transfers.$inferSelect;
export type NewTransfer = typeof transfers.$inferInsert;
export type Intent = typeof intents.$inferSelect;
export type NewIntent = typeof intents.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type SmsLogEntry = typeof smsLog.$inferSelect;
export type NewSmsLogEntry = typeof smsLog.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type KeyValue = typeof kv.$inferSelect;
export type NewKeyValue = typeof kv.$inferInsert;

// Card financial history survives account deletion; only the optional profile cascades.
const cardMoney = (name: string) => numeric(name, { precision: 38, scale: 18, mode: 'string' });
const cardTime = (name: string) => timestamp(name, { withTimezone: true });
export const cardProfiles = pgTable('card_profiles', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  emailEnc: text('email_enc').notNull(),
  createdAt: createdAt(),
  updatedAt: cardTime('updated_at').notNull().defaultNow(),
});

export const cards = pgTable('cards', {
  id: id(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  providerScope: text('provider_scope').notNull(),
  providerCardId: text('provider_card_id'),
  clientCardRef: uuid('client_card_ref').notNull(),
  product: text('product').notNull(),
  currency: text('currency').notNull().default('USD'),
  issueStatus: text('issue_status').notNull().default('created'),
  providerIssueStatus: text('provider_issue_status'),
  last4: text('last4'),
  isFrozen: boolean('is_frozen'),
  balanceUsd: cardMoney('balance_usd'),
  pendingTopupUsd: cardMoney('pending_topup_usd'),
  balanceSource: text('balance_source'),
  balanceAsOf: cardTime('balance_as_of'),
  issuedAt: cardTime('issued_at'),
  nextSyncAt: cardTime('next_sync_at').notNull().defaultNow(),
  syncLeaseUntil: cardTime('sync_lease_until'),
  syncToken: uuid('sync_token'),
  historySyncedAt: cardTime('history_synced_at'),
  createdAt: createdAt(),
  updatedAt: cardTime('updated_at').notNull().defaultNow(),
}, (t) => [
  unique('cards_owner_scope_unique').on(t.id, t.userId, t.providerScope),
  unique('cards_id_scope_unique').on(t.id, t.providerScope),
  uniqueIndex('cards_provider_id_unique').on(t.providerScope, t.providerCardId),
  uniqueIndex('cards_client_ref_unique').on(t.providerScope, t.clientCardRef),
  uniqueIndex('cards_active_slot_unique').on(t.userId, t.providerScope, t.product)
    .where(sql`${t.issueStatus} <> 'failed'`),
  index('cards_owner_scope_idx').on(t.userId, t.providerScope),
  index('cards_next_sync_idx').on(t.nextSyncAt),
  check('cards_currency_check', sql`${t.currency} = 'USD'`),
  check('cards_product_check', sql`${t.product} = 'visa'`),
  check('cards_last4_check', sql`${t.last4} is null or ${t.last4} ~ '^[0-9]{4}$'`),
]);

export const cardOperations = pgTable('card_operations', {
  id: id(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  cardId: uuid('card_id').notNull(),
  providerScope: text('provider_scope').notNull(),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('created'),
  requestId: uuid('request_id').notNull(),
  providerIdempotencyKey: uuid('provider_idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  requestEnc: text('request_enc').notNull(),
  providerPaymentId: text('provider_payment_id'),
  providerTopupId: text('provider_topup_id'),
  amountUsd: cardMoney('amount_usd'),
  amountOnCardUsd: cardMoney('amount_on_card_usd'),
  network: text('network').notNull(),
  payCurrency: text('pay_currency').notNull(),
  invoiceUrl: text('invoice_url'),
  invoiceAddress: text('invoice_address'),
  invoiceAmount: cardMoney('invoice_amount'),
  invoiceExpiresAt: cardTime('invoice_expires_at'),
  leaseUntil: cardTime('lease_until'),
  leaseToken: uuid('lease_token'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: cardTime('next_attempt_at').notNull().defaultNow(),
  submittedAt: cardTime('submitted_at'),
  error: text('error'),
  createdAt: createdAt(),
  updatedAt: cardTime('updated_at').notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.cardId, t.userId, t.providerScope], foreignColumns: [cards.id, cards.userId, cards.providerScope], name: 'card_operations_owner_fk' }),
  foreignKey({ columns: [t.cardId, t.providerScope], foreignColumns: [cards.id, cards.providerScope], name: 'card_operations_card_fk' }),
  uniqueIndex('card_operations_request_unique').on(t.userId, t.kind, t.requestId),
  uniqueIndex('card_operations_provider_key_unique').on(t.providerScope, t.providerIdempotencyKey),
  uniqueIndex('card_operations_payment_unique').on(t.providerScope, t.providerPaymentId),
  uniqueIndex('card_operations_topup_unique').on(t.providerScope, t.providerTopupId),
  uniqueIndex('card_operations_open_unique').on(t.cardId).where(sql`${t.status} not in ('completed', 'failed')`),
  index('card_operations_owner_created_idx').on(t.userId, t.createdAt.desc()),
  index('card_operations_status_attempt_idx').on(t.status, t.nextAttemptAt),
  check('card_operations_kind_check', sql`${t.kind} in ('issue', 'topup')`),
  check('card_operations_status_check', sql`${t.status} in ('created', 'submitting', 'awaiting_payment', 'processing', 'completed', 'failed', 'expired', 'review')`),
  check('card_operations_network_check', sql`(${t.network}, ${t.payCurrency}) in (('tron', 'usdttrc20'), ('bsc', 'usdtbsc'), ('ethereum', 'usdterc20'), ('polygon', 'usdtpoly'))`),
]);

export const cardTransactions = pgTable('card_transactions', {
  id: id(),
  cardId: uuid('card_id').notNull(),
  providerScope: text('provider_scope').notNull(),
  providerTransactionId: text('provider_transaction_id').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull(),
  amount: cardMoney('amount').notNull(),
  currency: text('currency').notNull(),
  billedUsd: cardMoney('billed_usd'),
  merchant: text('merchant'),
  direction: text('direction').notNull(),
  occurredAt: cardTime('occurred_at').notNull(),
  sourceUpdatedAt: cardTime('source_updated_at'),
  isFinal: boolean('is_final').notNull().default(false),
  syncedAt: cardTime('synced_at').notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.cardId, t.providerScope], foreignColumns: [cards.id, cards.providerScope], name: 'card_transactions_card_fk' }),
  uniqueIndex('card_transactions_provider_unique').on(t.providerScope, t.cardId, t.providerTransactionId),
  index('card_transactions_card_occurred_idx').on(t.cardId, t.occurredAt.desc(), t.id),
  check('card_transactions_direction_check', sql`${t.direction} in ('debit', 'credit')`),
]);

export const cardWebhookEvents = pgTable('card_webhook_events', {
  id: id(),
  providerScope: text('provider_scope').notNull(),
  providerEventId: text('provider_event_id').notNull(),
  eventType: text('event_type').notNull(),
  eventAt: cardTime('event_at'),
  payloadHash: text('payload_hash').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  cardId: uuid('card_id').references(() => cards.id),
  operationId: uuid('operation_id').references(() => cardOperations.id),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: cardTime('next_attempt_at').notNull().defaultNow(),
  lastError: text('last_error'),
  receivedAt: cardTime('received_at').notNull().defaultNow(),
  processedAt: cardTime('processed_at'),
}, (t) => [
  uniqueIndex('card_webhook_events_provider_unique').on(t.providerScope, t.providerEventId),
  index('card_webhook_events_pending_idx').on(t.status, t.nextAttemptAt),
]);

export type Card = typeof cards.$inferSelect;
export type CardOperation = typeof cardOperations.$inferSelect;
export type CardTransaction = typeof cardTransactions.$inferSelect;
