/**
 * Which telemetry default applies to a reader, from the country Cloudflare
 * resolves for the request (decision 0008). EU and EEA ePrivacy rules need
 * opt-in consent for analytics; the UK's statistical exception and US law
 * allow opt-out with notice. Unknown countries get the stricter default.
 *
 * The country is read and dropped: it is never stored, logged, or sent on.
 * `telemetryRelay.ts` serves the answer.
 */

export type TelemetryConsent = 'opt_in' | 'opt_out'

/** EU member states, EEA states, and Switzerland (kept strict pending counsel). */
const OPT_IN_COUNTRIES = new Set(
  // EU 27, then the EEA's Iceland, Liechtenstein and Norway, then Switzerland.
  (
    'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE ' +
    'IS LI NO CH'
  ).split(' '),
)

export function consentForCountry(country: string | null | undefined): TelemetryConsent {
  const code = country?.trim().toUpperCase()
  // Cloudflare sends XX for unknown and T1 for Tor; neither says where the reader is.
  if (!code || !/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') return 'opt_in'
  return OPT_IN_COUNTRIES.has(code) ? 'opt_in' : 'opt_out'
}
