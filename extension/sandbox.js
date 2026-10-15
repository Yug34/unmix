/* The only place in the extension allowed to run new Function.
 *
 * YouTube.js extracts a slice of the YouTube player and asks us to evaluate it.
 * Manifest V3 forbids that on extension pages. This sandboxed page has no
 * extension APIs and no access to the user's library; it returns {sig, n}. */

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || !event.source) return;
  if (data.type === 'ping') {
    event.source.postMessage({ type: 'pong' }, '*');
    return;
  }
  if (data.type !== 'eval') return;
  try {
    const result = (new Function(data.output))();
    event.source.postMessage({ type: 'eval-result', id: data.id, result }, '*');
  } catch (err) {
    event.source.postMessage({
      type: 'eval-result', id: data.id, error: String(err && err.message || err),
    }, '*');
  }
});
