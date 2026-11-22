// Minimal glTF 2.0 binary (.glb) reader for the patient and instrument assets. No dependencies.
// Supports what the asset pipeline exports (assets-src/README.md): triangle meshes with POSITION / NORMAL / TEXCOORD_0 /
// COLOR_0, morph targets (POSITION + NORMAL deltas, dense or sparse), materials with base colour, normal map and alpha mode, embedded
// images, and named nodes with translation and extras. Image decoding is optional (createImageBitmap in the browser).

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const NORM_DIV = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/** Split a GLB ArrayBuffer into its JSON and BIN chunks. */
export function splitGlb(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB file');
  if (dv.getUint32(4, true) !== 2) throw new Error('only glTF 2.0 is supported');
  let off = 12, json = null, bin = null;
  while (off < dv.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true), start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, len)));
    else if (type === 0x004e4942) bin = buf.slice(start, start + len);
    off = start + len;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

/** Read an accessor as a flat Float32Array (normalised integers become 0..1), or as integers for indices. */
export function readAccessor(json, bin, index, { asFloat = true } = {}) {
  const a = json.accessors[index], bv = json.bufferViews[a.bufferView ?? -1], n = NCOMP[a.type], T = COMP[a.componentType];
  const out = asFloat ? new Float32Array(a.count * n) : new Uint32Array(a.count * n), dv = new DataView(bin);
  const GET = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' };
  const get = GET[a.componentType], elem = T.BYTES_PER_ELEMENT;
  const div = asFloat && a.normalized ? NORM_DIV[a.componentType] : 1;
  if (bv) {
    const stride = bv.byteStride || n * elem, base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) {
      const v = dv[get](base + i * stride + c * elem, true); out[i * n + c] = div === 1 ? v : v / div;
    }
  }
  // sparse accessor (the exporter stores morph targets that move few vertices, like the face expressions, this way)
  const sp = a.sparse;
  if (sp) {
    const ib = json.bufferViews[sp.indices.bufferView], vb = json.bufferViews[sp.values.bufferView];
    const ig = GET[sp.indices.componentType], ie = COMP[sp.indices.componentType].BYTES_PER_ELEMENT;
    const i0 = (ib.byteOffset || 0) + (sp.indices.byteOffset || 0), v0 = (vb.byteOffset || 0) + (sp.values.byteOffset || 0);
    for (let k = 0; k < sp.count; k++) {
      const i = dv[ig](i0 + k * ie, true);
      for (let c = 0; c < n; c++) { const v = dv[get](v0 + (k * n + c) * elem, true); out[i * n + c] = div === 1 ? v : v / div; }
    }
  }
  return out;
}

/** Parse a GLB into meshes (by node name), materials, node transforms/extras, and image blobs. */
export function parseGlb(buf) {
  const { json, bin } = splitGlb(buf);
  const meshes = {}, nodes = {};
  for (const node of json.nodes || []) {
    nodes[node.name] = { translation: node.translation || [0, 0, 0], extras: node.extras || {}, mesh: node.mesh };
    if (node.mesh == null) continue;
    const m = json.meshes[node.mesh];
    const prims = m.primitives.map(prim => {
      const at = prim.attributes;
      const pos = readAccessor(json, bin, at.POSITION), nrm = at.NORMAL != null ? readAccessor(json, bin, at.NORMAL) : null;
      const uv = at.TEXCOORD_0 != null ? readAccessor(json, bin, at.TEXCOORD_0) : null;
      let color = null;
      if (at.COLOR_0 != null) { const c = readAccessor(json, bin, at.COLOR_0), k = json.accessors[at.COLOR_0].type === 'VEC4' ? 4 : 3; color = { data: c, size: k }; }
      const idx = prim.indices != null ? readAccessor(json, bin, prim.indices, { asFloat: false }) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
      const targets = (prim.targets || []).map(tg => ({ pos: tg.POSITION != null ? readAccessor(json, bin, tg.POSITION) : null, nrm: tg.NORMAL != null ? readAccessor(json, bin, tg.NORMAL) : null }));
      return { pos, nrm, uv, color, idx, targets, targetNames: m.extras?.targetNames || [], material: prim.material != null ? json.materials[prim.material] : null };
    });
    meshes[node.name] = { ...prims[0], prims };                         // first primitive inline (patient meshes have one); all of them in prims
  }
  const images = (json.images || []).map(im => { const bv = json.bufferViews[im.bufferView]; return { mime: im.mimeType, bytes: new Uint8Array(bin, bv.byteOffset || 0, bv.byteLength) }; });
  const texImage = (texIndex) => (texIndex == null ? null : json.textures[texIndex].source);
  return { json, meshes, nodes, images, texImage };
}

/** Blend morph targets: returns new POSITION and NORMAL arrays for the given weights (by target name). */
export function blendMorphs(mesh, weights) {
  const pos = Float32Array.from(mesh.pos), nrm = mesh.nrm ? Float32Array.from(mesh.nrm) : null;
  mesh.targetNames.forEach((name, i) => {
    const w = weights[name] || 0; if (!w) return;
    const t = mesh.targets[i]; if (!t) return;
    if (t.pos) for (let k = 0; k < pos.length; k++) pos[k] += w * t.pos[k];
    if (t.nrm && nrm) for (let k = 0; k < nrm.length; k++) nrm[k] += w * t.nrm[k];
  });
  if (nrm) for (let k = 0; k < nrm.length; k += 3) { const l = Math.hypot(nrm[k], nrm[k + 1], nrm[k + 2]) || 1; nrm[k] /= l; nrm[k + 1] /= l; nrm[k + 2] /= l; }
  return { pos, nrm };
}

/** Decode the embedded images to ImageBitmaps (browser only). */
export async function decodeImages(asset) {
  if (typeof createImageBitmap !== 'function') return asset.images.map(() => null);
  return Promise.all(asset.images.map(im => createImageBitmap(new Blob([im.bytes], { type: im.mime })).catch(() => null)));
}
