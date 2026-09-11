type ClassValue = string | number | null | undefined | false;

/** Small class-name joiner — avoids pulling in a dependency for something
 * this simple. Falsy values are dropped. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
