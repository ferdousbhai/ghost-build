type EnvKey = keyof Env & string;

export function getOptionalBinding(env: Env, name: EnvKey): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
