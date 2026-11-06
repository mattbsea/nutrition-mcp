/**
 * The dashboard's only static files, held as strings so the server needs no
 * file lookup and no path from a request ever touches the filesystem. Served
 * from our own origin (CSP: style-src 'self', script-src 'self'); no fonts, no
 * images, no third-party anything.
 */
import { createHash } from "node:crypto";

export const CSS = `
:root{color-scheme:light dark;
--bg:#f6f5f2;--surface:#ffffff;--ink:#1c1917;--muted:#57534e;--line:#d6d3d1;--accent:#0f6b4f;--accent-ink:#ffffff;
--warn:#b42318;--ok:#0f6b4f;--focus:#1d4ed8;
--c-cal:#c2410c;--c-pro:#1d4ed8;--c-carb:#0f766e;--c-fat:#7e22ce;--c-water:#0369a1;--c-weight:#be185d;--c-act:#15803d;--track:#e7e5e4}
@media (prefers-color-scheme:dark){:root{
--bg:#0c0a09;--surface:#1c1917;--ink:#fafaf9;--muted:#a8a29e;--line:#44403c;--accent:#4ade80;--accent-ink:#052e16;
--warn:#fca5a5;--ok:#4ade80;--focus:#93c5fd;
--c-cal:#fb923c;--c-pro:#60a5fa;--c-carb:#2dd4bf;--c-fat:#c084fc;--c-water:#38bdf8;--c-weight:#f472b6;--c-act:#4ade80;--track:#292524}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:4px}
.skip{position:absolute;left:-999px;top:0;background:var(--surface);color:var(--ink);padding:.5rem 1rem;z-index:10}
.skip:focus{left:0}
header.top{background:var(--surface);border-bottom:1px solid var(--line)}
.bar{max-width:68rem;margin:0 auto;padding:.6rem 1rem;display:flex;align-items:center;justify-content:space-between;gap:1rem}
.brand{font-weight:700;letter-spacing:.01em}
nav.main{max-width:68rem;margin:0 auto;display:flex;gap:.25rem;padding:0 .5rem .5rem;overflow-x:auto}
nav.main a{flex:1 1 0;min-width:4.2rem;text-align:center;padding:.5rem .4rem;border-radius:.5rem;text-decoration:none;color:var(--muted);font-size:.95rem}
nav.main a[aria-current="page"]{background:var(--accent);color:var(--accent-ink);font-weight:600}
main{max-width:68rem;margin:0 auto;padding:1rem}
h1{font-size:1.4rem;margin:.2rem 0 .2rem}
h2{font-size:1.05rem;margin:0 0 .6rem}
.sub{color:var(--muted);margin:0 0 1rem}
.grid{display:grid;gap:1rem;grid-template-columns:1fr}
@media (min-width:46rem){.grid.two{grid-template-columns:1fr 1fr}.grid.three{grid-template-columns:repeat(3,1fr)}}
.card{background:var(--surface);border:1px solid var(--line);border-radius:.9rem;padding:1rem;min-width:0}
.card.wide{grid-column:1/-1}
.kpi{font-size:1.7rem;font-weight:700;line-height:1.1}
.kpi small{font-size:.9rem;font-weight:400;color:var(--muted)}
.muted{color:var(--muted)}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:.5rem}
.stack>*+*{margin-top:.75rem}
.ring{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
.ring svg{width:9rem;height:9rem;flex:none}
.ring .track{stroke:var(--track)}
.ring .fill{stroke:var(--c-cal);stroke-linecap:round}
.ring .fill.over{stroke:var(--warn)}
.ring text{fill:var(--ink);font-weight:700}
.ring text.sub{fill:var(--muted);font-weight:400}
.notes{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.meter{width:100%;height:.6rem;display:block;border-radius:.3rem;background:var(--track)}
.meter rect.f{fill:var(--c-pro)}
.meter rect.f.carb{fill:var(--c-carb)}.meter rect.f.fat{fill:var(--c-fat)}.meter rect.f.water{fill:var(--c-water)}.meter rect.f.over{fill:var(--warn)}
ul.plain{list-style:none;margin:0;padding:0}
ul.meals li{padding:.7rem 0;border-top:1px solid var(--line)}
ul.meals li:first-child{border-top:0}
.meal-name{font-weight:600;overflow-wrap:anywhere}
.macros{color:var(--muted);font-size:.9rem}
.tag{display:inline-block;font-size:.78rem;border:1px solid var(--line);border-radius:999px;padding:.05rem .5rem;color:var(--muted);margin-left:.4rem}
table{border-collapse:collapse;width:100%;font-size:.93rem}
th,td{text-align:left;padding:.4rem .5rem;border-top:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto}
.chart{width:100%;height:auto;display:block}
.chart .grid-line{stroke:var(--line);stroke-width:1}
.chart text{fill:var(--muted);font-size:11px}
.chart rect{stroke:none}
.chart .goal{stroke:var(--muted);stroke-dasharray:4 3;stroke-width:1.5;fill:none}
.chart .line{fill:none;stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
.chart .dot{stroke:var(--surface);stroke-width:1.5}
.s-cal{stroke:var(--c-cal);fill:var(--c-cal)}.s-pro{fill:var(--c-pro)}.s-carb{fill:var(--c-carb)}.s-fat{fill:var(--c-fat)}
.s-water{stroke:var(--c-water);fill:var(--c-water)}.s-weight{stroke:var(--c-weight);fill:var(--c-weight)}.s-act{stroke:var(--c-act);fill:var(--c-act)}
.chart .line.s-cal,.chart .line.s-water,.chart .line.s-weight,.chart .line.s-act{fill:none}
.legend{display:flex;gap:1rem;flex-wrap:wrap;font-size:.88rem;color:var(--muted);margin:.4rem 0 0}
.legend i{display:inline-block;width:.8rem;height:.8rem;border-radius:.2rem;margin-right:.35rem;vertical-align:-.1rem}
.legend i.cal{background:var(--c-cal)}.legend i.pro{background:var(--c-pro)}.legend i.carb{background:var(--c-carb)}.legend i.fat{background:var(--c-fat)}
.legend i.goal{background:transparent;border-top:2px dashed var(--muted);height:0;width:1.1rem;border-radius:0}
.empty{color:var(--muted);padding:.5rem 0}
.btn,button{font:inherit;cursor:pointer;border-radius:.6rem;border:1px solid var(--line);background:var(--surface);color:var(--ink);padding:.5rem .9rem;min-height:2.5rem;text-decoration:none;display:inline-block}
.btn.primary,button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:600}
.btn.danger,button.danger{color:var(--warn);border-color:var(--warn)}
input[type=password],input[type=text],input[type=search],input[type=date]{font:inherit;width:100%;padding:.55rem .7rem;border-radius:.6rem;border:1px solid var(--line);background:var(--bg);color:var(--ink);min-height:2.6rem}
label{display:block;font-weight:600;margin-bottom:.3rem}
.field{margin-bottom:1rem}
.alert{border:1px solid var(--warn);color:var(--warn);border-radius:.6rem;padding:.6rem .8rem;margin-bottom:1rem}
.notice{border:1px solid var(--line);border-radius:.6rem;padding:.6rem .8rem;margin-bottom:.8rem}
.login{max-width:24rem;margin:12vh auto 0;padding:0 1rem}
.pager{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem}
.range a{padding:.35rem .8rem;border:1px solid var(--line);border-radius:999px;text-decoration:none;color:var(--ink)}
.range a[aria-current="true"]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.range{display:flex;gap:.5rem;margin-bottom:1rem}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;overflow-wrap:anywhere}
.secret{display:block;padding:.6rem .8rem;border:1px dashed var(--line);border-radius:.6rem;margin:.4rem 0;user-select:all}
details>summary{cursor:pointer;color:var(--muted);margin-top:.5rem}
.good{color:var(--ok)}.bad{color:var(--warn)}
form.inline{display:inline}
`;

export const JS = `
document.addEventListener("click", function (e) {
  var b = e.target.closest("[data-copy]");
  if (!b) return;
  var text = b.getAttribute("data-copy");
  var done = function () { var o = b.textContent; b.textContent = "Copied"; setTimeout(function () { b.textContent = o; }, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { window.prompt("Copy:", text); });
  } else { window.prompt("Copy:", text); }
});
`;

const etag = (s: string): string =>
    `"${createHash("sha256").update(s).digest("base64url").slice(0, 16)}"`;

export const ASSETS: Record<
    string,
    { body: string; type: string; etag: string }
> = {
    "/assets/dashboard.css": {
        body: CSS,
        type: "text/css; charset=utf-8",
        etag: etag(CSS),
    },
    "/assets/dashboard.js": {
        body: JS,
        type: "text/javascript; charset=utf-8",
        etag: etag(JS),
    },
};
