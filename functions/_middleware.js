// Redirect the bare apex (next-genius.com) to the canonical www host.
// www and all other hosts pass through to the static assets unchanged.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === "next-genius.com") {
    return Response.redirect("https://www.next-genius.com" + url.pathname + url.search, 301);
  }
  return context.next();
}
