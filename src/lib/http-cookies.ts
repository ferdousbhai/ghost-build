export function parseCookies(header: string) {
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((cookies, part) => {
      const separator = part.indexOf('=')

      if (separator === -1) {
        return cookies
      }

      cookies[part.slice(0, separator)] = decodeURIComponent(
        part.slice(separator + 1),
      )

      return cookies
    }, {})
}
