/**
 * URL-safe slug from an organization name.
 * Collision handling (suffix) is done by the caller.
 */
export function slugifyOrganizationName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return base || "organization";
}
