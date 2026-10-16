import postgres from 'postgres';

const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
if (databaseUrl.hostname !== '127.0.0.1' || databaseUrl.pathname !== '/pingapp_audit_monitor'
  || databaseUrl.username !== 'pingapp') {
  console.error('Refusing to create the monitor test role outside the disposable CI database.');
  process.exit(2);
}

const sql = postgres(databaseUrl.toString(), { max: 1, prepare: false });
try {
  await sql.unsafe(
    "CREATE ROLE pingapp_watch_ci LOGIN PASSWORD 'ci-monitor-readonly' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
  );
  await sql.unsafe('GRANT CONNECT ON DATABASE pingapp_audit_monitor TO pingapp_watch_ci');
  await sql.unsafe('GRANT USAGE ON SCHEMA public TO pingapp_watch_ci');
  await sql.unsafe('GRANT SELECT ON ALL TABLES IN SCHEMA public TO pingapp_watch_ci');
  await sql.unsafe(
    'ALTER DEFAULT PRIVILEGES FOR ROLE pingapp IN SCHEMA public GRANT SELECT ON TABLES TO pingapp_watch_ci',
  );
} finally {
  await sql.end({ timeout: 5 });
}

console.log('Created the disposable monitor database SELECT-only role.');
