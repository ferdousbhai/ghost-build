import { WorkspaceCommandTerminationIndeterminateError } from './command-termination';

/** Wait for cancellation cleanup, ignoring the command's expected rejection after termination is confirmed. */
export async function settleCancelledWorkspaceCommand(args: {
  termination?: Promise<unknown>;
  settlement?: Promise<unknown>;
}): Promise<void> {
  const [termination, settlement] = await Promise.all([
    args.termination ? reflect(args.termination) : undefined,
    args.settlement ? reflect(args.settlement) : undefined,
  ]);
  if (termination?.status === 'rejected') {
    throw termination.reason;
  }
  if (
    !args.termination &&
    settlement?.status === 'rejected' &&
    settlement.reason instanceof WorkspaceCommandTerminationIndeterminateError
  ) {
    throw settlement.reason;
  }
  // Once exact termination was confirmed, rejection of the original result promise is expected.
}

function reflect<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
}
