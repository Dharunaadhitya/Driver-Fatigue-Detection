/**
 * DrowsyGuard Fleet — Driver Trip & Fatigue Risk Score Calculation
 *
 * Formula:
 * A normalized 0–100 integer score calculated from weighted safety indicators:
 *   - Microsleeps (weight x4): Critical loss of alertness (15 pts per event, max 45)
 *   - Danger events (weight x2): Heavy PERCLOS / prolonged eye closure (7 pts per event, max 30)
 *   - Warnings (weight x1): Moderate PERCLOS / drowsiness markers (2 pts per event, max 15)
 *   - Average PERCLOS: Baseline physiological closure over trip (>0.12 adds up to 25 pts)
 *   - Excessive Yawns: Marker of increasing fatigue (>2 yawns adds 3 pts each, max 15)
 *   - Extended Duration (>4 hours): Shift fatigue multiplier (+5 pts/hr past 4h, max 15)
 *
 * Normalized Risk Levels:
 *   - 0 – 24   : 'Low'      (Nominal alertness, safe operation)
 *   - 25 – 49  : 'Moderate' (Fatigue indicators detected, advisory break recommended)
 *   - 50 – 74  : 'High'     (Severe drowsiness patterns, intervention required)
 *   - 75 – 100 : 'Critical' (Microsleep or persistent critical exhaustion)
 */

'use strict';

function computeRiskScore({
  microsleepCount = 0,
  dangerCount = 0,
  warningCount = 0,
  yawnCount = 0,
  avgPerclos = 0.0,
  durationSeconds = 0,
} = {}) {
  // 1. Event components with weights
  const microsleepPenalty = Math.min(45, microsleepCount * 15);
  const dangerPenalty = Math.min(30, dangerCount * 7);
  const warningPenalty = Math.min(15, warningCount * 2);

  // 2. PERCLOS penalty (threshold begins above 10% closure)
  let perclosPenalty = 0;
  if (avgPerclos > 0.10) {
    perclosPenalty = Math.min(25, Math.round(((avgPerclos - 0.10) / 0.40) * 25));
  }

  // 3. Yawn frequency penalty (allow 2 normal baseline yawns before penalizing)
  const excessiveYawns = Math.max(0, yawnCount - 2);
  const yawnPenalty = Math.min(15, excessiveYawns * 3);

  // 4. Duration fatigue (>4 hours = 14400 seconds)
  const durationHours = durationSeconds / 3600;
  let durationPenalty = 0;
  if (durationHours > 4) {
    durationPenalty = Math.min(15, Math.round((durationHours - 4) * 5));
  }

  // Aggregate and clamp to 0-100
  const rawScore = microsleepPenalty + dangerPenalty + warningPenalty + perclosPenalty + yawnPenalty + durationPenalty;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // Determine badge
  let level = 'Low';
  if (score >= 75 || microsleepCount > 0) {
    level = 'Critical';
  } else if (score >= 50) {
    level = 'High';
  } else if (score >= 25) {
    level = 'Moderate';
  } else {
    level = 'Low';
  }

  return {
    score,
    level,
    breakdown: {
      microsleepPenalty,
      dangerPenalty,
      warningPenalty,
      perclosPenalty,
      yawnPenalty,
      durationPenalty,
    },
  };
}

module.exports = {
  computeRiskScore,
};
