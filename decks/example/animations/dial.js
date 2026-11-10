// The title drawing: the deck's seal at the centre of a dial, a tick for
// every slide, and the three things the engine does around it.
// A drawing module needs no imports: everything comes through the context c.
export default {
  viewBox: ['0 0 800 800', '0 0 800 800'],
  draw(c) {
    const cx = 400, cy = 400;
    const pol = (r, a) => [cx + r * Math.cos(a * c.deg), cy + r * Math.sin(a * c.deg)];
    const P = (r, a) => pol(r, a).map(c.f2).join(' ');
    c.at(60);
    c.circle(cx, cy, 362, { k: 'faint', w: .6 });
    let d = '';
    for (let i = 0; i < 180; i++) {
      const a = i * 2 - 90;
      d += `M${P(274, a)}L${P(i % 10 ? 283 : 293, a)}`;
    }
    c.path(d, { k: 'soft', w: .3, anim: 'an-fade' });
    // The deck's seal.
    c.at(260);
    c.circle(cx, cy, 184, { k: 'now', w: 1.2 });
    c.circle(cx, cy, 170, { k: 'now', w: .4 });
    c.seal(cx, cy, 130);
    // One tick per slide: six that work today, one planned.
    c.at(900);
    const a0 = -156, a1 = -24;
    for (let i = 0; i < 7; i++) {
      const a = a0 + 8 + i * (a1 - a0 - 16) / 6;
      const [x1, y1] = pol(196, a), [x2, y2] = pol(196 + (i === 6 ? 44 : 60), a);
      c.line(x1, y1, x2, y2, { k: i === 6 ? 'next' : 'now', w: i === 6 ? 2 : 3, step: 90 });
    }
    // The window the presenter reads through, sweeping into place.
    const win = c.E('g', { class: 'an-sweep' }, c.svg);
    win.style.setProperty('--d', '1500ms');
    win.style.setProperty('--ox', cx + 'px');
    win.style.setProperty('--oy', cy + 'px');
    const sector = `M${P(190, a0)}L${P(304, a0)}A304 304 0 0 1 ${P(304, a1)}L${P(190, a1)}A190 190 0 0 0 ${P(190, a0)}Z`;
    c.path(sector, { k: 'now', w: .5, fill: 'hatch-now', anim: 'none', p: win });
    [a0, a1].forEach(a => {
      const [x1, y1] = pol(186, a), [x2, y2] = pol(312, a);
      c.line(x1, y1, x2, y2, { k: 'now', w: 1.5, anim: 'none', p: win });
    });
    // Markdown in, edits and recordings out.
    c.at(2300);
    const lk = (x, y, a, r) => {
      const [tx, ty] = pol(r, a);
      const L = Math.hypot(tx - x, ty - y);
      c.line(x + (tx - x) / L * 52, y + (ty - y) / L * 52, tx, ty, { k: 'soft', w: .5 });
    };
    c.icon('doc', 108, 118, 74, { k: 'now' }); lk(108, 118, -126, 314);
    c.icon('pencil', 692, 118, 74, { k: 'now' }); lk(692, 118, -54, 314);
    c.icon('mic', 108, 690, 74, { k: 'ink' }); lk(108, 690, 135, 190);
  },
};
