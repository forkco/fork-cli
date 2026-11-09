// Stop waiting without leaking listeners; the caller also passes the signal
// into the underlying I/O so cancellation stops work as well as the waiter.
export function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const cleanup = () => signal.removeEventListener('abort', abort);
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, {once: true});
  });
}
