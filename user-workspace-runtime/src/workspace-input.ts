const DEPLOYMENT_MIGRATION_NAME = /^\d{4}_[a-zA-Z0-9._-]+\.sql$/;

export function requireWorkspaceFileEncoding(value: unknown): 'utf8' | 'base64' {
  if (value === undefined || value === 'utf8') {
    return 'utf8';
  }
  if (value === 'base64') {
    return value;
  }
  throw new SyntaxError('Invalid workspace file encoding.');
}

export function requireDeploymentMigrationName(value: string): string {
  if (!DEPLOYMENT_MIGRATION_NAME.test(value)) {
    throw new Error(`Deployment migration has an invalid filename: ${value}`);
  }
  return value;
}
