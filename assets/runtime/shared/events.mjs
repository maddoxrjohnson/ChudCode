/** Subscribe to the server's event stream with typed handlers. */

export function connectEvents(url, handlers, { onOpen, onError } = {}) {
  const source = new EventSource(url);
  for (const [type, handler] of Object.entries(handlers)) {
    source.addEventListener(type, (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      handler(payload);
    });
  }
  if (onOpen) source.addEventListener("open", onOpen);
  if (onError) source.addEventListener("error", onError);
  return {
    close() {
      source.close();
    },
  };
}
