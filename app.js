/* ═══════════════════════════════════════════════════════════════
   MAP TRAILER — NEON PATH STUDIO
   Core Application Logic
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ─────────────────────────────────────────────
   STATE
───────────────────────────────────────────── */
const state = {
    pins: [],            // Array of { id, latlng, name, videoFile, videoURL, marker }
    addingPin: false,
    isTourPlaying: false,
    tourIndex: 0,
    animFrame: null,
    pathAnimT: 0,        // 0–1 animated draw progress
    visitedPins: new Set(), // set of pin ids reached during tour
    activeTourPinId: null,  // the pin currently being shown in callout
};

/* ─────────────────────────────────────────────
   HUD ARROW GEOMETRY CONSTANTS
   (must match in both canvas drawHudArrow and HTML _calloutBoxPos)
───────────────────────────────────────────── */
const HUD = {
    STUB: 16,   // short horizontal stub from pin
    DIAG_DX: 44,   // horizontal component of diagonal line
    DIAG_DY: 52,   // vertical component (upward)
    HORIZ: 38,   // final horizontal segment
    PIN_Y: 18,   // how far above pin center to start the line
};

/* ─────────────────────────────────────────────
   MAP INIT — CartoDB Dark Matter (no API key)
───────────────────────────────────────────── */
const map = L.map('map', {
    center: [20.5937, 78.9629],   // India center default
    zoom: 5,
    zoomControl: false,
    attributionControl: true,
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/" target="_blank">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
    subdomains: 'abcd',
    maxZoom: 20,
}).addTo(map);

L.control.zoom({ position: 'bottomright' }).addTo(map);

/* ─────────────────────────────────────────────
   CANVAS OVERLAY — Glowing Red→Blue gradient path
───────────────────────────────────────────── */
const canvas = document.getElementById('pathCanvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', () => { resizeCanvas(); drawPath(); });

map.on('move zoom viewreset', () => drawPath());

function latLngToCanvas(ll) {
    const p = map.latLngToContainerPoint(ll);
    return { x: p.x, y: p.y };
}

function drawPath(overrideT = null) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const t = overrideT !== null ? overrideT : 1;

    // Draw path only if 2+ pins
    if (state.pins.length >= 2) {
        const points = state.pins.map(p => latLngToCanvas(p.latlng));
        const curves = _buildCurves(points);          // array of {p0,cp,p1} bezier segments
        const totalLen = _curveSetLength(curves);

        if (totalLen >= 1) {
            // 3-layer glow
            _drawCurvePath(curves, t, totalLen, 26, 0.08);
            _drawCurvePath(curves, t, totalLen, 12, 0.22);
            _drawCurvePath(curves, t, totalLen, 3, 0.92);

            // Animated comet head during draw animation
            if (overrideT !== null && overrideT < 1 && overrideT > 0) {
                const headPos = _getCurvePositionAtT(curves, totalLen, t);
                if (headPos) drawCometHead(headPos.x, headPos.y);
            }
        }
    }

    // Draw pin rings + callouts
    state.pins.forEach((pin, i) => {
        const pt = latLngToCanvas(pin.latlng);
        drawPinRing(pt.x, pt.y, i);

        if (!state.isTourPlaying) {
            // Static editor view — show all callouts
            drawPinCallout(pt.x, pt.y, i, pin);
        } else if (pin.id === state.activeTourPinId) {
            // Active tour pin — draw HUD arrow pointing to where the HTML box actually is
            const neonColors = ['#ff4d6d', '#a855f7', '#247bff', '#22d3ee', '#f472b6'];
            const boxPos = _calloutBoxPos(pt.x, pt.y, i);
            const boxW = 270;
            drawHudArrow(pt.x, pt.y, i, neonColors[i % neonColors.length], boxPos, boxW);
        } else if (state.visitedPins.has(pin.id)) {
            // Already visited — show dimmed static callout
            ctx.save();
            ctx.globalAlpha = 0.45;
            drawPinCallout(pt.x, pt.y, i, pin);
            ctx.restore();
        }
        // Not yet visited — show nothing
    });
}


/* ── Build quadratic bezier control points for each segment ──────────────
   The control point is lifted perpendicularly above the midpoint by
   20% of the segment length, giving a gentle upward arc.               */
function _buildCurves(points) {
    const curves = [];
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i];
        const p1 = points[i + 1];
        const mx = (p0.x + p1.x) / 2;
        const my = (p0.y + p1.y) / 2;
        // Perpendicular direction (rotated 90°)
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        const arcHeight = Math.min(len * 0.22, 120); // cap arc height
        const nx = -dy / len;  // unit normal x
        const ny = dx / len;  // unit normal y
        const cp = { x: mx + nx * arcHeight, y: my + ny * arcHeight };
        curves.push({ p0, cp, p1 });
    }
    return curves;
}

/* Approximate arc length of a single quadratic bezier by sampling */
function _bezierLength(p0, cp, p1, steps = 20) {
    let len = 0;
    let prev = p0;
    for (let s = 1; s <= steps; s++) {
        const tt = s / steps;
        const x = (1 - tt) * (1 - tt) * p0.x + 2 * (1 - tt) * tt * cp.x + tt * tt * p1.x;
        const y = (1 - tt) * (1 - tt) * p0.y + 2 * (1 - tt) * tt * cp.y + tt * tt * p1.y;
        const ddx = x - prev.x, ddy = y - prev.y;
        len += Math.sqrt(ddx * ddx + ddy * ddy);
        prev = { x, y };
    }
    return len;
}

function _curveSetLength(curves) {
    return curves.reduce((acc, c) => acc + _bezierLength(c.p0, c.cp, c.p1), 0);
}

/* Draw the bezier path set up to animation parameter t (0–1) */
function _drawCurvePath(curves, t, totalLen, lineWidth, alpha) {
    const targetDist = totalLen * t;
    let distDrawn = 0;

    // Gradient from first to last point
    const allPts = [curves[0].p0, ...curves.map(c => c.p1)];
    const xs = allPts.map(p => p.x), ys = allPts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const grad = ctx.createLinearGradient(minX, minY, maxX, maxY);
    grad.addColorStop(0, `rgba(255, 77, 109, ${alpha})`);
    grad.addColorStop(0.5, `rgba(168, 85, 247, ${alpha})`);
    grad.addColorStop(1, `rgba(36, 123, 255, ${alpha})`);

    ctx.beginPath();
    ctx.moveTo(curves[0].p0.x, curves[0].p0.y);

    for (const curve of curves) {
        const segLen = _bezierLength(curve.p0, curve.cp, curve.p1);

        if (distDrawn + segLen > targetDist) {
            // Partially draw this bezier segment
            const ratio = (targetDist - distDrawn) / segLen;
            _appendPartialBezier(curve.p0, curve.cp, curve.p1, ratio);
            break;
        } else {
            ctx.quadraticCurveTo(curve.cp.x, curve.cp.y, curve.p1.x, curve.p1.y);
            distDrawn += segLen;
        }
    }

    ctx.strokeStyle = grad;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
}

/* Append a partial quadratic bezier (De Casteljau subdivision) */
function _appendPartialBezier(p0, cp, p1, ratio) {
    // De Casteljau: split bezier at ratio, take the first sub-curve
    const q0x = p0.x + (cp.x - p0.x) * ratio;
    const q0y = p0.y + (cp.y - p0.y) * ratio;
    const q1x = cp.x + (p1.x - cp.x) * ratio;
    const q1y = cp.y + (p1.y - cp.y) * ratio;
    const mx = q0x + (q1x - q0x) * ratio;
    const my = q0y + (q1y - q0y) * ratio;
    ctx.quadraticCurveTo(q0x, q0y, mx, my);
}

/* Get canvas position at t (0–1) along the full bezier curve set */
function _getCurvePositionAtT(curves, totalLen, t) {
    const target = totalLen * t;
    let dist = 0;
    for (const curve of curves) {
        const segLen = _bezierLength(curve.p0, curve.cp, curve.p1);
        if (dist + segLen >= target) {
            const ratio = (target - dist) / segLen;
            const tt = ratio;
            const x = (1 - tt) * (1 - tt) * curve.p0.x + 2 * (1 - tt) * tt * curve.cp.x + tt * tt * curve.p1.x;
            const y = (1 - tt) * (1 - tt) * curve.p0.y + 2 * (1 - tt) * tt * curve.cp.y + tt * tt * curve.p1.y;
            return { x, y };
        }
        dist += segLen;
    }
    return curves[curves.length - 1].p1;
}


function drawCometHead(x, y) {
    // Outer glow
    const grd = ctx.createRadialGradient(x, y, 0, x, y, 28);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.15, 'rgba(200,160,255,0.8)');
    grd.addColorStop(0.4, 'rgba(36,123,255,0.5)');
    grd.addColorStop(1, 'rgba(36,123,255,0)');
    ctx.beginPath();
    ctx.arc(x, y, 28, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    // Core dot
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
}

function drawPinRing(x, y, index) {
    const colors = [
        ['rgba(255,77,109,0.8)', 'rgba(255,77,109,0.2)'],
        ['rgba(168,85,247,0.8)', 'rgba(168,85,247,0.2)'],
        ['rgba(36,123,255,0.8)', 'rgba(36,123,255,0.2)'],
    ];
    const [innerC, outerC] = colors[index % colors.length];

    // Pulse ring
    const pulseSize = 18 + (Math.sin(Date.now() * 0.004 + index) * 4);
    ctx.beginPath();
    ctx.arc(x, y, pulseSize, 0, Math.PI * 2);
    ctx.strokeStyle = outerC;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.strokeStyle = innerC;
    ctx.lineWidth = 2.5;
    ctx.stroke();
}

/* ── Static pin callout label (editor/post-visit view) ── */
function drawPinCallout(x, y, index, pin) {
    const neonColors = ['#ff4d6d', '#a855f7', '#247bff', '#22d3ee', '#f472b6'];
    const color = neonColors[index % neonColors.length];
    const goRight = (index % 2 === 1);
    const labelW = 148;
    const labelH = 34;

    // Simple diagonal + horiz leader line
    const diagX = goRight ? x + 38 : x - 38;
    const diagY = y - 42;
    const horizX = goRight ? diagX + 36 : diagX - 36;

    ctx.beginPath();
    ctx.moveTo(x, y - 14);
    ctx.lineTo(diagX, diagY);
    ctx.lineTo(horizX, diagY);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.stroke();

    // Dot at pin
    ctx.beginPath();
    ctx.arc(x, y - 14, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Box below horiz end
    const boxX = goRight ? horizX : horizX - labelW;
    const boxY = diagY + 4;

    ctx.save();
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = 'rgba(6,13,24,0.85)';
    _roundRect(ctx, boxX, boxY, labelW, labelH, 6);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    _roundRect(ctx, boxX, boxY, labelW, labelH, 6);
    ctx.stroke();
    ctx.restore();

    // Badge
    const cy2 = boxY + labelH / 2;
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(boxX + 14, cy2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px Inter,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(index + 1, boxX + 14, cy2);
    ctx.restore();

    // Name
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#e8f0ff';
    ctx.font = '500 11px Inter,sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText((pin.name || 'Stopover').slice(0, 16), boxX + 28, cy2);
    ctx.restore();
}

/* ──────────────────────────────────────────────────────────────────
   HUD ARROW — sci-fi style leader line drawn on canvas during tour.
   The HTML .pvo video box sits at the endpoint of this arrow.
   Geometry constants come from the HUD object defined at the top.
   goRight → arrow goes right;  goLeft → goes left.
────────────────────────────────────────────────────────────────── */
function drawHudArrow(x, y, index, color, boxPos, boxW) {
    const goRight = (index % 2 === 1);
    const dir = goRight ? 1 : -1;

    // Pin origin
    const startX = x;
    const startY = y - HUD.PIN_Y;

    // Target: top-left or top-right corner of the HTML box
    const targetX = goRight ? boxPos.x : boxPos.x + boxW;
    const targetY = boxPos.y + 8;  // 8px down from top edge of box

    // Midpoint: create a short horizontal stub from pin, then diagonal to box
    const stubX = startX + dir * HUD.STUB;
    const stubY = startY;
    // Junction point: same height as target, to create the angular HUD knee
    const kneeX = targetX - dir * 24;  // 24px before the box edge horizontally
    const kneeY = targetY;

    ctx.save();
    ctx.setLineDash([]);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'miter';

    // ── Outer glow pass ──
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(stubX, stubY);
    ctx.lineTo(kneeX, kneeY);
    ctx.lineTo(targetX, targetY);
    ctx.strokeStyle = color + '44';
    ctx.lineWidth = 7;
    ctx.stroke();

    // ── Main line ──
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(stubX, stubY);
    ctx.lineTo(kneeX, kneeY);
    ctx.lineTo(targetX, targetY);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // ── HUD tick marks on the diagonal segment ──
    const ddx = kneeX - stubX, ddy = kneeY - stubY;
    const dLen = Math.sqrt(ddx * ddx + ddy * ddy);
    if (dLen > 0) {
        const nx = -ddy / dLen, ny = ddx / dLen;
        const midDX = (stubX + kneeX) / 2;
        const midDY = (stubY + kneeY) / 2;
        const tickLen = 5;
        // Tick 1
        ctx.beginPath();
        ctx.moveTo(midDX + nx * tickLen, midDY + ny * tickLen);
        ctx.lineTo(midDX - nx * tickLen, midDY - ny * tickLen);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // Tick 2 — slightly offset along diagonal
        const off = 9;
        const offX = midDX + off * (ddx / dLen);
        const offY = midDY + off * (ddy / dLen);
        ctx.beginPath();
        ctx.moveTo(offX + nx * (tickLen * 0.6), offY + ny * (tickLen * 0.6));
        ctx.lineTo(offX - nx * (tickLen * 0.6), offY - ny * (tickLen * 0.6));
        ctx.stroke();
    }

    // ── Origin circle (hollow outer + filled inner) ──
    ctx.beginPath();
    ctx.arc(startX, startY, 7, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(startX, startY, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 1;
    ctx.fill();

    // ── Corner bracket at box entry point ──
    const bk = 9;
    ctx.beginPath();
    ctx.moveTo(targetX, targetY - bk);
    ctx.lineTo(targetX, targetY);
    ctx.lineTo(targetX + dir * bk, targetY);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 1;
    ctx.stroke();

    // ── Arrowhead pointing into the box ──
    const aLen = 9, aAngle = Math.PI / 5;
    const aDir = goRight ? 0 : Math.PI;
    ctx.beginPath();
    ctx.moveTo(targetX, targetY);
    ctx.lineTo(targetX - Math.cos(aDir - aAngle) * aLen, targetY - Math.sin(aDir - aAngle) * aLen);
    ctx.moveTo(targetX, targetY);
    ctx.lineTo(targetX - Math.cos(aDir + aAngle) * aLen, targetY - Math.sin(aDir + aAngle) * aLen);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.restore();
}

/* Helper: rounded rect path (no fill/stroke — caller does that) */
function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

/* Continuous pulse animation for rings */
function pulseLoop() {
    if (state.pins.length > 0 && !state.isTourPlaying) {
        drawPath(1); // fully drawn, static
    }
    requestAnimationFrame(pulseLoop);
}
pulseLoop();

/* ─────────────────────────────────────────────
   PIN MANAGEMENT
───────────────────────────────────────────── */
function createPinId() { return 'pin_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

/** Create a custom SVG marker icon */
function createPinMarkerIcon(index) {
    const colors = ['#ff4d6d', '#a855f7', '#247bff', '#22d3ee', '#f472b6'];
    const color = colors[index % colors.length];
    const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="42" viewBox="0 0 32 42">
      <defs>
        <filter id="glow_${index}">
          <feGaussianBlur stdDeviation="3" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <path d="M16 0C7.163 0 0 7.163 0 16c0 9.941 16 26 16 26S32 25.941 32 16C32 7.163 24.837 0 16 0z"
            fill="${color}" filter="url(#glow_${index})" opacity="0.9"/>
      <circle cx="16" cy="16" r="7" fill="white" opacity="0.9"/>
      <text x="16" y="20.5" text-anchor="middle" 
            font-family="-apple-system,SF Pro,Inter,sans-serif" 
            font-size="10" font-weight="700" fill="${color}">${index + 1}</text>
    </svg>`;
    return L.divIcon({
        html: svg,
        iconSize: [32, 42],
        iconAnchor: [16, 42],
        popupAnchor: [0, -42],
        className: 'neon-pin-icon',
    });
}

function addPin(latlng) {
    const id = createPinId();
    const index = state.pins.length;

    const marker = L.marker(latlng, {
        icon: createPinMarkerIcon(index),
        draggable: true,
    }).addTo(map);

    marker.on('dragend', e => {
        const pin = state.pins.find(p => p.id === id);
        if (pin) {
            pin.latlng = e.target.getLatLng();
            drawPath();
        }
    });

    marker.on('click', () => {
        if (!state.isTourPlaying) {
            const pin = state.pins.find(p => p.id === id);
            openModal(pin);
        }
    });

    const pin = { id, latlng, name: `Stopover ${index + 1}`, videoFile: null, videoURL: null, marker };
    state.pins.push(pin);

    renderPinList();
    drawPath();
    updatePinCount();
}

function removePin(id) {
    const idx = state.pins.findIndex(p => p.id === id);
    if (idx === -1) return;
    const [pin] = state.pins.splice(idx, 1);
    map.removeLayer(pin.marker);
    if (pin.videoURL) URL.revokeObjectURL(pin.videoURL);
    // Re-index remaining markers
    state.pins.forEach((p, i) => p.marker.setIcon(createPinMarkerIcon(i)));
    renderPinList();
    drawPath();
    updatePinCount();
}

function updatePinCount() {
    const n = state.pins.length;
    document.getElementById('pinCount').textContent = `${n} pin${n !== 1 ? 's' : ''}`;
}

/* ─────────────────────────────────────────────
   SIDEBAR / PIN LIST
───────────────────────────────────────────── */
function renderPinList() {
    const list = document.getElementById('pinList');
    list.innerHTML = '';

    if (state.pins.length === 0) {
        list.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".4">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
          <circle cx="12" cy="9" r="2.5"/>
        </svg>
        <p>Click <strong>Add Pin</strong> then<br>click on the map</p>
      </div>`;
        return;
    }

    state.pins.forEach((pin, i) => {
        const card = document.createElement('div');
        card.className = 'pin-card';
        card.dataset.id = pin.id;

        card.innerHTML = `
      <div class="pin-card-header">
        <div class="pin-number">${i + 1}</div>
        <input class="pin-name-input" type="text" value="${pin.name}" placeholder="Stopover name…" />
        <button class="pin-delete" data-id="${pin.id}" title="Remove pin">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="pin-video-row">
        <div class="pin-video-label">
          ${pin.videoFile
                ? `<div class="pin-video-filename">🎬 ${pin.videoFile.name}</div>`
                : `<div class="pin-video-placeholder">No video attached</div>`
            }
        </div>
        <label class="pin-video-btn" style="cursor:pointer">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          ${pin.videoFile ? 'Change' : 'Upload'}
          <input type="file" accept="video/mp4,video/*" style="display:none" data-id="${pin.id}" />
        </label>
      </div>`;

        // Name update
        card.querySelector('.pin-name-input').addEventListener('input', e => {
            pin.name = e.target.value;
        });

        // Delete button
        card.querySelector('.pin-delete').addEventListener('click', e => {
            e.stopPropagation();
            removePin(pin.id);
        });

        // Video upload
        card.querySelector('input[type="file"]').addEventListener('change', e => {
            const file = e.target.files[0];
            if (!file) return;
            if (pin.videoURL) URL.revokeObjectURL(pin.videoURL);
            pin.videoFile = file;
            pin.videoURL = URL.createObjectURL(file);
            renderPinList();
        });

        // Fly to pin on card click
        card.addEventListener('click', e => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'LABEL') return;
            map.flyTo(pin.latlng, Math.max(map.getZoom(), 14), { duration: 1.2 });
        });

        list.appendChild(card);
    });
}

/* ─────────────────────────────────────────────
   ADD-PIN MODE
───────────────────────────────────────────── */
const btnAddPin = document.getElementById('btnAddPin');
const mapNotice = document.getElementById('mapNotice');

function setAddingPin(val) {
    state.addingPin = val;
    document.body.classList.toggle('adding-pin', val);
    mapNotice.style.display = val ? 'flex' : 'none';
    btnAddPin.style.background = val ? 'rgba(255,77,109,.15)' : '';
    btnAddPin.style.borderColor = val ? 'rgba(255,77,109,.4)' : '';
    btnAddPin.style.color = val ? '#ff4d6d' : '';
}

btnAddPin.addEventListener('click', () => setAddingPin(!state.addingPin));

map.on('click', e => {
    if (!state.addingPin) return;
    addPin(e.latlng);
    setAddingPin(false);
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        if (state.addingPin) setAddingPin(false);
        if (modalBackdrop.classList.contains('open')) closeModal(false);
    }
});

/* Clear all */
document.getElementById('btnClearAll').addEventListener('click', () => {
    if (state.isTourPlaying) stopTour();
    [...state.pins].forEach(p => {
        map.removeLayer(p.marker);
        if (p.videoURL) URL.revokeObjectURL(p.videoURL);
    });
    state.pins = [];
    renderPinList();
    drawPath();
    updatePinCount();
});

/* ─────────────────────────────────────────────
   VIDEO MODAL
───────────────────────────────────────────── */
const modalBackdrop = document.getElementById('modalBackdrop');
const modalVideo = document.getElementById('modalVideo');
const videoPlaceholder = document.getElementById('videoPlaceholder');
const modalPinName = document.getElementById('modalPinName');
const modalCoords = document.getElementById('modalCoords');

let _modalResolve = null; // promise resolver for tour awaiting modal close

function openModal(pin, autoPlayAndClose = false) {
    return new Promise(resolve => {
        _modalResolve = resolve;

        modalPinName.textContent = pin.name || 'Stopover';
        modalCoords.textContent = `${pin.latlng.lat.toFixed(5)}, ${pin.latlng.lng.toFixed(5)}`;

        if (pin.videoURL) {
            modalVideo.src = pin.videoURL;
            modalVideo.style.display = 'block';
            videoPlaceholder.style.display = 'none';
            if (autoPlayAndClose) {
                modalVideo.play().catch(() => { });
                // Auto-close: 5s timer OR video end, whichever comes first
                const autoClose = setTimeout(() => closeModal(true), 5000);
                modalVideo.addEventListener('ended', () => {
                    clearTimeout(autoClose);
                    closeModal(true);
                }, { once: true });
            }
        } else {
            modalVideo.src = '';
            modalVideo.style.display = 'none';
            videoPlaceholder.style.display = 'flex';
            // No video — auto-close after 3s so tour continues
            if (autoPlayAndClose) {
                setTimeout(() => closeModal(true), 3000);
            }
        }

        // GSAP spring-in animation
        modalBackdrop.classList.add('open');
        gsap.fromTo(document.getElementById('videoModal'),
            { scale: 0.88, y: 40, opacity: 0 },
            { scale: 1, y: 0, opacity: 1, duration: 0.45, ease: 'back.out(1.7)' });
    });
}

function closeModal(resolveNext = false) {
    gsap.to(document.getElementById('videoModal'), {
        scale: 0.9, y: 30, opacity: 0, duration: 0.28, ease: 'power2.in',
        onComplete: () => {
            modalBackdrop.classList.remove('open');
            modalVideo.pause();
            modalVideo.src = '';
            if (resolveNext && _modalResolve) {
                const res = _modalResolve;
                _modalResolve = null;
                res();
            }
        }
    });
}

document.getElementById('modalClose').addEventListener('click', () => closeModal(true));
document.getElementById('modalSkip').addEventListener('click', () => closeModal(true));
modalBackdrop.addEventListener('click', e => {
    if (e.target === modalBackdrop) closeModal(true);
});

/* ─────────────────────────────────────────────
   PATH ANIMATION — slow, eased draw (0 → 1)
───────────────────────────────────────────── */
function animatePath(onComplete) {
    state.pathAnimT = 0;
    const duration = 8000; // ms — slow, cinematic
    const start = performance.now();

    // Cubic ease-in-out: slow start → faster middle → slow land
    function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function frame(now) {
        const linear = Math.min((now - start) / duration, 1);
        state.pathAnimT = easeInOutCubic(linear);
        drawPath(state.pathAnimT);
        if (linear < 1) {
            requestAnimationFrame(frame);
        } else {
            state.pathAnimT = 1;
            drawPath(1);
            if (onComplete) onComplete();
        }
    }
    requestAnimationFrame(frame);
}

/* ─────────────────────────────────────────────
   PIN VIDEO OVERLAY — plays video at callout box
───────────────────────────────────────────── */
const _neonColors = ['#ff4d6d', '#a855f7', '#247bff', '#22d3ee', '#f472b6'];
const _pvoEl = document.getElementById('pinVideoOverlay');
const _pvoVideo = document.getElementById('pvoVideo');
const _pvoBadge = document.getElementById('pvoBadge');
const _pvoName = document.getElementById('pvoName');
const _pvoCoords = document.getElementById('pvoCoords');
const _pvoFill = document.getElementById('pvoProgressFill');
const _pvoNoVid = document.getElementById('pvoNoVideo');
let _pvoDone = null;      // callback to skip the current video
let _pvoTimer = null;     // progress animation frame id
let _pvoPin = null;     // pin currently shown
let _pvoPinIdx = 0;

/** Place .pvo box BELOW+SIDE of pin — always near pin regardless of zoom/pan */
function _calloutBoxPos(cx, cy, index) {
    const BOX_W = 270;  // must match .pvo CSS width
    const BOX_H = 200;  // approx box height (header + 16/9 video + coords)
    const DY = 55;   // vertical offset below pin center
    const DX = 20;   // horizontal offset from pin center

    // Prefer right side for odd pins, left for even
    let goRight = (index % 2 === 1);

    // Flip if preferred side would overflow viewport
    let boxX = goRight ? cx + DX : cx - DX - BOX_W;
    if (boxX < 8) { goRight = true; boxX = cx + DX; }
    if (boxX + BOX_W > window.innerWidth - 8) { goRight = false; boxX = cx - DX - BOX_W; }

    // Vertical: below pin; if not enough space below, go above
    let boxY = cy + DY;
    if (boxY + BOX_H > window.innerHeight - 8) boxY = cy - DY - BOX_H;

    return {
        x: Math.max(8, Math.min(boxX, window.innerWidth - BOX_W - 8)),
        y: Math.max(56, Math.min(boxY, window.innerHeight - BOX_H - 8)),
    };
}

function _repositionPVO() {
    if (_pvoEl.style.display === 'none' || !_pvoPin) return;
    const pt = map.latLngToContainerPoint(_pvoPin.latlng);
    const pos = _calloutBoxPos(pt.x, pt.y, _pvoPinIdx);
    _pvoEl.style.left = pos.x + 'px';
    _pvoEl.style.top = pos.y + 'px';
}
map.on('move zoom', _repositionPVO);

/** Open video overlay at the pin's callout position */
function openPinVideo(pin, index) {
    return new Promise(resolve => {
        _pvoPin = pin;
        _pvoPinIdx = index;

        // Mark pin reached — canvas draws HUD arrow for this pin
        state.visitedPins.add(pin.id);
        state.activeTourPinId = pin.id;
        drawPath(1);

        const color = _neonColors[index % _neonColors.length];

        // Header
        _pvoBadge.textContent = index + 1;
        _pvoBadge.style.background = color;
        _pvoBadge.style.boxShadow = `0 0 12px ${color}99`;
        _pvoName.textContent = pin.name || 'Stopover';
        _pvoCoords.textContent = `${pin.latlng.lat.toFixed(5)}, ${pin.latlng.lng.toFixed(5)}`;

        // HUD border color
        _pvoEl.style.setProperty('--hud-color', color);
        _pvoEl.style.borderColor = color + '66';
        _pvoEl.style.boxShadow = `0 0 0 1px ${color}33, 0 12px 40px rgba(0,0,0,.8), 0 0 30px ${color}18`;

        // Video
        if (pin.videoURL) {
            _pvoVideo.src = pin.videoURL;
            _pvoVideo.style.display = 'block';
            _pvoNoVid.style.display = 'none';
        } else {
            _pvoVideo.src = '';
            _pvoVideo.style.display = 'none';
            _pvoNoVid.style.display = 'flex';
        }
        _pvoFill.style.width = '0%';
        _pvoFill.style.background = `linear-gradient(90deg, ${color}, var(--neon-blue))`;

        // Position — anchored to HUD arrow tip
        _repositionPVO();

        // Animate in
        _pvoEl.style.display = 'flex';
        gsap.fromTo(_pvoEl,
            { scaleX: 0.6, scaleY: 0.8, opacity: 0 },
            {
                scaleX: 1, scaleY: 1, opacity: 1, duration: 0.38, ease: 'back.out(1.6)',
                transformOrigin: 'top left'
            }
        );

        // Progress bar — driven by actual video time if video, else fixed 3s
        cancelAnimationFrame(_pvoTimer);
        if (pin.videoURL) {
            // Tick bar based on video currentTime / duration
            function tickVideoBar() {
                if (!_pvoVideo.duration) { _pvoTimer = requestAnimationFrame(tickVideoBar); return; }
                const pct = Math.min((_pvoVideo.currentTime / _pvoVideo.duration) * 100, 100);
                _pvoFill.style.width = pct + '%';
                if (pct < 100) _pvoTimer = requestAnimationFrame(tickVideoBar);
            }
            _pvoTimer = requestAnimationFrame(tickVideoBar);
            _pvoVideo.play().catch(() => { });
        } else {
            // Fixed 3s bar for no-video case
            const barStart = performance.now();
            const dur = 3000;
            function tickFixedBar(now) {
                const pct = Math.min((now - barStart) / dur * 100, 100);
                _pvoFill.style.width = pct + '%';
                if (pct < 100) _pvoTimer = requestAnimationFrame(tickFixedBar);
            }
            _pvoTimer = requestAnimationFrame(tickFixedBar);
        }

        // Advance: wait for video end, or 3s for no-video
        let autoTimer = null;
        if (pin.videoURL) {
            _pvoVideo.addEventListener('ended', () => closePVO(), { once: true });
        } else {
            autoTimer = setTimeout(closePVO, 3000);
        }

        function closePVO() {
            if (autoTimer) clearTimeout(autoTimer);
            cancelAnimationFrame(_pvoTimer);
            state.activeTourPinId = null;
            gsap.to(_pvoEl, {
                scaleX: 0.6, scaleY: 0.8, opacity: 0, duration: 0.24, ease: 'power2.in',
                transformOrigin: 'top left',
                onComplete: () => {
                    _pvoEl.style.display = 'none';
                    _pvoVideo.pause();
                    _pvoVideo.src = '';
                    _pvoPin = null;
                    drawPath(1); // refresh — HUD arrow disappears, visited callout shows
                    resolve();
                }
            });
        }

        _pvoDone = closePVO;
        document.getElementById('pvoClose').onclick = closePVO;
    });
}

function closePinVideoImmediate() {
    if (_pvoDone) { _pvoDone(); _pvoDone = null; }
    else {
        _pvoEl.style.display = 'none';
        _pvoVideo.pause();
        _pvoVideo.src = '';
        _pvoPin = null;
    }
}

/* ─────────────────────────────────────────────
   TOUR ENGINE
───────────────────────────────────────────── */
const tourProgress = document.getElementById('tourProgress');
const tpBarFill = document.getElementById('tpBarFill');
const tpStep = document.getElementById('tpStep');

async function startTour() {
    if (state.isTourPlaying) return;
    if (state.pins.length === 0) {
        alert('Add at least one pin first!');
        return;
    }

    state.isTourPlaying = true;
    document.getElementById('btnPlay').style.display = 'none';
    tourProgress.style.display = 'block';

    // Draw path slowly (8s eased)
    await new Promise(resolve => animatePath(resolve));
    await sleep(500);

    for (let i = 0; i < state.pins.length; i++) {
        if (!state.isTourPlaying) break;

        const pin = state.pins[i];
        state.tourIndex = i;

        // Progress bar
        tpBarFill.style.width = (i / state.pins.length * 100) + '%';
        tpStep.textContent = `${i + 1} / ${state.pins.length}`;

        // Fly to pin — slow, cinematic
        await new Promise(resolve => {
            map.flyTo(pin.latlng, 15, {
                duration: i === 0 ? 3 : 3.8,
                easeLinearity: 0.08,
            });
            map.once('moveend', resolve);
        });

        if (!state.isTourPlaying) break;

        // Pulse the marker
        if (pin.marker._icon) {
            gsap.to(pin.marker._icon, {
                scale: 1.4, duration: 0.25, ease: 'back.out(2)',
                yoyo: true, repeat: 1,
            });
        }

        await sleep(200);

        // ── Play video in the floating callout box ──
        await openPinVideo(pin, i);

        await sleep(500);
    }

    tpBarFill.style.width = '100%';
    await sleep(600);
    stopTour();
}

function stopTour() {
    state.isTourPlaying = false;
    state.visitedPins.clear();
    state.activeTourPinId = null;
    tourProgress.style.display = 'none';
    document.getElementById('btnPlay').style.display = '';
    // Close overlays if open
    closePinVideoImmediate();
    if (modalBackdrop.classList.contains('open')) {
        closeModal(false);
        _modalResolve = null;
    }
    drawPath(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

document.getElementById('btnPlay').addEventListener('click', startTour);
document.getElementById('btnStop').addEventListener('click', stopTour);

/* ─────────────────────────────────────────────
   INITIAL DEMO PINS
───────────────────────────────────────────── */
function loadDemoPins() {
    const demoPins = [
        { lat: 28.6139, lng: 77.2090, name: 'New Delhi — Start' },
        { lat: 26.8467, lng: 80.9462, name: 'Lucknow' },
        { lat: 22.5726, lng: 88.3639, name: 'Kolkata' },
        { lat: 13.0827, lng: 80.2707, name: 'Chennai — End' },
    ];

    demoPins.forEach(d => {
        addPin(L.latLng(d.lat, d.lng));
        state.pins[state.pins.length - 1].name = d.name;
    });

    renderPinList();
    map.fitBounds(demoPins.map(d => [d.lat, d.lng]), { padding: [80, 80] });
}

// Load demo pins on startup
loadDemoPins();
