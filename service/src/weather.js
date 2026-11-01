// Real weather, because a language model cannot fetch anything by itself.
//
// An LLM maps text to text and has no network. "Looking something up" is always
// the surrounding program fetching and pasting the result into the prompt.
//
// LOCATION: GPS ONLY, and deliberately NO fallback.
//
// An IP-based fallback was built and then removed on purpose. The hub sits behind
// a VPN, so its public IP always resolves to one city no matter where the phone
// actually is - it would have answered confidently with the wrong location while
// travelling, which is precisely the confidently-wrong behaviour this system has
// been fighting. Guessing is worse than asking.
//
// When GPS is missing the tool returns an INSTRUCTION block telling the model to
// ask for the sensor to be switched on. The phone DOES send sensors when it has
// them (PanServerClient.askPanStream puts "sensors" when sensorJson != null), so
// "turn on GPS" is real, actionable advice rather than a deflection.
//
// HARD TIMEOUTS throughout: this runs inline on a voice turn, so a slow API must
// never hold up a reply. On any failure everything returns '' and the capability
// block makes PAN say plainly that it could not check.

const TIMEOUT_MS = 3000;

const WEATHER_RE =
  /\b(weather|forecast|temperature|degrees|rain|rains|raining|snow|snowing|sunny|cloudy|humid|humidity|wind|windy|hot|cold|warm|chilly|freezing|umbrella)\b/i;

const CODES = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail',
};
const describe = (c) => CODES[c] || 'unclear conditions';

export function looksLikeWeather(text) {
  return WEATHER_RE.test(String(text || ''));
}

// --- location ---------------------------------------------------------------

/** The phone's GPS, or null. No fallback, by design - see the header. */
export function resolveLocation(sensors) {
  const gps = sensors?.phone?.gps;
  if (typeof gps?.lat === 'number' && typeof gps?.lng === 'number') {
    return { lat: gps.lat, lon: gps.lng, label: gps.address || null, source: 'gps' };
  }
  return null;
}

/**
 * What to tell the model when a location-dependent tool has no coordinates.
 * An instruction, not an apology: the user can fix this in two seconds and
 * should be told exactly how.
 */
export function locationNeededBlock(what) {
  return `
LOCATION UNAVAILABLE: answering about ${what} needs the phone's GPS, ` +
    `and no location was sent with this turn.
` +
    `Tell the commander, in ONE short sentence, that you need his location sensor ` +
    `switched on to check it. Do not guess a city, do not give a forecast, and do ` +
    `not promise to check later.
`;
}

export async function buildWeatherBlock(text, sensors) {
  if (!looksLikeWeather(text)) return '';

  const loc = resolveLocation(sensors);
  if (!loc) return locationNeededBlock('the weather');

  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${loc.lat.toFixed(4)}&longitude=${loc.lon.toFixed(4)}` +
    '&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
    '&timezone=auto&forecast_days=3';

  try {
    const started = Date.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) { console.warn(`[weather] open-meteo HTTP ${res.status}`); return ''; }
    const j = await res.json();
    const c = j.current || {};
    const d = j.daily || {};
    const where = loc.label ? ` (${loc.label})` : '';

    const lines = [`\nLIVE WEATHER for ${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}${where} - real data, safe to state as fact:`];
    if (c.temperature_2m != null) {
      const feels = c.apparent_temperature != null && Math.abs(c.apparent_temperature - c.temperature_2m) >= 2
        ? `, feels like ${Math.round(c.apparent_temperature)}` : '';
      lines.push(`- Now: ${Math.round(c.temperature_2m)}C${feels}, ${describe(c.weather_code)}` +
        (c.wind_speed_10m != null ? `, wind ${Math.round(c.wind_speed_10m)} km/h` : ''));
    }
    const days = (d.time || []).slice(0, 3);
    const labels = ['Today', 'Tomorrow', 'Day after'];
    days.forEach((day, i) => {
      const hi = d.temperature_2m_max?.[i];
      const lo = d.temperature_2m_min?.[i];
      const pop = d.precipitation_probability_max?.[i];
      if (hi == null) return;
      lines.push(`- ${labels[i] || day}: ${Math.round(lo)} to ${Math.round(hi)}C, ` +
        `${describe(d.weather_code?.[i])}` + (pop != null ? `, ${pop}% chance of precipitation` : ''));
    });
    lines.push(`(fetched in ${Date.now() - started}ms)`);
    return lines.join('\n') + '\n';
  } catch (e) {
    console.warn(`[weather] lookup failed: ${e.message}`);
    return '';
  }
}
