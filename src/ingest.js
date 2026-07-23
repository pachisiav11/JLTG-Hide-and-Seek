// Phase 11 (§C2): format a coordinate pair for the clipboard, so a seeker can
// copy their own GPS and paste it into whatever chat the group uses. 5dp =
// ~1.1 m — precise enough for a Hide & Seek question, tight enough that the
// pasted number doesn't look like noise.
export function formatLocationForClipboard(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
