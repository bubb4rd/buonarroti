/**
 * The pose the character pipeline needs, as a picture: a mannequin turnaround
 * rendered by scripts/game/bpy/pose_template.py and handed to the image model
 * as its pose / layout reference. Text then only describes the character.
 *
 * The pose itself (arm angle, stance) is fixed by what rigging needs; the build
 * is the user's choice, because the mannequin's proportions carry over into the
 * drawing. New builds are new entries in scripts/game/poses/builds.json.
 * Data only (safe for client components); rendering is in ./turnaround.ts.
 */
import builds from "../../scripts/game/poses/builds.json";

export type Build = keyof typeof builds;
export const BUILDS = Object.entries(builds).map(([id, b]) => ({ id: id as Build, label: b.label }));
export const DEFAULT_BUILD: Build = "average";

/** Upper-arm angle below horizontal (inside CHARACTER_BUDGET.aPoseArmDeg), feet distance / height,
 *  and the hand shape: closed fists, the grip an equipped weapon is attached to. */
export const POSE = { armDeg: 45, stance: 0.2, hands: "fist" } as const;

export function isBuild(v: unknown): v is Build {
  return typeof v === "string" && Object.hasOwn(builds, v);
}

export function buildSpec(build: Build) {
  return builds[build];
}
