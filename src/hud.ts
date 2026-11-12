import type { DroneState } from './drone';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** DOM text panels + a full-screen canvas on-screen-display (compass, ladders, horizon). */
export class Hud {
  private canvas = $('osd') as HTMLCanvasElement;
  private ctx = this.canvas.getContext('2d')!;
  private el = {
    loc: $('hud-loc'), lat: $('hud-lat'), lng: $('hud-lng'), clock: $('hud-clock'), mode: $('hud-mode'), fps: $('hud-fps'),
    bat: $('hud-bat'), batFill: $('hud-bat-fill'), agl: $('hud-agl'), msl: $('hud-msl'), vs: $('hud-vs'),
    spd: $('hud-spd'), hdg: $('hud-hdg'), dist: $('hud-dist'), toast: $('toast'), hud: $('hud'),
    thr: $('hud-thr'), thrFill: $('hud-thr-fill'), warn: $('hud-warn'), volt: $('hud-volt'), src: $('hud-src'),
  };
  private lastText = 0;
  private fpsAcc = 0;
  private fpsN = 0;
  private fps = 60;
  private toastTimer = 0;
  private dpr = 1;
  visible = true;

  constructor() {
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(innerWidth * this.dpr);
    this.canvas.height = Math.floor(innerHeight * this.dpr);
    this.canvas.style.width = innerWidth + 'px';
    this.canvas.style.height = innerHeight + 'px';
  }

  setLocation(name: string) { this.el.loc.textContent = name; }

  toast(msg: string, ms = 1800) {
    this.el.toast.textContent = msg;
    this.el.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.el.toast.classList.remove('show'), ms);
  }

  toggle(force?: boolean) {
    this.visible = force ?? !this.visible;
    this.el.hud.classList.toggle('hidden', !this.visible);
    this.canvas.style.display = this.visible ? '' : 'none';
  }

  /** Collision feedback: red edge flash + toast scaled by strength. */
  impact(strength: number) {
    const el = document.getElementById('impact');
    if (el) {
      el.style.transition = 'none';
      el.style.opacity = String(Math.min(0.9, 0.25 + strength));
      void el.offsetWidth;
      el.style.transition = 'opacity 0.6s ease-out';
      el.style.opacity = '0';
    }
    if (strength > 0.25) this.toast(strength > 0.7 ? 'HARD IMPACT' : 'IMPACT', 900);
  }

  setSource(src: 'keyboard' | 'gamepad' | 'touch' | 'none') {
    const rc = src === 'gamepad';
    this.el.src.textContent = rc ? 'RC' : src === 'touch' ? 'TOUCH' : 'KB';
    this.el.src.classList.toggle('rc', rc);
    this.el.src.classList.toggle('dim', !rc);
  }

  update(s: DroneState, dt: number, now: number) {
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc >= 0.5) { this.fps = Math.round(this.fpsN / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0; }
    if (!this.visible) return;
    if (now - this.lastText > 80) {
      this.lastText = now;
      const e = this.el;
      e.lat.textContent = (s.lat >= 0 ? 'N ' : 'S ') + Math.abs(s.lat).toFixed(5);
      e.lng.textContent = (s.lng >= 0 ? 'E ' : 'W ') + Math.abs(s.lng).toFixed(5);
      const t = Math.floor(s.flightTime);
      e.clock.textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      e.mode.textContent = s.boost ? 'TURBO' : 'ACRO';
      e.mode.classList.toggle('sport', s.boost);
      e.fps.textContent = `${this.fps} FPS`;
      e.bat.textContent = `${Math.round(s.battery)}%`;
      e.batFill.style.width = `${Math.max(2, s.battery * 0.9)}%`;
      e.batFill.classList.toggle('low', s.battery < 20);
      e.agl.textContent = fmtAlt(s.alt - s.floor);
      e.msl.textContent = fmtAlt(s.alt);
      const vs = s.vU * Math.min(60, Math.max(1, (s.alt - s.floor) / 150));
      e.vs.textContent = (vs >= 0 ? '+' : '') + vs.toFixed(1);
      e.spd.textContent = fmtSpd(s.groundSpeed * 3.6);
      e.hdg.textContent = String(Math.round(s.heading) % 360).padStart(3, '0');
      e.dist.textContent = (s.distance / 1000).toFixed(s.distance < 100_000 ? 2 : 0);
      const thr = Math.round(Math.min(100, Math.max(0, 50 + s.stick.throttle * 50)));
      e.thr.textContent = `${thr}%`;
      e.thrFill.style.height = `${thr}%`;
      e.volt.textContent = (14.2 + (s.battery / 100) * 2.6 - s.motor * 0.4).toFixed(1) + 'V';
      e.warn.textContent = s.battery < 15 ? 'LAND NOW' : s.battery < 25 ? 'LOW BATTERY' : '';
      e.warn.classList.toggle('danger', s.battery < 25);
    }
    this.drawOSD(s);
  }

  private drawOSD(s: DroneState) {
    const ctx = this.ctx;
    const W = innerWidth, H = innerHeight;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const compact = W < 720;
    const accent = 'rgba(255,255,255,0.95)';
    const dim = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1.2;
    ctx.font = '600 11px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 3;

    // ---- corner brackets ----
    const m = compact ? 10 : 18, L = compact ? 18 : 30;
    ctx.strokeStyle = 'rgba(232,241,242,0.35)';
    ctx.beginPath();
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const x = sx > 0 ? m : W - m, y = sy > 0 ? m : H - m;
      ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y);
    }
    ctx.stroke();

    // ---- compass tape (top center) ----
    const cx = W / 2;
    const tapeW = compact ? W * 0.6 : Math.min(W * 0.46, 480), tapeY = compact ? 96 : 34;
    const pxPerDeg = tapeW / 90;
    ctx.save();
    ctx.beginPath(); ctx.rect(cx - tapeW / 2, tapeY - 24, tapeW, 50); ctx.clip();
    const grad = ctx.createLinearGradient(cx - tapeW / 2, 0, cx + tapeW / 2, 0);
    grad.addColorStop(0, 'rgba(232,241,242,0)'); grad.addColorStop(0.15, 'rgba(232,241,242,1)');
    grad.addColorStop(0.85, 'rgba(232,241,242,1)'); grad.addColorStop(1, 'rgba(232,241,242,0)');
    ctx.strokeStyle = grad; ctx.fillStyle = grad;
    ctx.textAlign = 'center';
    const start = Math.floor((s.heading - 50) / 5) * 5;
    for (let d = start; d <= s.heading + 50; d += 5) {
      const x = cx + (d - s.heading) * pxPerDeg;
      const big = d % 30 === 0;
      ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.moveTo(x, tapeY + 10); ctx.lineTo(x, tapeY + (big ? 0 : 6)); ctx.stroke();
      if (big) {
        const n = ((d % 360) + 360) % 360;
        const lbl = n === 0 ? 'N' : n === 90 ? 'E' : n === 180 ? 'S' : n === 270 ? 'W' : String(n);
        ctx.font = (lbl.length === 1 ? '700 13px' : '500 11px') + ' "JetBrains Mono", monospace';
        ctx.fillText(lbl, x, tapeY - 10);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    // heading box
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.strokeStyle = accent;
    roundRect(ctx, cx - 26, tapeY + 14, 52, 20, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = accent; ctx.font = '700 13px "JetBrains Mono", monospace'; ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(s.heading) % 360).padStart(3, '0') + '°', cx, tapeY + 24);
    ctx.beginPath(); ctx.moveTo(cx, tapeY + 13); ctx.lineTo(cx - 5, tapeY + 8); ctx.lineTo(cx + 5, tapeY + 8); ctx.closePath(); ctx.fill();

    // ---- ladders (left speed, right altitude) ----
    if (!compact) {
      const ladderH = Math.min(H * 0.42, 340), ly = H / 2;
      drawLadder(ctx, W * 0.14, ly, ladderH, s.groundSpeed * 3.6, 'km/h', true, ladderStep(s.groundSpeed * 3.6));
      drawLadder(ctx, W * 0.86, ly, ladderH, s.alt - s.floor, 'm AGL', false, ladderStep(s.alt - s.floor));
    }

    // ---- artificial horizon + crosshair (center) ----
    const cy = H / 2;
    const horizonDeg = 90 - s.camPitch; // degrees camera looks below the horizon
    const pxPerDegH = Math.min(H, W) / 70;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-s.roll * Math.PI / 180);
    const span = Math.min(W, H) * 0.22;
    ctx.strokeStyle = 'rgba(232,241,242,0.7)'; ctx.fillStyle = dim; ctx.font = '500 10px "JetBrains Mono", monospace';
    for (let p = -30; p <= 30; p += 10) {
      const y = (horizonDeg + p) * pxPerDegH * -1; // positive pitch lines (above camera axis) go up
      if (Math.abs(y) > H * 0.4) continue;
      const w = p === 0 ? span * 1.6 : span * (p % 20 === 0 ? 0.6 : 0.4);
      ctx.globalAlpha = p === 0 ? 0.9 : 0.5;
      ctx.beginPath();
      if (p === 0) { ctx.moveTo(-w, y); ctx.lineTo(-span * 0.35, y); ctx.moveTo(span * 0.35, y); ctx.lineTo(w, y); }
      else { ctx.moveTo(-w, y); ctx.lineTo(-span * 0.25, y); ctx.moveTo(span * 0.25, y); ctx.lineTo(w, y); }
      ctx.stroke();
      if (p !== 0) { ctx.textAlign = 'right'; ctx.fillText(String(-p), -w - 6, y); ctx.textAlign = 'left'; ctx.fillText(String(-p), w + 6, y); }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    // crosshair
    ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 22, cy); ctx.lineTo(cx - 8, cy); ctx.moveTo(cx + 8, cy); ctx.lineTo(cx + 22, cy);
    ctx.moveTo(cx, cy - 16); ctx.lineTo(cx, cy - 6); ctx.moveTo(cx, cy + 6); ctx.lineTo(cx, cy + 16);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.fillStyle = accent; ctx.fill();
    // roll indicator arc
    ctx.strokeStyle = 'rgba(232,241,242,0.35)'; ctx.lineWidth = 1;
    const rr = Math.min(W, H) * 0.3;
    ctx.beginPath(); ctx.arc(cx, cy, rr, Math.PI * 1.25, Math.PI * 1.75); ctx.stroke();
    const ra = -Math.PI / 2 - s.roll * Math.PI / 180;
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(ra) * rr, cy + Math.sin(ra) * rr); ctx.lineTo(cx + Math.cos(ra - 0.03) * (rr + 10), cy + Math.sin(ra - 0.03) * (rr + 10)); ctx.lineTo(cx + Math.cos(ra + 0.03) * (rr + 10), cy + Math.sin(ra + 0.03) * (rr + 10)); ctx.closePath(); ctx.fill();

    // ---- speed scale badge ----
    if (s.scale > 1.05) {
      ctx.fillStyle = 'rgba(255,209,102,0.85)'; ctx.font = '600 11px "JetBrains Mono", monospace'; ctx.textAlign = 'center';
      ctx.fillText(`×${s.scale.toFixed(s.scale < 10 ? 1 : 0)} ALT SPEED`, cx, cy + rr + 26);
    }
  }
}

function ladderStep(v: number) { return v < 100 ? 10 : v < 1000 ? 50 : v < 10000 ? 500 : 5000; }

function drawLadder(ctx: CanvasRenderingContext2D, x: number, cy: number, h: number, value: number, unit: string, left: boolean, step: number) {
  const pxPerUnit = h / (step * 8);
  const dir = left ? 1 : -1;
  ctx.save();
  ctx.beginPath(); ctx.rect(x - 70, cy - h / 2, 140, h); ctx.clip();
  const g = ctx.createLinearGradient(0, cy - h / 2, 0, cy + h / 2);
  g.addColorStop(0, 'rgba(232,241,242,0)'); g.addColorStop(0.2, 'rgba(232,241,242,0.8)'); g.addColorStop(0.8, 'rgba(232,241,242,0.8)'); g.addColorStop(1, 'rgba(232,241,242,0)');
  ctx.strokeStyle = g; ctx.fillStyle = g; ctx.lineWidth = 1;
  ctx.font = '500 11px "JetBrains Mono", monospace';
  ctx.textAlign = left ? 'left' : 'right';
  const first = Math.floor((value - step * 5) / step) * step;
  for (let v = first; v <= value + step * 5; v += step) {
    if (v < 0) continue;
    const y = cy + (value - v) * pxPerUnit;
    const major = Math.round(v / step) % 2 === 0;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dir * (major ? 10 : 5), y); ctx.stroke();
    if (major) ctx.fillText(String(v), x + dir * 16, y);
  }
  ctx.restore();
  // current value box
  const bw = 66, bh = 22;
  const bx = left ? x - bw - 8 : x + 8;
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.2;
  roundRect(ctx, bx, cy - bh / 2, bw, bh, 4); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.font = '700 13px "JetBrains Mono", monospace'; ctx.textAlign = 'center';
  ctx.fillText(value < 1000 ? String(Math.round(value)) : (value / 1000).toFixed(1) + 'k', bx + bw / 2, cy);
  ctx.beginPath();
  if (left) { ctx.moveTo(x - 8, cy); ctx.lineTo(x - 2, cy - 4); ctx.lineTo(x - 2, cy + 4); } else { ctx.moveTo(x + 8, cy); ctx.lineTo(x + 2, cy - 4); ctx.lineTo(x + 2, cy + 4); }
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '500 9px "JetBrains Mono", monospace';
  ctx.fillText(unit.toUpperCase(), bx + bw / 2, cy - bh / 2 - 8);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

function fmtAlt(m: number) { return m < 10_000 ? String(Math.round(m)) : (m / 1000).toFixed(1) + 'k'; }
function fmtSpd(kmh: number) { return kmh < 10_000 ? String(Math.round(kmh)) : (kmh / 1000).toFixed(1) + 'k'; }
