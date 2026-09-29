import {
  bigint,
  boolean,
  check,
  index,
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
const addressPattern = '^0x[0-9a-f]{40}$';

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
  check('users_address_format_check', sql`${table.address} ~ ${addressPattern}`),
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
  check('contacts_address_format_check', sql`${table.address} is null or ${table.address} ~ ${addressPattern}`),
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
  check('tokens_address_format_check', sql`${table.address} ~ ${addressPattern}`),
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
  check('transfers_sender_address_format_check', sql`${table.senderAddress} ~ ${addressPattern}`),
  check('transfers_recipient_address_format_check', sql`${table.recipientAddress} ~ ${addressPattern}`),
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
