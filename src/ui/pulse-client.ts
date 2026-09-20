// The browser half of /pulse, shared by every page that beacons to it.
//
// One definition, interpolated into each page's own inline script rather than
// emitted as a script of its own. A separate tag would be another CSP hash on
// the homepage, an ordering constraint between two tags and a global to reach
// across, for a dozen lines of JavaScript. Interpolation costs nothing at run
// time, and each host script's hash still covers it, because inlineScript()
// hashes the exact string it emits.
//
// It declares three names into whatever scope receives it, VIEW, SRC and
// pulse(), and nothing else. The playground receives it inside an IIFE and
// /register at the top level of its script; `var` and a function declaration
// are legal in both.
export const PULSE_CLIENT_SRC = `
  // A random token for THIS page view. Not a cookie, not localStorage, gone
  // when the tab closes. It exists so the rows can tell ten visitors acting
  // once from one visitor acting ten times, and it cannot follow anyone
  // between visits or between pages.
  var VIEW = (function(){
    try {
      var a = new Uint8Array(12);
      window.crypto.getRandomValues(a);
      var out = '';
      for (var i = 0; i < a.length; i++) out += (a[i] % 36).toString(36);
      return out;
    } catch (e) { return String(Date.now()) + String(Math.random()).slice(2, 8) }
  })();

  // The campaign label for THIS visit, read out of the page's own URL and
  // nothing else. Not the referrer, not the user agent: only a value we put
  // into a link we published ourselves. Absent, malformed or over-long means
  // no source, never a guess. The pattern is the one in lib/source.ts and the
  // handler applies it again server-side; this copy exists so a junk value
  // costs no request, not so the server can trust it.
  var SRC = (function(){
    try {
      var m = /[?&]src=([^&#]*)/.exec(window.location.search);
      if (!m) return null;
      var v = decodeURIComponent(m[1]).trim().toLowerCase();
      return /^[a-z0-9][a-z0-9_-]{0,23}$/.test(v) ? v : null;
    } catch (e) { return null }
  })();

  // Carry the label onto this page's own links to /register, so the two halves
  // of the funnel are counted under one name. They are two page views with two
  // view_ids and nothing joins them per visitor, by design; they join in
  // aggregate only if both rows carry the same label. Without this a directory
  // shows clicks and never a single /register load, and the drop-off reads as
  // the page when it is the instrument.
  //
  // Here and not in the route handlers because six links on the homepage come
  // from three shared components used by six routes: nav, the sticky bar, the
  // hero, the tier card, the closing action and the footer. One rewrite where
  // the beacon already lives covers all of them. If scripting is off nothing
  // is tagged, which is correct: no beacon fires either, so there is no half
  // measurement to misread.
  //
  // It runs BEFORE the cta_click listeners are attached (playground.ts reads
  // this string in, then selects), which is why that selector has to accept a
  // query string. An exact a[href="/register"] matches nothing here.
  (function(){
    try {
      if (!SRC) return;
      var links = document.querySelectorAll('a[href="/register"]');
      for (var li = 0; li < links.length; li++) {
        links[li].setAttribute('href', '/register?src=' + encodeURIComponent(SRC));
      }
    } catch (e) {}
  })();

  // One direction, never blocking, never throwing. The page does not care
  // whether this lands, so nothing here is awaited and nothing is retried.
  // sendBeacon first, because one of the events fires as the page is leaving:
  // a click on a link to /register navigates, and a fetch() still in flight
  // at unload is the browser's to drop.
  function pulse(event, ceiling){
    try {
      var payload = { event: event, view_id: VIEW };
      if (ceiling != null) payload.ceiling = ceiling;
      if (SRC) payload.source = SRC;
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/pulse', new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch('/pulse', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: body, keepalive: true }).catch(function(){});
    } catch (e) {}
  }
`
