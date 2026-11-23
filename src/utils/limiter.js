/**
 * Limitador de concurrencia mínimo (semáforo FIFO).
 * Protege la RAM del servidor limitando las conversiones simultáneas.
 */
export function createLimiter(max) {
  if (!Number.isInteger(max) || max < 1) throw new Error('max debe ser un entero >= 1');

  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };

  const run = (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });

  return Object.assign(run, {
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
  });
}
