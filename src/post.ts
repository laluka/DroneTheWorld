import type { CamBasis, Lens } from './camera';

/** Look of the FPV feed. */
export type LensMode = 'clean' | 'fpv' | 'analog';
export const LENS_MODES: LensMode[] = ['clean', 'fpv', 'analog'];

export interface LensFx {
  /** barrel distortion strength */
  k: number;
  vignette: number;
  /** chromatic aberration at the corners */
  ca: number;
  /** analog video noise / scanlines / bleed, 0..1 */
  analog: number;
}
export const LENS_FX: Record<LensMode, LensFx> = {
  clean: { k: 0, vignette: 0, ca: 0, analog: 0 },
  fpv: { k: 0.22, vignette: 0.38, ca: 0.006, analog: 0 },
  analog: { k: 0.3, vignette: 0.6, ca: 0.012, analog: 1 },
};

export interface SkyColors { sky: string; horizon: string; fog: string; sun: number }

const VS = `#version 300 es
out vec2 vPix;
uniform vec2 uRes;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vPix = p * uRes;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vPix;
out vec4 outColor;
uniform sampler2D uTex;
uniform mat3 uTrue, uRend;
uniform vec2 uRes, uTanR;
uniform float uD, uK, uVig, uCA, uBlur, uAnalog, uTime, uHasTex, uSunAmt;
uniform vec3 uSky, uHorizon, uFog, uSun;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

vec3 skyCol(vec3 w) {
  w = normalize(w);
  float el = w.z;
  vec3 c = el > 0.0 ? mix(uHorizon, uSky, smoothstep(0.0, 0.55, el)) : mix(uHorizon, uFog, smoothstep(0.0, 0.03, -el));
  float s = max(dot(w, uSun), 0.0);
  c += uSunAmt * (vec3(1.0, 0.95, 0.85) * pow(s, 600.0) * 1.4 + vec3(1.0, 0.85, 0.6) * pow(s, 14.0) * 0.16);
  return c;
}

vec3 sceneAt(vec2 a) {
  float m = (1.0 + uK * dot(a, a)) / (1.0 + uK) * uD;
  vec3 w = uTrue * vec3(a * m, 1.0);
  vec3 bg = skyCol(w);
  if (uHasTex < 0.5) return bg;
  vec3 l = transpose(uRend) * w;
  if (l.z <= 1e-4) return bg;
  vec2 uv = l.xy / l.z / uTanR * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return bg;
  vec4 t = texture(uTex, uv);
  return mix(bg, t.rgb, t.a);
}

void main() {
  float halfDiag = length(uRes) * 0.5;
  vec2 pix = vPix;
  if (uAnalog > 0.0) {
    // horizontal line wobble, like a weak analog signal
    float row = floor(pix.y / 3.0);
    pix.x += (hash(vec2(row, floor(uTime * 24.0))) - 0.5) * 2.5 * uAnalog;
  }
  vec2 a = (pix - uRes * 0.5) / halfDiag;
  float r2 = dot(a, a);
  vec3 col;
  if (uCA > 0.0) {
    col.r = sceneAt(a * (1.0 + uCA * r2)).r;
    col.g = sceneAt(a).g;
    col.b = sceneAt(a * (1.0 - uCA * r2)).b;
  } else col = sceneAt(a);
  if (uBlur > 0.0005) {
    // radial speed blur, stronger towards the edges
    vec3 acc = col;
    for (int i = 1; i <= 4; i++) acc += sceneAt(a * (1.0 - uBlur * float(i) * r2));
    col = acc / 5.0;
  }
  if (uAnalog > 0.0) {
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(l), 0.25 * uAnalog);
    col *= 1.0 - 0.10 * uAnalog * (0.5 + 0.5 * sin(pix.y * 3.14159));
    col += (hash(pix + fract(uTime) * 91.7) - 0.5) * 0.13 * uAnalog;
    col = mix(col, col * vec3(1.05, 1.0, 0.92), uAnalog);
  }
  col *= 1.0 - uVig * smoothstep(0.45, 1.05, sqrt(r2));
  outColor = vec4(col, 1.0);
}`;

const hexRgb = (c: string): [number, number, number] => {
  const m = c.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return [0.6, 0.75, 0.9];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/**
 * Lens / re-projection pass. Draws the renderer's last frame into the true FPV camera with sky behind,
 * barrel distortion, vignette, chromatic aberration, speed blur and an optional analog look.
 */
export class LensPass {
  readonly ok: boolean;
  private gl: WebGL2RenderingContext | null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private sky = { sky: [0.3, 0.55, 0.85], horizon: [0.85, 0.85, 0.8], fog: [0.85, 0.85, 0.8], sun: 1 };

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.ok = !!this.gl && this.init();
    if (!this.ok) canvas.style.display = 'none';
  }

  private init(): boolean {
    const gl = this.gl!;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return false;
    const p = gl.createProgram()!;
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(p)); return false; }
    this.prog = p;
    for (const n of ['uTex', 'uTrue', 'uRend', 'uRes', 'uTanR', 'uD', 'uK', 'uVig', 'uCA', 'uBlur', 'uAnalog', 'uTime', 'uHasTex', 'uSunAmt', 'uSky', 'uHorizon', 'uFog', 'uSun']) {
      this.loc[n] = gl.getUniformLocation(p, n);
    }
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    return true;
  }

  setSky(c: SkyColors) {
    this.sky = { sky: hexRgb(c.sky), horizon: hexRgb(c.horizon), fog: hexRgb(c.fog), sun: c.sun };
  }

  resize(w: number, h: number, dpr: number) {
    const W = Math.max(1, Math.floor(w * dpr)), H = Math.max(1, Math.floor(h * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  /**
   * @param src  the renderer's canvas (its last frame was drawn with `rend`)
   * @param cam  true FPV camera
   * @param rend camera the renderer used
   * @param lens rendered frustum + distortion
   * @param blur radial speed blur amount (0 = none)
   */
  render(src: HTMLCanvasElement | null, cam: CamBasis, rend: CamBasis, lens: Lens, fx: LensFx, blur: number, time: number) {
    const gl = this.gl;
    if (!this.ok || !gl) return;
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.prog);
    const hasTex = !!src && src.width > 0 && src.height > 0;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (hasTex) {
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src!); } catch { /* context lost / tainted */ }
    }
    const L = this.loc;
    const m3 = (b: CamBasis) => new Float32Array([...b.r, ...b.u, ...b.f]);
    gl.uniform1i(L.uTex, 0);
    gl.uniformMatrix3fv(L.uTrue, false, m3(cam));
    gl.uniformMatrix3fv(L.uRend, false, m3(rend));
    gl.uniform2f(L.uRes, W, H);
    gl.uniform2f(L.uTanR, lens.tanY * lens.aspect, lens.tanY);
    gl.uniform1f(L.uD, lens.tanY * Math.hypot(lens.aspect, 1));
    gl.uniform1f(L.uK, lens.k);
    gl.uniform1f(L.uVig, fx.vignette);
    gl.uniform1f(L.uCA, fx.ca);
    gl.uniform1f(L.uBlur, blur);
    gl.uniform1f(L.uAnalog, fx.analog);
    gl.uniform1f(L.uTime, time);
    gl.uniform1f(L.uHasTex, hasTex ? 1 : 0);
    gl.uniform1f(L.uSunAmt, this.sky.sun);
    gl.uniform3fv(L.uSky, this.sky.sky);
    gl.uniform3fv(L.uHorizon, this.sky.horizon);
    gl.uniform3fv(L.uFog, this.sky.fog);
    // sun from the map light: azimuth 225°, 50° above the horizon
    const az = 225 * Math.PI / 180, el = 50 * Math.PI / 180;
    gl.uniform3f(L.uSun, Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
