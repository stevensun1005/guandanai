/** Validate the original io48 window or an explicitly recorded owner extension. */
export function validateWindow(window) {
  const start = Date.parse(window.startedAt),
    end = Date.parse(window.plannedEnd);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isFinite(window.hours) ||
    Math.abs(end - start - window.hours * 3600000) > 1 ||
    Date.parse(window.midpointAt) !== start + 24 * 3600000 ||
    window.seedIndex !== 5100
  )
    throw Error('Invalid training window');
  if (window.extension) {
    const x = window.extension;
    if (
      Date.parse(x.originalPlannedEnd) !== start + 48 * 3600000 ||
      end <= Date.parse(x.originalPlannedEnd) ||
      !Number.isFinite(Date.parse(x.authorizedAt)) ||
      x.authority !== 'owner-request'
    )
      throw Error('Invalid authorized extension');
  } else if (window.hours !== 48) throw Error('Missing owner extension record');
  return { start, end };
}
