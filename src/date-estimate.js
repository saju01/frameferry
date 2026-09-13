'use strict';
// Explicit estimate policy for incremental jobs only. Raw archive dateParsed semantics are unchanged.
function estimateDate(raw, observedAt, timeZone='UTC') {
  if (typeof observedAt !== 'string' || !/(Z|[+-][0-9]{2}:[0-9]{2})$/.test(observedAt)) throw new Error('timezone-bearing observation timestamp required');
  const observed=new Date(observedAt);
  if(!Number.isFinite(observed.getTime()))throw new Error('invalid observation timestamp');
  const AMS_FMT=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
  const FUTURE_SKEW_MS=86400000;
  const MON = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
};


  function amsterdamDay(d) {
  const parts = AMS_FMT.formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const y = get('year'), mo = get('month'), day = get('day');
  if (!y || !mo || !day) throw new Error('Intl returned no year/month/day parts');
  return `${y}-${mo}-${day}`;
}

  function parseDate(raw, NOW = new Date()) {
  if (raw === undefined || raw === null) return { error: 'card has no date field' };
  const s = String(raw).trim();
  if (!s) return { error: 'card date is empty' };

  // Every branch funnels through here: an out-of-range offset ("999999999999999
  // days ago") yields an Invalid Date whose comparisons are ALL false, so it
  // would be silently dropped and reported as a healthy "nothing new".
  // `basis` and the [lo, hi] window travel with the instant, because the point
  // estimate alone cannot say how much it is worth.
  const finite = (d, why, basis, lo, hi) => {
    if (!(d instanceof Date) || !Number.isFinite(d.getTime())) {
      return { error: `date "${s}" does not resolve to a real instant (${why})` };
    }
    if (d.getTime() > NOW.getTime() + FUTURE_SKEW_MS) {
      // A future date would become the newest date_iso, drag the watermark
      // past every real post, and exclude the whole handle from then on.
      return { error: `date "${s}" resolves to the future (${d.toISOString()})` };
    }
    const low = lo === undefined ? d : lo;
    const high = hi === undefined ? d : hi;
    if (!Number.isFinite(low.getTime()) || !Number.isFinite(high.getTime())) {
      return { error: `date "${s}" has an unusable uncertainty window (${why})` };
    }
    let dayLo, dayHi, day;
    try {
      dayLo = amsterdamDay(low);
      dayHi = amsterdamDay(high);
      day = amsterdamDay(d);
    } catch (e) {
      return { error: `date "${s}" has no resolvable Amsterdam day (${e && e.message})` };
    }
    return { date: d, basis, raw: s, day, dayLo, dayHi };
  };

  // RELATIVE LABELS ARE ROUNDED, SO THEY NAME A WINDOW, NOT AN INSTANT.
  // "3 days ago" was rendered for anything between 3 and 4 days before the page
  // was read, so the honest window is [NOW-(N+1)u, NOW-Nu]. The point estimate is
  // kept as `date_iso` for continuity, but it is an estimate and the basis says so.
  const rel = (n, unit, why) => {
    const point = new Date(NOW.getTime() - n * unit);
    return finite(point, why, 'relative',
                  new Date(NOW.getTime() - (n + 1) * unit),
                  new Date(NOW.getTime() - n * unit));
  };

  let m;
  if ((m = s.match(/^(\d+)\s+minutes?\s+ago$/i))) return rel(Number(m[1]), 60e3, 'relative minutes out of range');
  if ((m = s.match(/^(\d+)\s+hours?\s+ago$/i))) return rel(Number(m[1]), 3600e3, 'relative hours out of range');
  if ((m = s.match(/^(\d+)\s+days?\s+ago$/i))) return rel(Number(m[1]), 86400e3, 'relative days out of range');
  if (/^yesterday$/i.test(s)) return rel(1, 86400e3, 'yesterday');
  if (/^today$/i.test(s)) {
    return finite(new Date(NOW.getTime()), 'today', 'relative',
                  new Date(NOW.getTime() - 86400e3), NOW);
  }

  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?$/))) {
    const mo = MON[m[2].toLowerCase()];
    if (mo === undefined) return { error: `unknown month name in date "${s}"` };
    const day = Number(m[1]);
    const explicitYear = m[3] ? Number(m[3]) : null;
    const year = explicitYear === null ? NOW.getUTCFullYear() : explicitYear;
    const build = (y) => {
      const d = new Date(Date.UTC(y, mo, day));
      // Date.UTC rolls 31 February over into March instead of rejecting it.
      if (!Number.isFinite(d.getTime())) return null;
      if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo || d.getUTCDate() !== day) return null;
      return d;
    };
    let d = build(year);
    if (d === null) return { error: `impossible calendar date "${s}"` };
    if (explicitYear === null && d.getTime() > NOW.getTime()) {
      // No year given and the date is in the future: InstaCognito means last
      // year. This is the NORMAL rendering for older posts -- and it is exactly
      // why a yearless label is not proof: the year is chosen by this rule, not
      // read from the source.
      const rolled = build(year - 1);
      if (rolled === null) return { error: `impossible calendar date "${s}" for the previous year` };
      d = rolled;
    }
    // A yearless label pins the day-of-month but not the year, so its window is
    // the inferred day PLUS the same day a year earlier: those are the two
    // readings the rollover rule chooses between. The uploader does not treat
    // either as authority; the window only keeps the card from being dropped.
    if (explicitYear === null) {
      const alt = build(year - 1) || d;
      const lo = new Date(Math.min(d.getTime(), alt.getTime()));
      const hi = new Date(Math.max(d.getTime(), alt.getTime()));
      return finite(d, 'absolute date without a year', 'absolute_noyear', lo, hi);
    }
    return finite(d, 'absolute date with an explicit year', 'absolute_year');
  }

  return { error: `unparseable date "${s}"` };
}


  const result=parseDate(raw,observed);
  if(result.error)throw new Error(result.error);
  return {raw:result.raw,iso:result.date.toISOString(),day:result.day,dayLo:result.dayLo,dayHi:result.dayHi,basis:result.basis,precision:result.basis==='absolute_year'?'day':'estimated',observedAt,timeZone};
}
module.exports={estimateDate};
