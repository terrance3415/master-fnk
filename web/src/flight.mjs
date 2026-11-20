export const FLIGHT_MS = 800;
export const LAND_AT_MS = 560;

export function flightSrc(theme, reduced, elapsedMs) {
  if (reduced || elapsedMs >= LAND_AT_MS) return theme.fig;
  return theme.fly;
}
