type ContainerSnapshotSource = {
  snapshotUrl: string;
  trustedTemplateDependencies: boolean;
};

export function resolveContainerSnapshotSource(
  storedSnapshotUrl: string | null | undefined,
  templateUrl: string,
): ContainerSnapshotSource {
  if (storedSnapshotUrl) {
    return {
      snapshotUrl: storedSnapshotUrl,
      trustedTemplateDependencies: false,
    };
  }

  return {
    snapshotUrl: templateUrl,
    trustedTemplateDependencies: true,
  };
}
