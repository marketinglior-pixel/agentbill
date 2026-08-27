// Meta Pixel base code for marketing pages (home, register, pricing).
// Renders nothing until META_PIXEL_ID is set, so the site stays clean
// until the pixel exists in Business Manager. Conversion events
// (CompleteRegistration) fire from the register page's success handler.
export function pixelSnippet(): string {
  const id = process.env.META_PIXEL_ID
  if (!id || !/^\d{5,20}$/.test(id)) return ''
  return `<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window,document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${id}');
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none" alt=""
src="https://www.facebook.com/tr?id=${id}&ev=PageView&noscript=1"/></noscript>`
}
