import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

export const isDatabaseConfigured = (
  env: NodeJS.ProcessEnv = process.env
): boolean => {
  if (typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.trim().length > 0) {
    return true;
  }
  return Boolean(
    env.SQL_HOST &&
    env.SQL_USER &&
    env.SQL_PASSWORD &&
    env.SQL_DB_NAME
  );
};

export const createPool = () => {
  if (!global._postgresPool) {
    const isCloudDb =
      Boolean(process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') && !process.env.DATABASE_URL.includes('127.0.0.1'));

    const poolConfig = process.env.DATABASE_URL
      ? {
          connectionString: process.env.DATABASE_URL,
          max: 3,
          idleTimeoutMillis: 10000,
          connectionTimeoutMillis: 10000,
          ssl: isCloudDb ? { rejectUnauthorized: false } : undefined,
        }
      : {
          host: process.env.SQL_HOST,
          user: process.env.SQL_USER,
          password: process.env.SQL_PASSWORD,
          database: process.env.SQL_DB_NAME,
          max: 5,
          idleTimeoutMillis: 10000,
          connectionTimeoutMillis: 10000,
          ssl: process.env.SQL_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
        };

    global._postgresPool = new Pool(poolConfig);

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err?.message || err);
    });
  }
  return global._postgresPool;
};

export const pool = createPool();

export const db = drizzle(pool, { schema });
export * from './schema.ts';
