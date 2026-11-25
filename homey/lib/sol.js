'use strict';

/**
 * Sola: hvor den står, og hvor mye den varmer en fasade mot øst, sør og vest.
 *
 * Brukes som forklaringsvariabler i rommodellen. Rommet lærer selv hvor mye hver retning
 * betyr, så himmelretningen til vinduene trenger ingen å oppgi. Tallene er relative
 * (0–1), ikke W/m².
 */

const RAD = Math.PI / 180;

/** Solas høyde og asimut (grader; asimut 0 = nord, 90 = øst, 180 = sør). */
function solposisjon(ms, lat, lon) {
  const d = ms / 86400000 - 10957.5;                       // dager siden J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dek = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const timevinkel = ((gmst * 15 + lon) * RAD) - ra;
  const b = lat * RAD;
  const hoyde = Math.asin(Math.sin(b) * Math.sin(dek) + Math.cos(b) * Math.cos(dek) * Math.cos(timevinkel));
  const asimut = Math.atan2(-Math.sin(timevinkel), Math.tan(dek) * Math.cos(b) - Math.sin(b) * Math.cos(timevinkel));
  return { hoyde: hoyde / RAD, asimut: ((asimut / RAD) + 360) % 360 };
}

/**
 * Solinnstråling mot loddrette flater mot øst, sør og vest (0–1), dempet av skydekket.
 * @param {number|null} sky skydekke i prosent; null regnes som halvskyet
 */
function solmot(ms, lat, lon, sky = null) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ost: 0, sor: 0, vest: 0 };
  const { hoyde, asimut } = solposisjon(ms, lat, lon);
  if (hoyde <= 0) return { ost: 0, sor: 0, vest: 0 };
  const h = hoyde * RAD;
  // Lav sol går gjennom mye luft: svekkes mot horisonten.
  const klar = Math.min(1, Math.sin(h) ** 0.3) * (hoyde < 3 ? hoyde / 3 : 1);
  const dekke = Math.min(1, Math.max(0, (sky ?? 50) / 100));
  const direkte = klar * (1 - 0.85 * dekke ** 2);
  const diffus = 0.08 * klar * (0.4 + 0.6 * dekke);
  const mot = (retning) => Math.round((direkte * Math.cos(h) * Math.max(0, Math.cos((asimut - retning) * RAD)) + diffus) * 1000) / 1000;
  return { ost: mot(90), sor: mot(180), vest: mot(270) };
}

module.exports = { solposisjon, solmot };
