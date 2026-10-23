/**
 * (X)RUNWAY — Passthrough backdrop scenes.
 *
 * (X)RUNWAY is an AR passthrough experience: in a real headset the runway is
 * overlaid on the real room and there is no virtual backdrop. On a laptop/phone
 * pitch there is nothing behind the runway but a black void, so these scenes let
 * you SIMULATE what the runway looks like dropped into a real place — a photo
 * studio, a park, a skatepark, a beach.
 *
 * Each scene is a photoreal equirectangular panorama (CC0, Poly Haven) wired to
 * the IWSDK `DomeTexture` background. The active scene lives on
 * `world.globals.activeScene`; EnvironmentSystem renders it to `scene.background`
 * and AUTOMATICALLY hides it in immersive AR (so real passthrough shows through).
 *
 * Backdrops are lazy: only the selected panorama is fetched. "AR / NONE" keeps
 * the default dark studio dome (the headset / no-backdrop look).
 */

export type SceneId = "ar" | "studio" | "park" | "skatepark" | "beach";

export interface PassthroughScene {
  id: SceneId;
  label: string;
  /** Short tagline for the picker. */
  blurb: string;
  /** Equirect backdrop path under public/, or null for AR / no backdrop. */
  src: string | null;
  /** Background brightness — bright daylight scenes are dimmed so the lit
   *  runway still reads against them (scene.backgroundIntensity). */
  intensity: number;
  /** Yaw (radians) to orient the nicest part of the pano behind the runway. */
  yaw: number;
  /** CC0 source credit (Poly Haven asset id). */
  credit?: string;
}

export const SCENES: ReadonlyArray<PassthroughScene> = [
  {
    id: "ar",
    label: "AR / NONE",
    blurb: "Real passthrough — no virtual backdrop (headset default).",
    src: null,
    intensity: 1,
    yaw: 0,
  },
  {
    id: "studio",
    label: "STUDIO",
    blurb: "White photo-studio cyclorama, hard key light.",
    src: "/env/studio.jpg",
    intensity: 1.0,
    yaw: Math.PI, // turn the clutter behind the camera, clean sweep down-runway
    credit: "Poly Haven CC0 · cyclorama_hard_light",
  },
  {
    id: "park",
    label: "PARK",
    blurb: "Lush green park, bright daylight.",
    src: "/env/park.jpg",
    intensity: 0.92,
    yaw: 0,
    credit: "Poly Haven CC0 · ballawley_park",
  },
  {
    id: "skatepark",
    label: "SKATEPARK",
    blurb: "Concrete + graffiti street spot.",
    src: "/env/skatepark.jpg",
    intensity: 0.85,
    yaw: 0,
    credit: "Poly Haven CC0 · graffiti_shelter",
  },
  {
    id: "beach",
    label: "BEACH",
    blurb: "Sunny sandy cove, sea + sky.",
    src: "/env/beach.jpg",
    intensity: 0.9,
    yaw: 0,
    credit: "Poly Haven CC0 · secluded_beach",
  },
];

export const DEFAULT_SCENE = SCENES[0]; // AR / none

export function getScene(id: SceneId): PassthroughScene {
  return SCENES.find((s) => s.id === id) ?? DEFAULT_SCENE;
}

const SCENE_STORAGE_KEY = "xrunway.scene.v1";

export function loadScene(): PassthroughScene {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_SCENE;
    const id = localStorage.getItem(SCENE_STORAGE_KEY) as SceneId | null;
    return id ? getScene(id) : DEFAULT_SCENE;
  } catch {
    return DEFAULT_SCENE;
  }
}

export function saveScene(scene: PassthroughScene): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(SCENE_STORAGE_KEY, scene.id);
    }
  } catch {
    /* storage unavailable — non-fatal. */
  }
}
