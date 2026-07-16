export function deliverToolOutput(args: {
  deliver: (output: never) => void;
  output: unknown;
  onFailure: (error: unknown) => void;
}): boolean {
  try {
    args.deliver(args.output as never);
    return true;
  } catch (error) {
    args.onFailure(error);
    return false;
  }
}
