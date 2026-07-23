import { createReactorScene } from "./scenes/reactor/reactorScene.js";

const root = document.documentElement;
const cantorPath = document.querySelector("[data-cantor]");
const heroSection = document.querySelector(".hero");
const reactorCanvas = document.querySelector(".reactor-surface");
const glassCanvas = document.querySelector(".glass-surface");
const liquidSection = document.querySelector(".contact-section");
const liquidCanvas = document.querySelector(".liquid-surface");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

requestAnimationFrame(() => root.classList.add("is-ready"));

let reactor = null;
if (heroSection && reactorCanvas) {
  reactor = createReactorScene({ section: heroSection, canvas: reactorCanvas, reduceMotion });
}

// 玻璃立方体层（Three.js + 物理）延迟加载：第一页在首屏，必须立刻有画面，
// 所以先让原生 WebGL 的池面顶上，等这一层就绪再淡入接管。加载失败就停在池面上。
if (heroSection && glassCanvas) {
  const startGlass = () => {
    import("./scenes/reactor/glassCubes.js").then(({ createGlassCubes }) => {
      const glass = createGlassCubes({ section: heroSection, canvas: glassCanvas, reduceMotion });
      // 玻璃层里也画了池底，底层画布再逐帧重绘就是白费一份 GPU
      if (glass && reactor && reactor.suspend) reactor.suspend();
      else if (!glass) glassCanvas.hidden = true;
    }).catch(err => {
      console.error("glassCubes failed to load", err);
      glassCanvas.hidden = true;
    });
  };
  if ("requestIdleCallback" in window) requestIdleCallback(startGlass, { timeout: 1200 });
  else setTimeout(startGlass, 200);
}

if (cantorPath) {
  const points = [];
  const buildCantor = (depth, x0, x1, y0, y1) => {
    if (depth === 0) {
      points.push([x0, y0], [x1, y1]);
      return;
    }

    const third = (x1 - x0) / 3;
    const middle = (y0 + y1) / 2;
    buildCantor(depth - 1, x0, x0 + third, y0, middle);
    points.push([x0 + third * 2, middle]);
    buildCantor(depth - 1, x0 + third * 2, x1, middle, y1);
  };

  buildCantor(5, 0, 1, 0, 1);
  const unique = points.filter((point, index) => {
    return index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1];
  });
  cantorPath.setAttribute("d", unique.map(([x, y], index) => {
    return `${index ? "L" : "M"}${50 + x * 500} ${550 - y * 500}`;
  }).join(""));
}

if (liquidSection && liquidCanvas) {
  let pondStarted = false;
  const startPond = () => {
    if (pondStarted) return;
    pondStarted = true;
    import("./scenes/pond/pondScene.js").then(({ createPondScene }) => {
      createPondScene({
        section: liquidSection,
        canvas: liquidCanvas,
        reduceMotion
      });
    }).catch(() => {
      liquidCanvas.hidden = true;
    });
  };

  if ("IntersectionObserver" in window) {
    const pondObserver = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return;
      pondObserver.disconnect();
      startPond();
    }, { rootMargin: "100% 0px", threshold: 0 });
    pondObserver.observe(liquidSection);
  } else {
    startPond();
  }
}

const revealItems = document.querySelectorAll(".section__header, .lead, .prose, .project, .contact-grid");
revealItems.forEach(item => item.classList.add("reveal"));

if (reduceMotion || !("IntersectionObserver" in window)) {
  revealItems.forEach(item => item.classList.add("is-visible"));
} else {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12 });

  revealItems.forEach(item => observer.observe(item));
}
