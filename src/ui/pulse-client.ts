// The browser half of /pulse, shared by every page that beacons to it.
//
// One definition, interpolated into each page's own inline script rather than
// emitted as a script of its own. A separate tag would be another CSP hash on
// the homepage, an ordering constraint between two tags and a global to reach
// across, for a dozen lines of JavaScript. Interpolation costs nothing at run
// time, and each host script's hash still covers it, because inlineScript()
// hashes the exact string it emits.
//
// It declares two names into whatever scope receives it, VIEW and pulse(), and
// nothing else. The playground receives it inside an IIFE and /register at the
// top level of its script; `var` and a function declaration are legal in both.
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

  // One direction, never blocking, never throwing. The page does not care
  // whether this lands, so nothing here is awaited and nothing is retried.
  // sendBeacon first, because one of the events fires as the page is leaving:
  // a click on a link to /register navigates, and a fetch() still in flight
  // at unload is the browser's to drop.
  function pulse(event, ceiling){
    try {
      var payload = { event: event, view_id: VIEW };
      if (ceiling != null) payload.ceiling = ceiling;
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
