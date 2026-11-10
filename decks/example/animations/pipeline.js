// A drawn slide that keeps playing: a Markdown file goes into the engine and
// comes out as a slide, and a dot travels the path while the slide is shown.
const along = (pts, k) => {
  const segs = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  let left = k * segs.reduce((a, b) => a + b, 0);
  for (let i = 0; i < segs.length; i++) {
    if (left <= segs[i] || i === segs.length - 1) {
      const t = segs[i] ? Math.min(1, left / segs[i]) : 0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    }
    left -= segs[i];
  }
  return pts[pts.length - 1];
};

export default {
  viewBox: ['0 0 1600 760', '0 0 800 1240'],
  draw(c) {
    const T = c.tall;
    const L = T ? {
      doc: [400, 150], docL: [400, 262], box: [210, 400, 380, 330], seal: [400, 565, 110], boxL: [400, 790],
      slide: [220, 930, 360, 202], slideL: [400, 1180], a1: [400, 290, 400, 388], a2: [400, 818, 400, 918],
      pts: [[400, 230], [400, 565], [400, 1030]],
    } : {
      doc: [220, 360], docL: [220, 482], box: [590, 210, 420, 320], seal: [800, 370, 112], boxL: [800, 586],
      slide: [1190, 270, 320, 180], slideL: [1350, 500], a1: [300, 360, 578, 370], a2: [1022, 370, 1178, 360],
      pts: [[290, 360], [800, 370], [1350, 360]],
    };
    c.at(150);
    c.icon('doc', L.doc[0], L.doc[1], T ? 150 : 140, { k: 'ink' });
    c.chip(L.docL[0], L.docL[1], '04-drawn.md', { font: 'code', size: T ? .55 : .6 });
    c.at(600);
    c.arrow(...L.a1, { k: 'soft', w: .8 });
    c.at(800);
    const [bx, by, bw, bh] = L.box;
    c.box(bx, by, bw, bh, 'double', { k: 'now', rx: 22 });
    c.seal(L.seal[0], L.seal[1], L.seal[2]);
    c.text(L.boxL[0], L.boxL[1], 'engine: loader, drawing context, seals', { size: T ? .62 : .66, k: 'soft' });
    c.at(1500);
    c.arrow(...L.a2, { k: 'soft', w: .8 });
    c.at(1700);
    const [sx, sy, sw, sh] = L.slide;
    c.rect(sx, sy, sw, sh, { k: 'ink', w: .8, rx: 4 });
    c.line(sx + 22, sy + 34, sx + sw * .55, sy + 34, { k: 'ink', w: 1.4 });
    c.curve(sx + 30, sy + sh - 30, sx + sw - 40, sy + 70, { k: 'now', w: 1, head: true });
    c.circle(sx + sw - 60, sy + sh - 48, 16, { k: 'seal', w: .7 });
    c.text(L.slideL[0], L.slideL[1], 'a slide, light or dark', { size: T ? .62 : .66, k: 'soft' });
    const dot = c.circle(L.pts[0][0], L.pts[0][1], T ? 11 : 9, { k: 'now', fill: 'now', w: .4, anim: 'none' });
    dot.style.opacity = '0';
    dot.style.transition = 'opacity .3s ease';
    c.svg._pulse = { el: dot, pts: L.pts };
  },
  enter(svg, { still, Anim }) {
    const p = svg._pulse;
    if (!p) return;
    if (svg._anim) svg._anim.stop();
    if (still) { p.el.style.opacity = '0'; return; }
    const A = svg._anim = new Anim();
    const run = () => {
      p.el.style.opacity = '1';
      A.tween(2600, k => { const [x, y] = along(p.pts, k); p.el.setAttribute('cx', x); p.el.setAttribute('cy', y); });
      A.at(2700, () => { p.el.style.opacity = '0'; });
      A.at(3500, run);
    };
    A.at(2400, run);
  },
  leave(svg) {
    if (svg._anim) svg._anim.stop();
    if (svg._pulse) svg._pulse.el.style.opacity = '0';
  },
};
