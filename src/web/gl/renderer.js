// WebGL2 renderer: physically-flavoured lighting (GGX, soft shadow map, skin subsurface wrap, hair/fabric/wet-eye materials),
// 4x MSAA HDR render target, multi-scale bloom, ACES tone mapping, vignette and a touch of sharpening.
import { mat4, vec3, screenRay } from './math.js';

const GLSL_NOISE = `
float hash13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x), mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x), mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z); }`;

const VS = `#version 300 es
in vec3 aPos; in vec3 aNorm; in vec2 aW; in vec3 aTint; in vec2 aUV;
uniform mat4 uModel; uniform mat4 uVP; uniform float uBreath; uniform float uCompress; uniform float uInflate; uniform vec3 uCompDir;
out vec3 vN; out vec3 vWP; out vec3 vTint; out vec2 vUV;
void main(){
  vec3 p = aPos + aNorm * (uBreath * aW.x + uInflate);
  p -= uCompDir * (uCompress * aW.y);
  vec4 wp = uModel * vec4(p, 1.0);
  vWP = wp.xyz; vTint = aTint; vUV = aUV;
  vN = transpose(inverse(mat3(uModel))) * aNorm;
  gl_Position = uVP * wp;
}`;

const VS_SHADOW = `#version 300 es
in vec3 aPos; in vec3 aNorm; in vec2 aW;
uniform mat4 uModel; uniform mat4 uVP; uniform float uBreath; uniform float uCompress; uniform float uInflate; uniform vec3 uCompDir;
void main(){ vec3 p = aPos + aNorm * (uBreath * aW.x + uInflate); p -= uCompDir * (uCompress * aW.y); gl_Position = uVP * uModel * vec4(p, 1.0); }`;
const FS_SHADOW = `#version 300 es
precision mediump float; out vec4 o; void main(){ o = vec4(1.0); }`;

const FS = `#version 300 es
precision highp float; precision highp sampler2DShadow;
in vec3 vN; in vec3 vWP; in vec3 vTint; in vec2 vUV;
uniform sampler2D uAlbedo; uniform sampler2D uNormalMap; uniform int uTexMode; uniform float uAlphaCut;
uniform vec3 uColor; uniform vec3 uEmissive; uniform float uSpec; uniform float uAlpha;
uniform int uPattern; uniform vec3 uEye; uniform vec3 uLightPos; uniform vec3 uLightDir; uniform float uLightK;
uniform mat4 uLightVP; uniform sampler2DShadow uShadow; uniform int uDirect;
out vec4 o;
const float PI = 3.14159265;
${GLSL_NOISE}
float shadowAt(vec3 wp, vec3 n){
  vec4 lp = uLightVP * vec4(wp + n * 0.014, 1.0);
  vec3 pc = lp.xyz / lp.w * 0.5 + 0.5;
  if (pc.x < 0.0 || pc.x > 1.0 || pc.y < 0.0 || pc.y > 1.0 || pc.z > 1.0) return 1.0;
  float ang = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  float cs = cos(ang), sn = sin(ang);
  float s = 0.0, rad = 2.6 / 2048.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i) + 0.5, r = sqrt(fi / 12.0), a = fi * 2.39996;
    vec2 d = vec2(cos(a), sin(a)) * r; d = vec2(d.x * cs - d.y * sn, d.x * sn + d.y * cs) * rad;
    s += texture(uShadow, vec3(pc.xy + d, pc.z - 0.0009));
  }
  return s / 12.0;
}
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
// tangent-space normal map without stored tangents: cotangent frame from screen-space derivatives
vec3 perturb(vec3 N, vec3 p, vec2 uv, vec3 m){
  vec3 dp1 = dFdx(p), dp2 = dFdy(p); vec2 du1 = dFdx(uv), du2 = dFdy(uv);
  vec3 a = cross(dp2, N), b = cross(N, dp1);
  vec3 T = a * du1.x + b * du2.x, B = a * du1.y + b * du2.y;
  float k = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
  return normalize(mat3(T * k, B * k, N) * m);
}
void main(){
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 V = uEye - vWP; float dist = length(V); V /= dist;
  vec3 base = pow(clamp(uColor * vTint, 0.0, 1.0), vec3(2.2));
  float texA = 1.0;
  if (uTexMode > 0) {                                       // albedo texture (sRGB) tinted by uColor (skin tone / pallor / cyanosis ratio)
    vec4 tx = texture(uAlbedo, vUV); texA = tx.a;
    if (tx.a < uAlphaCut) discard;
    base = pow(tx.rgb, vec3(2.2)) * clamp(uColor, 0.0, 2.0);
    if (uTexMode > 1) n = perturb(n, vWP, vUV, texture(uNormalMap, vUV).xyz * 2.0 - 1.0);
  }
  float rough = clamp(1.0 - uSpec * 1.7, 0.2, 0.95), f0 = 0.04, wrap = 0.0, sss = 0.0, spMul = 1.0;
  vec3 em = pow(uEmissive, vec3(2.2)) * 3.2;
  float gloss = 0.0;
  if (uPattern == 1) { // seamless hospital vinyl: fine speckle, faint welded seams every 2 m, scuffs, satin sheen
    float sp = vnoise(vWP * 140.0), sp2 = vnoise(vWP * 37.0), scuff = smoothstep(0.62, 0.9, vnoise(vec3(vWP.x * 1.3, 0.0, vWP.z * 4.0)));
    float seam = 1.0 - 0.18 * smoothstep(0.494, 0.5, abs(fract(vWP.x * 0.5) - 0.5));
    base *= (0.93 + 0.10 * sp2) * (0.96 + 0.08 * step(0.78, sp)) * seam * (1.0 - 0.07 * scuff);
    rough = mix(0.34, 0.55, scuff); f0 = 0.04; gloss = 1.0;
  } else if (uPattern == 2) { // painted wall: soft lower wainscot band, chair rail, slight orange-peel
    float band = step(vWP.y, 1.05), rail = smoothstep(0.03, 0.0, abs(vWP.y - 1.07));
    base = mix(base, base * vec3(0.86, 0.93, 0.92), band) * (0.97 + 0.04 * vnoise(vWP * 26.0)) * (1.0 - 0.18 * rail); rough = mix(0.82, 0.55, band);
  } else if (uPattern == 7) { // photographic skin (patient.glb): texture carries the detail; keep the scattering
    float mott = vnoise(vWP * 22.0) - 0.5;
    base *= vec3(1.0 + 0.04 * mott, 1.0 - 0.02 * mott, 1.0 - 0.04 * mott);
    rough = 0.5; f0 = 0.028; wrap = 0.42; sss = 1.0; spMul = 0.65;
  } else if (uPattern == 3) { // skin
    float fadeP = 1.0 - smoothstep(1.2, 3.8, dist);
    vec3 pn = vec3(vnoise(vWP * 900.0), vnoise(vWP * 900.0 + 17.3), vnoise(vWP * 900.0 + 41.7)) - 0.5;
    vec3 mn = vec3(vnoise(vWP * 38.0), vnoise(vWP * 38.0 + 9.1), vnoise(vWP * 38.0 + 23.9)) - 0.5;
    n = normalize(n + pn * 0.035 * fadeP + mn * 0.018);
    float mott = vnoise(vWP * 22.0) - 0.5;
    base *= vec3(1.0 + 0.10 * mott, 1.0 - 0.06 * mott, 1.0 - 0.10 * mott);
    rough = 0.52; f0 = 0.028; wrap = 0.42; sss = 1.0; spMul = 0.7;
  } else if (uPattern == 4) { // hair
    float st = vnoise(vWP * vec3(260.0, 90.0, 260.0)), st2 = vnoise(vWP * 700.0);
    base *= 0.7 + 0.6 * st; base += 0.015 * st2; rough = 0.62; f0 = 0.03; wrap = 0.3; spMul = 0.45;
    n = normalize(n + (vec3(vnoise(vWP * 400.0), vnoise(vWP * 400.0 + 5.0), vnoise(vWP * 400.0 + 11.0)) - 0.5) * 0.12);
  } else if (uPattern == 5) { // fabric: faint weave and soft sheen
    float w = sin(vWP.x * 520.0) * sin(vWP.z * 520.0) + sin(vWP.y * 480.0) * sin(vWP.x * 480.0);
    base *= 0.97 + 0.03 * w; rough = 0.9; wrap = 0.25; spMul = 0.4;
  } else if (uPattern == 6) { // wet eye
    rough = 0.08; f0 = 0.06; spMul = 2.5;
  }
  // key light: ceiling spot with a soft shadow
  vec3 toL = uLightPos - vWP; float ld = length(toL); vec3 L = toL / ld;
  float spot = smoothstep(0.30, 0.78, dot(-L, uLightDir));
  float sh = shadowAt(vWP, n);
  float att = uLightK * 2.3 / (1.0 + 0.10 * ld * ld) * spot;
  vec3 keyCol = vec3(1.0, 0.955, 0.90);
  float nl = dot(n, L), dif = max((nl + wrap) / (1.0 + wrap), 0.0);
  vec3 col = base * keyCol * dif * att * sh;
  if (sss > 0.0) { float t = smoothstep(-0.35, 0.15, nl) * (1.0 - smoothstep(0.15, 0.65, nl)); col += base * vec3(0.95, 0.30, 0.18) * t * att * sh * 0.55; }
  // panel lights (no shadow): the other two ceiling fixtures
  for (int i = 0; i < 2; i++) {
    vec3 lp = i == 0 ? vec3(-1.5, 2.95, -0.8) : vec3(-1.2, 2.95, 1.7);
    vec3 d = lp - vWP; float dd = length(d); vec3 l2 = d / dd; float nl2 = max((dot(n, l2) + wrap) / (1.0 + wrap), 0.0);
    col += base * vec3(0.9, 0.95, 1.0) * nl2 * 1.1 / (1.0 + 0.18 * dd * dd);
  }
  // fill: neutral sky/ground ambient (bounce off a light floor), occlusion near the floor, in room corners and under the bed
  float hh = n.y * 0.5 + 0.5;
  vec3 amb = mix(vec3(0.24, 0.23, 0.22), vec3(0.47, 0.49, 0.52), hh);
  float corner = smoothstep(0.0, 0.45, min(min(vWP.x + 3.0, 1.95 - vWP.x), min(vWP.z + 2.6, 3.7 - vWP.z)));
  float underBed = 1.0 - 0.45 * (1.0 - smoothstep(0.0, 0.7, vWP.y)) * (1.0 - smoothstep(0.25, 0.75, max(abs(vWP.x + 0.1) - 0.95, abs(vWP.z) - 0.25)));
  float ao = mix(0.5, 1.0, smoothstep(0.0, 0.55, vWP.y)) * mix(0.72, 1.0, hh) * mix(0.62, 1.0, corner) * underBed;
  col += base * amb * ao * 0.58;
  col += base * vec3(0.55, 0.65, 0.8) * max(dot(n, normalize(vec3(-0.6, 0.25, 0.7))), 0.0) * 0.16;
  // specular (GGX)
  vec3 H = normalize(L + V); float a = rough * rough, a2 = a * a, nh = max(dot(n, H), 0.0), nv = max(dot(n, V), 0.001), lh = max(dot(L, H), 0.0);
  float D = a2 / (PI * pow(nh * nh * (a2 - 1.0) + 1.0, 2.0));
  float F = f0 + (1.0 - f0) * pow(1.0 - lh, 5.0);
  float spec = D * F * 0.25 / max(lh * lh, 0.12) * max(nl, 0.0) * (uSpec * 2.6 + 0.25) * spMul;
  col += keyCol * spec * att * sh;
  float fr = pow(1.0 - nv, 5.0);
  col += (vec3(0.5, 0.6, 0.7) * (0.04 + uSpec * 0.5) * fr + (gloss > 0.5 ? vec3(0.35, 0.40, 0.42) * fr * (1.0 - rough) : vec3(0.0))) * ao;   // environment sheen at grazing angles
  if (uPattern == 3 || uPattern == 7) col += vec3(0.9, 0.55, 0.45) * pow(1.0 - nv, 3.0) * 0.07 * base;   // soft rim: blood-warm scatter at silhouettes
  col += em;
  // gentle depth haze toward the room colour
  col = mix(col, vec3(0.07, 0.09, 0.11), clamp((dist - 5.0) * 0.04, 0.0, 0.35));
  if (uDirect == 1) col = pow(aces(col * 0.8), vec3(1.0 / 2.2));
  o = vec4(col, uAlpha * (uAlphaCut < 0.0 ? texA : 1.0));
}`;

const VS_TEX = `#version 300 es
in vec3 aPos; in vec2 aUV;
uniform mat4 uModel; uniform mat4 uVP;
out vec2 vUV;
void main(){ vUV = aUV; gl_Position = uVP * uModel * vec4(aPos, 1.0); }`;
const FS_TEX = `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uTex; uniform float uGlow; uniform int uDirect;
out vec4 o;
void main(){ vec4 t = texture(uTex, vUV); vec3 c = pow(t.rgb, vec3(2.2)) * uGlow * 1.7; if (uDirect == 1) c = pow(c / (1.0 + c), vec3(1.0 / 2.2)); o = vec4(c, 1.0); }`;

const VS_FS = `#version 300 es
out vec2 vUV; void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUV = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const FS_BRIGHT = `#version 300 es
precision highp float; in vec2 vUV; uniform sampler2D uTex; out vec4 o;
void main(){ vec3 c = vec3(0.0); vec2 t = 1.0 / vec2(textureSize(uTex, 0));
  for (int i = 0; i < 4; i++) { vec2 d = vec2(float(i & 1) - 0.5, float(i >> 1) - 0.5) * 2.0 * t; c += texture(uTex, vUV + d).rgb; } c *= 0.25;
  float l = max(c.r, max(c.g, c.b)); o = vec4(c * smoothstep(1.4, 3.2, l), 1.0); }`;
const FS_BLUR = `#version 300 es
precision highp float; in vec2 vUV; uniform sampler2D uTex; uniform vec2 uDir; out vec4 o;
void main(){ vec2 t = uDir / vec2(textureSize(uTex, 0)); vec3 c = texture(uTex, vUV).rgb * 0.2270270;
  c += (texture(uTex, vUV + t * 1.3846).rgb + texture(uTex, vUV - t * 1.3846).rgb) * 0.3162162;
  c += (texture(uTex, vUV + t * 3.2308).rgb + texture(uTex, vUV - t * 3.2308).rgb) * 0.0702703; o = vec4(c, 1.0); }`;
const FS_COMP = `#version 300 es
precision highp float; in vec2 vUV; uniform sampler2D uScene; uniform sampler2D uBloom1; uniform sampler2D uBloom2; uniform float uTime; out vec4 o;
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main(){
  vec2 px = 1.0 / vec2(textureSize(uScene, 0));
  vec3 c = texture(uScene, vUV).rgb;
  vec3 bl = (texture(uBloom1, vUV).rgb * 0.55 + texture(uBloom2, vUV).rgb * 0.75);
  vec3 nb = (texture(uScene, vUV + vec2(px.x, 0.0)).rgb + texture(uScene, vUV - vec2(px.x, 0.0)).rgb + texture(uScene, vUV + vec2(0.0, px.y)).rgb + texture(uScene, vUV - vec2(0.0, px.y)).rgb) * 0.25;
  c += (c - nb) * 0.18;                                   // light unsharp mask (strong sharpening reads as CG)
  c += bl * 0.35;
  vec2 q = vUV - 0.5; float vig = 1.0 - dot(q, q) * 0.6; c *= vig;
  c = aces(c * 0.92);
  c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 0.94);   // slightly muted, like a real clinical photograph
  c = c * vec3(1.0, 0.995, 0.975) + vec3(0.004, 0.005, 0.008); // neutral-warm grade, lifted blacks
  c = pow(c, vec3(1.0 / 2.2));
  float n = fract(sin(dot(gl_FragCoord.xy + uTime, vec2(12.9898, 78.233))) * 43758.5453); c += (n - 0.5) / 255.0;
  o = vec4(c, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos'); gl.bindAttribLocation(p, 1, 'aNorm'); gl.bindAttribLocation(p, 2, 'aW'); gl.bindAttribLocation(p, 3, 'aTint'); gl.bindAttribLocation(p, 4, 'aUV');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  return p;
}
const uniforms = (gl, p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, stencil: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl; this.canvas = canvas;
    this.prog = program(gl, VS, FS); this.progShadow = program(gl, VS_SHADOW, FS_SHADOW); this.progTex = program(gl, VS_TEX, FS_TEX);
    this.u = uniforms(gl, this.prog, ['uModel', 'uVP', 'uBreath', 'uCompress', 'uColor', 'uEmissive', 'uSpec', 'uAlpha', 'uPattern', 'uEye', 'uLightPos', 'uLightDir', 'uLightK', 'uLightVP', 'uShadow', 'uDirect', 'uAlbedo', 'uNormalMap', 'uTexMode', 'uAlphaCut', 'uInflate', 'uCompDir']);
    this.us = uniforms(gl, this.progShadow, ['uModel', 'uVP', 'uBreath', 'uCompress', 'uInflate', 'uCompDir']);
    this.ut = uniforms(gl, this.progTex, ['uModel', 'uVP', 'uTex', 'uGlow', 'uDirect']);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.clear = [0.05, 0.06, 0.08];
    this.vp = mat4.identity(); this.eye = [0, 2, 4];
    this.lightPos = [0, 2.6, 0]; this.lightTarget = [0, 0.8, 0.1]; this.lightK = 1.6;
    this.quad = this._quad(); this.mode = 'main'; this.frame = 0;
    this._initShadow(); this._initPost();
  }
  _initShadow() {
    const gl = this.gl, S = 2048;
    try {
      this.shTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.shTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, S, S);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      this.shFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.shFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shTex, 0);
      gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
      this.shOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE; this.shSize = S;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } catch { this.shOk = false; }
    this.lightVP = mat4.identity();
  }
  _initPost() {
    const gl = this.gl;
    this.floatOk = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    gl.getExtension('OES_texture_float_linear');
    this.post = null;
    if (!this.floatOk) return;
    try {
      this.pBright = program(gl, VS_FS, FS_BRIGHT); this.pBlur = program(gl, VS_FS, FS_BLUR); this.pComp = program(gl, VS_FS, FS_COMP);
      this.ub = uniforms(gl, this.pBright, ['uTex']); this.ubl = uniforms(gl, this.pBlur, ['uTex', 'uDir']); this.uc = uniforms(gl, this.pComp, ['uScene', 'uBloom1', 'uBloom2', 'uTime']);
      this.emptyVao = gl.createVertexArray();
      this.post = { w: 0, h: 0 };
    } catch (e) { this.post = null; console.warn('post-processing disabled:', e && e.message); }
  }
  _tex(w, h) {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f, w, h };
  }
  _sizePost(w, h) {
    const gl = this.gl, P = this.post; if (!P || (P.w === w && P.h === h)) return;
    for (const k of ['scene', 'a1', 'b1', 'a2', 'b2']) if (P[k]) { gl.deleteTexture(P[k].t); gl.deleteFramebuffer(P[k].f); }
    if (P.msFbo) { gl.deleteFramebuffer(P.msFbo); gl.deleteRenderbuffer(P.msColor); gl.deleteRenderbuffer(P.msDepth); }
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0);
    P.msFbo = gl.createFramebuffer(); P.msColor = gl.createRenderbuffer(); P.msDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, P.msColor); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA16F, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, P.msDepth); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, P.msFbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, P.msColor); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, P.msDepth);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    P.scene = this._tex(w, h); P.a1 = this._tex(Math.max(2, w >> 2), Math.max(2, h >> 2)); P.b1 = this._tex(Math.max(2, w >> 2), Math.max(2, h >> 2));
    P.a2 = this._tex(Math.max(2, w >> 3), Math.max(2, h >> 3)); P.b2 = this._tex(Math.max(2, w >> 3), Math.max(2, h >> 3));
    P.w = w; P.h = h; P.ok = ok && [P.scene, P.a1, P.b1, P.a2, P.b2].every(x => { gl.bindFramebuffer(gl.FRAMEBUFFER, x.f); return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE; });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  upload(mesh) {
    const gl = this.gl, vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const mk = (data, loc, size) => {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    mk(mesh.pos, 0, 3); mk(mesh.nrm, 1, 3); mk(mesh.w, 2, 2);
    if (mesh.tint) mk(mesh.tint, 3, 3); else gl.disableVertexAttribArray(3);
    if (mesh.uv) mk(mesh.uv, 4, 2); else gl.disableVertexAttribArray(4);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: mesh.idx.length, ref: mesh, hasTint: !!mesh.tint, hasUV: !!mesh.uv };
  }
  release(gm) { if (gm && gm.vao) this.gl.deleteVertexArray(gm.vao); }
  _quad() {
    const gl = this.gl, vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const pos = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
    const uv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
    const mk = (d, loc, size) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); };
    mk(pos, gl.getAttribLocation(this.progTex, 'aPos'), 3); mk(uv, gl.getAttribLocation(this.progTex, 'aUV'), 2);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: 6 };
  }
  createTexture(canvas2d) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas2d);
    return t;
  }
  /** Texture from a decoded image (ImageBitmap), with mipmaps and anisotropic filtering when available. */
  imageTexture(img) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    const an = gl.getExtension('EXT_texture_filter_anisotropic'); if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(an.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    return t;
  }
  updateTexture(t, canvas2d) { if (this.mode === 'shadow') return; const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas2d); }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), c = this.canvas;
    const w = Math.max(2, Math.floor(c.clientWidth * dpr)), h = Math.max(2, Math.floor(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.w = w; this.h = h; this.aspect = w / h;
  }

  // ---- shadow pass: scene.draw() is run once in 'shadow' mode (casters only), then again for the picture
  beginShadow() {
    if (!this.shOk) { this.mode = 'skip'; return; }
    const gl = this.gl; this.mode = 'shadow';
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shFbo); gl.viewport(0, 0, this.shSize, this.shSize);
    gl.colorMask(false, false, false, false); gl.clear(gl.DEPTH_BUFFER_BIT); gl.disable(gl.BLEND);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2.0, 4.0);
    const proj = mat4.perspective(1.25, 1, 0.6, 9), view = mat4.lookAt(this.lightPos, this.lightTarget, [0, 0, 1]);
    this.lightVP = mat4.multiply(proj, view);
    gl.useProgram(this.progShadow); gl.uniformMatrix4fv(this.us.uVP, false, this.lightVP);
  }
  endShadow() {
    const gl = this.gl;
    if (this.mode === 'shadow') { gl.disable(gl.POLYGON_OFFSET_FILL); gl.colorMask(true, true, true, true); gl.enable(gl.BLEND); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
    this.mode = 'main';
  }

  begin(camera) {
    const gl = this.gl; this.resize(); this.mode = 'main';
    const P = this.post; let target = null;
    if (P) { this._sizePost(this.w, this.h); if (P.ok) { target = P.msFbo; this.postActive = true; } else this.postActive = false; } else this.postActive = false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(...this.clear.map(v => Math.pow(v, 2.2)), 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    let proj = mat4.perspective(camera.fov || 0.9, this.aspect, 0.05, 80);
    if (this.shiftX) proj = mat4.multiply(mat4.translation(this.shiftX, 0, 0), proj);   // lens shift: centre the picture in the space left free by the side panels
    const view = mat4.lookAt(camera.eye, camera.target, [0, 1, 0]);
    this.vp = mat4.multiply(proj, view); this.invVP = mat4.invert(this.vp); this.eye = camera.eye;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.uVP, false, this.vp);
    gl.uniform3fv(this.u.uEye, this.eye); gl.uniform3fv(this.u.uLightPos, this.lightPos); gl.uniform1f(this.u.uLightK, this.lightK);
    const ld = vec3.norm(vec3.sub(this.lightTarget, this.lightPos)); gl.uniform3fv(this.u.uLightDir, ld);
    gl.uniformMatrix4fv(this.u.uLightVP, false, this.lightVP); gl.uniform1i(this.u.uDirect, this.postActive ? 0 : 1);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.shOk ? this.shTex : null); gl.uniform1i(this.u.uShadow, 1); gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.u.uAlbedo, 2); gl.uniform1i(this.u.uNormalMap, 3);
  }
  /** Resolve the HDR target, build the bloom chain and write the tone-mapped picture to the canvas. */
  end() {
    const gl = this.gl, P = this.post; if (!this.postActive) return;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, P.msFbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, P.scene.f);
    gl.blitFramebuffer(0, 0, P.w, P.h, 0, 0, P.w, P.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.bindVertexArray(this.emptyVao);
    const pass = (prog, dst, bind) => { gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.f : null); gl.viewport(0, 0, dst ? dst.w : P.w, dst ? dst.h : P.h); gl.useProgram(prog); bind(); gl.drawArrays(gl.TRIANGLES, 0, 3); };
    const tex = (unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); };
    pass(this.pBright, P.a1, () => { tex(0, P.scene.t); gl.uniform1i(this.ub.uTex, 0); });
    pass(this.pBlur, P.b1, () => { tex(0, P.a1.t); gl.uniform1i(this.ubl.uTex, 0); gl.uniform2f(this.ubl.uDir, 1, 0); });
    pass(this.pBlur, P.a1, () => { tex(0, P.b1.t); gl.uniform1i(this.ubl.uTex, 0); gl.uniform2f(this.ubl.uDir, 0, 1); });
    pass(this.pBright, P.a2, () => { tex(0, P.a1.t); gl.uniform1i(this.ub.uTex, 0); });
    for (let i = 0; i < 2; i++) {
      pass(this.pBlur, P.b2, () => { tex(0, P.a2.t); gl.uniform1i(this.ubl.uTex, 0); gl.uniform2f(this.ubl.uDir, 1.6, 0); });
      pass(this.pBlur, P.a2, () => { tex(0, P.b2.t); gl.uniform1i(this.ubl.uTex, 0); gl.uniform2f(this.ubl.uDir, 0, 1.6); });
    }
    pass(this.pComp, null, () => { tex(0, P.scene.t); tex(1, P.a1.t); tex(2, P.a2.t); gl.uniform1i(this.uc.uScene, 0); gl.uniform1i(this.uc.uBloom1, 1); gl.uniform1i(this.uc.uBloom2, 2); gl.uniform1f(this.uc.uTime, (this.frame++ % 997) * 0.37); });
    gl.activeTexture(gl.TEXTURE0); gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.enable(gl.CULL_FACE);
  }

  /** opts: color, emissive, spec, alpha, pattern, breath, compress, noShadow */
  draw(gm, model, o = {}) {
    const gl = this.gl;
    if (this.mode === 'skip') return;
    if (this.mode === 'shadow') {
      if ((o.alpha ?? 1) < 0.9 || o.noShadow || (o.pattern || 0) === 1 || (o.pattern || 0) === 2) return;
      gl.uniformMatrix4fv(this.us.uModel, false, model); gl.uniform1f(this.us.uBreath, o.breath || 0); gl.uniform1f(this.us.uCompress, o.compress || 0); gl.uniform1f(this.us.uInflate, o.inflate || 0); gl.uniform3fv(this.us.uCompDir, o.compDir || [0, 0, 1]);
      gl.bindVertexArray(gm.vao); gl.drawElements(gl.TRIANGLES, gm.count, gl.UNSIGNED_INT, 0); return;
    }
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.uModel, false, model);
    gl.uniform3fv(this.u.uColor, o.color || [0.7, 0.7, 0.7]);
    gl.uniform3fv(this.u.uEmissive, o.emissive || [0, 0, 0]);
    gl.uniform1f(this.u.uSpec, o.spec ?? 0.15);
    gl.uniform1f(this.u.uAlpha, o.alpha ?? 1);
    gl.uniform1i(this.u.uPattern, o.pattern || 0);
    gl.uniform1f(this.u.uBreath, o.breath || 0);
    gl.uniform1f(this.u.uCompress, o.compress || 0);
    gl.uniform1f(this.u.uInflate, o.inflate || 0); gl.uniform3fv(this.u.uCompDir, o.compDir || [0, 0, 1]);
    const tm = o.albedo ? (o.normalMap ? 2 : 1) : 0;
    gl.uniform1i(this.u.uTexMode, tm); gl.uniform1f(this.u.uAlphaCut, o.alphaCut ?? 0);
    if (tm) {
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, o.albedo); gl.uniform1i(this.u.uAlbedo, 2);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, o.normalMap || o.albedo); gl.uniform1i(this.u.uNormalMap, 3);
      gl.activeTexture(gl.TEXTURE0);
    }
    if (o.cull === false) gl.disable(gl.CULL_FACE);
    if (o.depthWrite === false) gl.depthMask(false);
    gl.bindVertexArray(gm.vao);
    if (!gm.hasTint) gl.vertexAttrib3f(3, 1, 1, 1);
    if (!gm.hasUV) gl.vertexAttrib2f(4, 0, 0);
    gl.drawElements(gl.TRIANGLES, gm.count, gl.UNSIGNED_INT, 0);
    if (o.cull === false) gl.enable(gl.CULL_FACE);
    if (o.depthWrite === false) gl.depthMask(true);
  }
  /** Retained for compatibility: shadows now come from the shadow map. */
  drawShadow() {}
  clearStencil() {}
  drawQuad(tex, model, glow = 1) {
    const gl = this.gl; if (this.mode !== 'main') return;
    gl.useProgram(this.progTex);
    gl.uniformMatrix4fv(this.ut.uModel, false, model); gl.uniformMatrix4fv(this.ut.uVP, false, this.vp);
    gl.uniform1f(this.ut.uGlow, glow); gl.uniform1i(this.ut.uDirect, this.postActive ? 0 : 1);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(this.ut.uTex, 0);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-2, -8);        // decal: wins the depth test against the surface it is painted on
    gl.bindVertexArray(this.quad.vao); gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0); gl.disable(gl.POLYGON_OFFSET_FILL);
  }
  rayFromClient(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const nx = ((clientX - r.left) / r.width) * 2 - 1, ny = -(((clientY - r.top) / r.height) * 2 - 1);
    return screenRay(this.invVP, nx, ny);
  }
}
export { mat4, vec3 };
