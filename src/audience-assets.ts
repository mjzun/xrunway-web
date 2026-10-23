// Optional custom-model audience pipeline (the "Mixamo route"). If seated character
// GLBs are present at public/gltf/audience-{0..3}.glb they REPLACE the procedural
// figures (stage.ts) — instanced per seat, textures intact. If none load, the
// procedural skin/cloth figures stay. See AUDIENCE-ASSETS.md for how to make the GLBs.
//
// The model must be a STATIC mesh with the SEATED POSE already baked (no live
// skeleton) — instancing can't pose a skeleton per seat. A skinned export shows the
// bind (standing) pose; we warn in the console if we detect one.
import {
  AssetManager,
  Box3,
  Matrix4,
  Mesh,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from "@iwsdk/core";

/** One drawable piece of a model (a GLB can have several — body, hair, …), already
 *  normalised into seat-local space. Each instances into its own InstancedMesh. */
export interface AudienceSubMesh {
  geom: BufferGeometry;
  mat: Material | Material[];
  /** Colour role parsed from the mesh name ("part_skin" -> "skin"): skin / hair /
   *  top / bottom / shoes / cloth. Sub-meshes exported WHITE with a role get
   *  per-seat instanceColor variety (the procedural figures' pattern); meshes
   *  without the prefix keep their own materials untinted ("fixed"). */
  role: string;
}
export type AudienceModel = AudienceSubMesh[];

// -- Tunables (tweak if an imported crowd looks off; see AUDIENCE-ASSETS.md) --------
/** Seat-local target height (m), crown-to-seat — matches the procedural figures. */
const SEATED_HEIGHT = 0.9;
/** Standing target height (m) for the photographer-pit figures (pit-N.glb). */
const STANDING_HEIGHT = 1.72;
/** Extra yaw (rad) applied to every model. Flip to Math.PI if the crowd faces AWAY
 *  from the runway (Mixamo characters usually face +Z, which is what we want). */
const MODEL_YAW = 0;
/** How many variant GLBs to look for per set: <prefix>-0.glb … <prefix>-3.glb. */
const MAX_MODELS = 4;

/** Load a numbered GLB set (<prefix>-0..3.glb from public/gltf), normalised to
 *  targetHeight. Stops at the first gap; [] when none are present. */
async function loadModelSet(
  prefix: string,
  targetHeight: number,
): Promise<AudienceModel[]> {
  const models: AudienceModel[] = [];
  for (let i = 0; i < MAX_MODELS; i++) {
    let scene: Object3D | undefined;
    try {
      const gltf = await AssetManager.loadGLTF(
        `gltf/${prefix}-${i}.glb`,
        `${prefix}-${i}`,
      );
      scene = gltf?.scene as Object3D | undefined;
    } catch {
      break; // 404 / load error → no more models
    }
    const model = scene ? processModel(scene, i, targetHeight) : null;
    if (!model || model.length === 0) break;
    models.push(model);
  }
  if (models.length > 0) {
    console.info(
      `[audience] using ${models.length} custom ${prefix} model(s) from public/gltf`,
    );
  }
  return models;
}

/**
 * Try to load the audience GLBs. Returns [] when none are present → the stage
 * uses its procedural figures. Stops at the first gap, so audience-0 +
 * audience-1 work without audience-2/3.
 */
export async function loadAudienceModels(): Promise<AudienceModel[]> {
  return loadModelSet("audience", SEATED_HEIGHT);
}

/** The photographer-pit figures (STANDING press at the runway's end — the
 *  2026-07-15 art direction). No files -> no pit (the stage skips it). */
export async function loadPitModels(): Promise<AudienceModel[]> {
  return loadModelSet("pit", STANDING_HEIGHT);
}

/** Bake a loaded GLB scene into normalised, instance-ready sub-meshes: feet at y=0,
 *  centred in X/Z, scaled to targetHeight, yawed by MODEL_YAW. */
function processModel(
  scene: Object3D,
  index: number,
  targetHeight: number,
): AudienceModel | null {
  scene.updateWorldMatrix(true, true);
  const meshes: Mesh[] = [];
  const box = new Box3();
  const tmp = new Box3();
  let skinnedWarned = false;
  scene.traverse((o) => {
    const m = o as Mesh & { isMesh?: boolean; isSkinnedMesh?: boolean };
    if (m.isMesh !== true || !m.geometry) return;
    if (m.isSkinnedMesh === true && !skinnedWarned) {
      skinnedWarned = true;
      console.warn(
        `[audience] audience-${index}.glb has a SKINNED (un-baked) mesh — it will ` +
          `show the standing bind pose, not seated. Bake the seated pose to a static ` +
          `mesh (see AUDIENCE-ASSETS.md).`,
      );
    }
    m.geometry.computeBoundingBox();
    if (m.geometry.boundingBox) {
      tmp.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
      box.union(tmp);
    }
    meshes.push(m);
  });
  if (meshes.length === 0) return null;

  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const scale = targetHeight / (size.y || 1);
  // norm = yaw · scale · translate(feet→0, centred) — applied AFTER each mesh's own
  // world matrix, so multi-mesh models stay aligned.
  const norm = new Matrix4().makeRotationY(MODEL_YAW);
  norm.multiply(new Matrix4().makeScale(scale, scale, scale));
  norm.multiply(new Matrix4().makeTranslation(-center.x, -box.min.y, -center.z));

  const model: AudienceModel = [];
  const t = new Matrix4();
  for (const m of meshes) {
    const geom = m.geometry.clone();
    geom.applyMatrix4(t.multiplyMatrices(norm, m.matrixWorld));
    const role = m.name.startsWith("part_") ? m.name.slice(5) : "fixed";
    model.push({ geom, mat: m.material, role });
  }
  return model;
}
