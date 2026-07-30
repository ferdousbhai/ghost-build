import { useEffect, useState } from 'react';
import type {
  BrowserCollectionCoordinator,
  BrowserWASQLiteDatabase,
  PersistedCollectionPersistence,
  persistedCollectionOptions,
} from '@tanstack/browser-db-sqlite-persistence';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';

const logger = createScopedLogger('AccountLocalReplica');

export const ACCOUNT_LOCAL_REPLICA_SCHEMA_VERSION = 1;

export type AccountLocalReplica = {
  persistence: PersistedCollectionPersistence;
  persistedCollectionOptions: typeof persistedCollectionOptions;
};

type OpenAccountLocalReplica = AccountLocalReplica & {
  coordinator: BrowserCollectionCoordinator;
  database: BrowserWASQLiteDatabase;
};

const pendingReplicas = new Map<string, Promise<OpenAccountLocalReplica | null>>();
const resolvedReplicas = new Map<string, OpenAccountLocalReplica | null>();

export function useAccountLocalReplica(sessionId: string | null | undefined): AccountLocalReplica | null | undefined {
  const [replica, setReplica] = useState<OpenAccountLocalReplica | null | undefined>(() =>
    sessionId ? resolvedReplicas.get(sessionId) : undefined,
  );

  useEffect(() => {
    let active = true;
    if (!sessionId) {
      setReplica(undefined);
      return () => {
        active = false;
      };
    }

    const resolved = resolvedReplicas.get(sessionId);
    if (resolved !== undefined || resolvedReplicas.has(sessionId)) {
      setReplica(resolved ?? null);
      return () => {
        active = false;
      };
    }

    setReplica(undefined);
    void openAccountLocalReplica(sessionId).then((value) => {
      if (active) {
        setReplica(value);
      }
    });
    return () => {
      active = false;
    };
  }, [sessionId]);

  return replica;
}

async function openAccountLocalReplica(sessionId: string): Promise<OpenAccountLocalReplica | null> {
  const existing = pendingReplicas.get(sessionId);
  if (existing) {
    return existing;
  }

  const pending = createAccountLocalReplica(sessionId)
    .catch((error) => {
      logger.warn('Local project persistence is unavailable; continuing with server-backed collections.', error);
      return null;
    })
    .then((replica) => {
      resolvedReplicas.set(sessionId, replica);
      return replica;
    });
  pendingReplicas.set(sessionId, pending);
  return pending;
}

async function createAccountLocalReplica(sessionId: string): Promise<OpenAccountLocalReplica> {
  if (typeof window === 'undefined' || !globalThis.crypto?.subtle) {
    throw new Error('Browser persistence prerequisites are unavailable.');
  }

  const accountKey = await hashAccountKey(sessionId);
  const databaseBaseName = `ghostbuild-account-${accountKey}`;
  const {
    BrowserCollectionCoordinator,
    createBrowserWASQLitePersistence,
    openBrowserWASQLiteOPFSDatabase,
    persistedCollectionOptions,
  } = await import('@tanstack/browser-db-sqlite-persistence');
  const database = await openBrowserWASQLiteOPFSDatabase({
    databaseName: `${databaseBaseName}.sqlite`,
  });
  const coordinator = new BrowserCollectionCoordinator({
    dbName: databaseBaseName,
  });

  try {
    const persistence = createBrowserWASQLitePersistence({
      database,
      coordinator,
    });
    return {
      coordinator,
      database,
      persistence,
      persistedCollectionOptions,
    };
  } catch (error) {
    coordinator.dispose();
    await database.close?.();
    throw error;
  }
}

async function hashAccountKey(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ghostbuild-local:${sessionId}`));
  return Array.from(new Uint8Array(digest).subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
