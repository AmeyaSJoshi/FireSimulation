export function isSimulationSettled({ activeCount = 0, pendingCount = 0, stepCount = 0 } = {}) {
  return stepCount > 10 && activeCount === 0 && pendingCount === 0;
}

export function shouldAutoRotate({ fireRunning = false } = {}) {
  return !fireRunning;
}
