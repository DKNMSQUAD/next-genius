// Open-tracking pixel for NGSP counsellor emails.
// Returns a real 1x1 transparent GIF (so Gmail's image proxy is happy) and
// reports the open back to the Apps Script, which records it in the nom_sends /
// nominations sheets. Apps Script can't serve image bytes itself, so the pixel
// lives here on the site.
const SHEET_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbwVxIhz6N-vUNVhpTJOw2rFOfO8ZZOcsbL9JOj7-Ha2eWY7YEFlB6R-Ptg9PNC7NmT-xQ/exec';

// 1x1 transparent GIF
const GIF_BYTES = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (c) => c.charCodeAt(0)
);

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  const k = url.searchParams.get('k') || 'nom';

  if (id) {
    const logUrl = SHEET_WEBHOOK_URL + '?nom_open=1&id=' + encodeURIComponent(id) + '&k=' + encodeURIComponent(k);
    // fire-and-forget; never let logging delay or break the pixel response
    context.waitUntil(fetch(logUrl).catch(() => {}));
  }

  return new Response(GIF_BYTES, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}
