export function countryToFlag(code = "") {
  const c = String(code).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "🏳️";
  // turn ISO-3166 alpha-2 into regional indicators
  return String.fromCodePoint(...[...c].map(ch => 0x1F1E6 + (ch.charCodeAt(0) - 65)));
}

// minimal list (extend as you like)
export const COUNTRIES = [
  { code: "TN", name: "Tunisia" },
  { code: "FR", name: "France" },
  { code: "DE", name: "Germany" },
  { code: "IT", name: "Italy" },
  { code: "ES", name: "Spain" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "MA", name: "Morocco" },
  { code: "DZ", name: "Algeria" },
  { code: "EG", name: "Egypt" },
];