// Text matching for list search boxes. Firestore has no text search, so lists
// filter the documents they have loaded.

/** Lowercase without accents, so "helene" finds "Hélène". */
export function foldForSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** Whether any value contains the query; a blank query matches everything. */
export function matchesSearch(
  values: readonly (string | null | undefined)[],
  query: string,
): boolean {
  const needle = foldForSearch(query.trim());
  if (!needle) return true;
  return values.some((value) => foldForSearch(value ?? "").includes(needle));
}
