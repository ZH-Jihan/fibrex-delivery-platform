// Test helper: the URL of a fetch() call as a plain string, whatever form it was given in.
export function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}
