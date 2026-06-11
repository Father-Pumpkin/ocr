/**
 * Opt-in server-rendered sentiment chart. The primary path is structured data →
 * Claude artifact; this exists for saveable, consistent PNGs. Reuses the
 * @napi-rs/canvas dependency already pulled in for PDF rendering.
 *
 * Line chart for per-page series; bar chart for grouped means. All drawing is
 * nested so the canvas 2D context is captured by closure (no exported-type
 * dependency on the canvas package).
 */
import { createCanvas } from '@napi-rs/canvas';
const PALETTE = [
    '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
    '#0891b2', '#db2777', '#65a30d', '#475569', '#ca8a04',
];
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** Render an AnalyzeResult to a base64-encoded PNG (no data-URL prefix). */
export function renderSentimentChartPng(result) {
    const W = 920;
    const H = 520;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    // Title
    ctx.fillStyle = '#111827';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(truncate(chartTitle(result), 90), 20, 28);
    const left = 56;
    const top = 48;
    const right = W - 220;
    const bottom = H - 56;
    const plotW = right - left;
    const plotH = bottom - top;
    const yOf = (s) => bottom - Math.max(0, Math.min(1, s)) * plotH;
    // Y grid + labels (0.0–1.0)
    ctx.lineWidth = 1;
    ctx.font = '12px sans-serif';
    for (let i = 0; i <= 5; i++) {
        const v = i / 5;
        const y = yOf(v);
        ctx.strokeStyle = '#e5e7eb';
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.fillStyle = '#6b7280';
        ctx.fillText(v.toFixed(1), left - 30, y + 4);
    }
    // Axis lines
    ctx.strokeStyle = '#9ca3af';
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left, bottom);
    ctx.lineTo(right, bottom);
    ctx.stroke();
    const groups = result.groups;
    // Only clutter labels with the axes that actually vary across the groups.
    const multiMethod = new Set(groups.map((g) => g.method)).size > 1;
    const multiDim = new Set(groups.map((g) => g.dimension)).size > 1;
    if (groups.length === 0) {
        ctx.fillStyle = '#6b7280';
        ctx.font = '14px sans-serif';
        ctx.fillText('No scored data in scope — run score_pages first.', left + 20, top + plotH / 2);
        return canvas.toBuffer('image/png').toString('base64');
    }
    if (result.aggregate === 'series') {
        drawSeries();
    }
    else {
        drawBars();
    }
    drawLegend();
    return canvas.toBuffer('image/png').toString('base64');
    // ---- nested drawers (capture ctx + layout) ----
    function drawSeries() {
        let minX = Infinity;
        let maxX = -Infinity;
        for (const g of groups) {
            for (const p of g.points ?? []) {
                if (p.page_number < minX)
                    minX = p.page_number;
                if (p.page_number > maxX)
                    maxX = p.page_number;
            }
        }
        if (!Number.isFinite(minX)) {
            minX = 0;
            maxX = 1;
        }
        if (minX === maxX)
            maxX = minX + 1;
        const xOf = (pn) => left + ((pn - minX) / (maxX - minX)) * plotW;
        // X ticks
        ctx.fillStyle = '#6b7280';
        ctx.font = '12px sans-serif';
        const ticks = 6;
        for (let i = 0; i <= ticks; i++) {
            const pn = Math.round(minX + (i / ticks) * (maxX - minX));
            ctx.fillText(String(pn), xOf(pn) - 6, bottom + 18);
        }
        ctx.fillText('page', (left + right) / 2 - 12, bottom + 38);
        groups.forEach((g, gi) => {
            const color = PALETTE[gi % PALETTE.length];
            const pts = (g.points ?? []).slice().sort((a, b) => a.page_number - b.page_number);
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            pts.forEach((p, i) => {
                const x = xOf(p.page_number);
                const y = yOf(p.score);
                if (i === 0)
                    ctx.moveTo(x, y);
                else
                    ctx.lineTo(x, y);
            });
            ctx.stroke();
            pts.forEach((p) => {
                ctx.beginPath();
                ctx.arc(xOf(p.page_number), yOf(p.score), 2.5, 0, Math.PI * 2);
                ctx.fill();
            });
        });
    }
    function drawBars() {
        const n = groups.length;
        const slot = plotW / n;
        const barW = Math.min(64, slot * 0.6);
        groups.forEach((g, gi) => {
            const color = PALETTE[gi % PALETTE.length];
            const v = g.mean ?? 0;
            const x = left + gi * slot + (slot - barW) / 2;
            const y = yOf(v);
            ctx.fillStyle = color;
            ctx.fillRect(x, y, barW, bottom - y);
            // value above the bar
            ctx.fillStyle = '#111827';
            ctx.font = '11px sans-serif';
            ctx.fillText(v.toFixed(2), x + barW / 2 - 9, y - 4);
            // key below the axis
            ctx.fillStyle = '#374151';
            const label = truncate(g.key, 14);
            ctx.fillText(label, x + barW / 2 - ctx.measureText(label).width / 2, bottom + 16);
        });
    }
    function drawLegend() {
        ctx.font = '12px sans-serif';
        let ly = top;
        groups.slice(0, 18).forEach((g, gi) => {
            ctx.fillStyle = PALETTE[gi % PALETTE.length];
            ctx.fillRect(right + 16, ly, 12, 12);
            ctx.fillStyle = '#374151';
            const parts = [truncate(g.key, 16)];
            if (multiMethod)
                parts.push(truncate(g.method, 14));
            if (multiDim)
                parts.push(truncate(g.dimension, 12));
            ctx.fillText(parts.join(' · '), right + 32, ly + 11);
            ly += 18;
        });
        if (groups.length > 18) {
            ctx.fillStyle = '#9ca3af';
            ctx.fillText(`+${groups.length - 18} more`, right + 32, ly + 11);
        }
    }
}
function chartTitle(result) {
    const dims = result.dimensions.join(', ') || 'sentiment';
    const books = result.books.length === 1 ? result.books[0] : `${result.books.length} books`;
    const tags = result.tags.length ? ` [${result.tags.join(', ')}]` : '';
    const methods = result.methods.length > 1 ? ` · ${result.methods.length} methods` : '';
    return `${dims} — ${books}${tags}${methods} (by ${result.groupBy}, ${result.aggregate})`;
}
