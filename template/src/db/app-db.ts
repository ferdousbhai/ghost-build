import { createCollection } from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./query-client";

export type AppDecision = {
  id: string;
  title: string;
  detail: string;
  createdAt: number;
};

export const decisionsCollection = createCollection(
  queryCollectionOptions<AppDecision>({
    id: "decisions",
    queryClient,
    queryKey: ["decisions"],
    queryFn: fetchDecisions,
    getKey: (decision) => decision.id,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 2,
    onInsert: async ({ transaction }) => {
      await Promise.all(
        transaction.mutations.map(async (mutation) => {
          const response = await fetch("/api/decisions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(mutation.modified),
          });

          if (!response.ok) {
            throw new Error(await readErrorMessage(response));
          }
        }),
      );
    },
  }),
);

export async function addDecision(detail: string) {
  const cleanDetail = detail.trim();
  if (!cleanDetail) {
    return;
  }

  const decision: AppDecision = {
    id: crypto.randomUUID(),
    title: "Decision",
    detail: cleanDetail,
    createdAt: Date.now(),
  };
  const tx = decisionsCollection.insert(decision, {
    metadata: { source: "template-ui" },
  });
  await tx.isPersisted.promise;
  return decision;
}

async function fetchDecisions() {
  const response = await fetch("/api/decisions");
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as AppDecision[];
}

async function readErrorMessage(response: Response) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || "Request failed.";
  } catch {
    return "Request failed.";
  }
}
