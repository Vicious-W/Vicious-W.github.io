import * as THREE from "three";

/**
 * The aircraft's own lights, shared by the cockpit (which draws them and lights the cabin) and
 * the mist around the aircraft (which they light). Cabin frame (m): the eye at the origin, -z
 * ahead, +y up. The beacons flash red; the wing tips shine steadily, red to the left, green
 * to the right.
 */
export const WING = { rootY: 1.22, tipY: 1.5, span: 6.2, leading: 0.95, rootChord: 1.5, tipChord: 0.95 };
export const BEACONS = [[0, 2.1, 4.6], [0, -1.25, 1.9]];
export const NAV = [[-WING.span, WING.tipY, WING.leading + 0.05], [WING.span, WING.tipY, WING.leading + 0.05]];
export const BEACON_COLOR = [1.0, 0.045, 0.03];
export const NAV_COLORS = [[1.0, 0.05, 0.035], [0.05, 1.0, 0.3]];
export const BEACON_PERIOD = 1.3;
// Intensities (scene units, per steradian): a beacon at the peak of its flash, a wing-tip light.
export const BEACON_POWER = 1.2;
export const NAV_POWER = 0.5;

/** The beacons' flash at time t (s): a sharp rise, a short tail. 0..1. */
export function beaconPulse(t) {
  const phase = ((t % BEACON_PERIOD) + BEACON_PERIOD) % BEACON_PERIOD;
  return phase < 0.012 ? phase / 0.012 : Math.exp(-(phase - 0.012) / 0.06);
}

const tmp = new THREE.Vector3();

/**
 * The lamps in the world around the camera: positions relative to the eye in world axes (m),
 * and intensities (rgb). qAircraft: attitude of the airframe. Writes into out (4 lamps).
 */
export function lampsInWorld(qAircraft, t, out) {
  const pulse = beaconPulse(t);
  const all = [
    [BEACONS[0], BEACON_COLOR, BEACON_POWER * pulse],
    [BEACONS[1], BEACON_COLOR, BEACON_POWER * pulse],
    [NAV[0], NAV_COLORS[0], NAV_POWER],
    [NAV[1], NAV_COLORS[1], NAV_POWER]
  ];
  all.forEach(([p, c, k], i) => {
    out.pos[i].copy(tmp.set(p[0], p[1], p[2]).applyQuaternion(qAircraft));
    out.light[i].set(c[0] * k, c[1] * k, c[2] * k);
  });
  return out;
}
