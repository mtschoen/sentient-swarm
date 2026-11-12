// Promise.all that reports each promise's resolution as it happens: onProgress(completed, total).
export function trackEach(promises, onProgress) {
  const total = promises.length;
  let completed = 0;
  return Promise.all(promises.map((promise) => promise.then((value) => {
    completed += 1;
    onProgress?.(completed, total);
    return value;
  })));
}
