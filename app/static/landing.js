"use strict";
/* Landing page: WebGL orb, star field, and the animated illustrations. */
(() => {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const landing = document.getElementById("auth");
  const shown = () => !landing.hidden && !document.hidden;

  /** Resolves once `node` is on screen (and the landing page is showing). */
  function watch(node) {
    let inView = false;
    new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; }, { threshold: 0.15 }).observe(node);
    return async () => { while (!(inView && shown())) await wait(400); };
  }

  async function type(node, text, speed = 30) {
    node.textContent = "";
    for (const ch of text) { node.textContent += ch; await wait(speed + Math.random() * speed); }
  }

  // --- reveal on scroll, nav, tile spotlight --------------------------------
  const targets = document.querySelectorAll(".reveal");
  if (still || !("IntersectionObserver" in window)) {
    targets.forEach((t) => t.classList.add("in"));
  } else {
    const seen = new IntersectionObserver((entries) => {
      entries.forEach((entry, i) => {
        if (!entry.isIntersecting) return;
        entry.target.style.transitionDelay = `${Math.min(i, 4) * 80}ms`;
        entry.target.classList.add("in");
        seen.unobserve(entry.target);
      });
    }, { threshold: 0.12 });
    targets.forEach((t) => seen.observe(t));
  }

  const nav = document.querySelector("#auth .nav");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 24);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  for (const tile of document.querySelectorAll(".tile")) {
    tile.addEventListener("pointermove", (e) => {
      const box = tile.getBoundingClientRect();
      tile.style.setProperty("--mx", `${e.clientX - box.left}px`);
      tile.style.setProperty("--my", `${e.clientY - box.top}px`);
    });
  }

  // --- star field ------------------------------------------------------------
  const sky = document.getElementById("stars");
  if (sky) {
    const ctx = sky.getContext("2d");
    let stars = [];
    const size = () => {
      const ratio = Math.min(devicePixelRatio || 1, 2);
      sky.width = sky.clientWidth * ratio;
      sky.height = sky.clientHeight * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = Math.round((sky.clientWidth * sky.clientHeight) / 9000);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * sky.clientWidth, y: Math.random() * sky.clientHeight,
        r: Math.random() * 1.1 + 0.3, phase: Math.random() * 6.28, speed: Math.random() * 0.9 + 0.3,
      }));
    };
    const draw = (time) => {
      if (shown() || still) {
        ctx.clearRect(0, 0, sky.clientWidth, sky.clientHeight);
        for (const star of stars) {
          ctx.globalAlpha = still ? 0.6 : 0.25 + 0.6 * Math.abs(Math.sin(star.phase + (time / 1000) * star.speed));
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.r, 0, 6.28);
          ctx.fillStyle = "#fff";
          ctx.fill();
        }
      }
      if (!still) requestAnimationFrame(draw);
    };
    // The landing starts hidden, so size the canvas whenever it actually gets a box.
    new ResizeObserver(() => { size(); if (still) draw(0); }).observe(sky);
    requestAnimationFrame(draw);
  }

  // --- the orb: a liquid, iridescent blob rendered in a fragment shader ------
  const FRAG = `
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }

// Three drifting lobes fused into one body: a tall main mass, a low left shoulder, a right flank.
float body(vec2 p) {
  float t = uTime;
  float d = length(p - vec2(0.16 + 0.03 * sin(t * 0.31), -0.04 + 0.03 * cos(t * 0.27))) - 0.80;
  d = smin(d, length(p - vec2(-0.66 + 0.05 * sin(t * 0.23), -0.60 + 0.04 * sin(t * 0.37))) - 0.42, 0.50);
  d = smin(d, length(p - vec2(0.62 + 0.04 * cos(t * 0.29), -0.42 + 0.03 * sin(t * 0.21))) - 0.58, 0.30);
  return d + 0.016 * sin(p.x * 5.0 + t * 0.6) * sin(p.y * 4.0 - t * 0.45);
}

void main() {
  vec2 p = (2.0 * gl_FragCoord.xy - uRes) / uRes.y;
  float d = body(p);
  vec2 e = vec2(0.004, 0.0);
  vec2 n = normalize(vec2(body(p + e.xy) - body(p - e.xy), body(p + e.yx) - body(p - e.yx)) + 1e-6);

  vec3 gold = vec3(1.0, 0.74, 0.34), cream = vec3(1.0, 0.95, 0.84), blue = vec3(0.16, 0.36, 1.0);
  vec2 keyDir = normalize(vec2(-0.75, 0.25) + uMouse * 0.35);   // bright key from the left
  vec2 fillDir = normalize(vec2(0.85, 0.5) - uMouse * 0.2);     // warm fill from the right
  float key = pow(max(dot(n, keyDir), 0.0), 1.6);
  float fill = pow(max(dot(n, fillDir), 0.0), 2.2);

  float depth = max(-d, 0.0);
  float flow = fbm(p * 1.7 + vec2(uTime * 0.05, -uTime * 0.035) + n * 0.25);
  float film = 0.5 + 0.5 * sin(flow * 9.0 + depth * 14.0 + uTime * 0.25);   // thin-film bands

  vec3 col = vec3(0.016, 0.018, 0.03);
  col += blue * 0.85 * exp(-length((p - vec2(0.22, -0.42)) * vec2(1.0, 1.3)) * 2.6);          // blue heart
  col += blue * 0.28 * film * exp(-depth * 3.2) * smoothstep(0.5, -0.5, p.y);
  col += gold * (0.10 + 1.05 * fill + 0.75 * key) * exp(-depth * 5.6) * (0.5 + 0.65 * film); // warm body sheen
  col += gold * 0.42 * smoothstep(0.42, 0.78, flow) * exp(-depth * 2.4) * (0.25 + key + fill);    // drifting gold caustics
  col += mix(gold, cream, 0.6) * (0.08 + 1.5 * key + 0.7 * fill) * exp(-depth * 22.0);       // glassy rim
  col += cream * (0.30 + 2.2 * key + 0.6 * fill) * exp(-depth * 80.0);                       // hairline edge

  float aa = smoothstep(0.004, -0.004, d);
  vec2 uv = gl_FragCoord.xy / uRes;
  float frame = smoothstep(0.0, 0.14, uv.x) * smoothstep(1.0, 0.86, uv.x) * smoothstep(1.0, 0.84, uv.y);   // never show the canvas edge
  float halo = ((0.10 + 0.55 * key + 0.22 * fill) * exp(-max(d, 0.0) * 24.0) + 0.05 * exp(-max(d, 0.0) * 5.0)) * frame;
  vec3 outside = mix(gold, cream, 0.6) * halo;
  float alpha = max(aa, clamp(halo, 0.0, 1.0));
  gl_FragColor = vec4(mix(outside, col, aa), alpha);   // premultiplied
}`;

  function startOrb() {
    const wrap = document.getElementById("orb");
    const canvas = document.getElementById("orb-gl");
    if (!wrap || !canvas) return;
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
    if (!gl) return;
    const compile = (kind, source) => {
      const shader = gl.createShader(kind);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vert = compile(gl.VERTEX_SHADER, "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }");
    const frag = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vert || !frag) return;
    const program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const attr = gl.getAttribLocation(program, "a");
    gl.enableVertexAttribArray(attr);
    gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(program, "uRes");
    const uTime = gl.getUniformLocation(program, "uTime");
    const uMouse = gl.getUniformLocation(program, "uMouse");
    wrap.classList.add("gl");   // hide the CSS fallback only once the shader really works

    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    addEventListener("pointermove", (e) => {
      mouse.tx = (e.clientX / innerWidth - 0.5) * 2;
      mouse.ty = -(e.clientY / innerHeight - 0.5) * 2;
    }, { passive: true });

    let onScreen = true;
    new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; }).observe(canvas);
    const size = () => {
      const ratio = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    const frame = (time) => {
      if ((onScreen && shown()) || still) {
        mouse.x += (mouse.tx - mouse.x) * 0.04;
        mouse.y += (mouse.ty - mouse.y) * 0.04;
        gl.uniform2f(uRes, canvas.width, canvas.height);
        gl.uniform1f(uTime, still ? 12 : time / 1000);
        gl.uniform2f(uMouse, mouse.x, mouse.y);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      if (!still) requestAnimationFrame(frame);
    };
    new ResizeObserver(() => { size(); if (still) frame(0); }).observe(canvas);
    requestAnimationFrame(frame);
  }
  try { startOrb(); } catch (err) { console.warn("Orb shader unavailable, using the CSS orb.", err); }

  const orb = document.getElementById("orb");
  if (orb && !still && matchMedia("(pointer: fine)").matches) {
    addEventListener("pointermove", (e) => {
      orb.style.setProperty("--px", `${(e.clientX / innerWidth - 0.5) * 30}px`);
      orb.style.setProperty("--py", `${(e.clientY / innerHeight - 0.5) * 18}px`);
    }, { passive: true });
  }

  const floatAgent = document.getElementById("float-agent");
  if (floatAgent && !still) {
    const names = ["🍳 Chef", "🧑‍💻 Coder", "🎓 Tutor", "✍️ Writer", "✨ Sidekick"];
    let index = 0;
    setInterval(() => {
      floatAgent.classList.add("swap");
      setTimeout(() => {
        index = (index + 1) % names.length;
        floatAgent.textContent = names[index];
        floatAgent.classList.remove("swap");
      }, 350);
    }, 2600);
  }

  // --- the dispatcher stage --------------------------------------------------
  const stage = document.getElementById("stage");
  if (stage) {
    const text = document.getElementById("stage-text");
    const core = document.getElementById("core");
    const pulse = document.getElementById("pulse");
    const wireIn = document.getElementById("wire-in");
    const wires = [...stage.querySelectorAll(".wire:not(.in)")];
    const nodes = [...stage.querySelectorAll(".node")];
    const ROUTES = [
      ["what can I cook with paneer tonight?", 1],
      ["why is my build failing?", 2],
      ["explain photosynthesis like I'm ten", 3],
      ["make this email sound friendlier", 4],
      ["plan my Saturday", 0],
    ];

    /** Run the glowing pulse along an SVG path (viewBox 1000 x 620). */
    function travel(path, ms) {
      path.classList.add("lit");
      const length = path.getTotalLength();
      return new Promise((done) => {
        const started = performance.now();
        const step = (now) => {
          const k = Math.min((now - started) / ms, 1);
          const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          const point = path.getPointAtLength(length * eased);
          pulse.style.left = `${point.x / 10}%`;
          pulse.style.top = `${point.y / 6.2}%`;
          pulse.style.opacity = k < 1 ? 1 : 0;
          if (k < 1) requestAnimationFrame(step); else done();
        };
        requestAnimationFrame(step);
      });
    }

    if (still) {
      text.textContent = ROUTES[1][0];
      wireIn.classList.add("lit");
      wires[2].classList.add("lit");
      nodes[2].classList.add("on");
    } else {
      const ready = watch(stage);
      (async () => {
        for (let i = 0; ; i = (i + 1) % ROUTES.length) {
          await ready();
          const [message, target] = ROUTES[i];
          await type(text, message);
          await wait(300);
          await travel(wireIn, 450);
          core.classList.add("think");
          await wait(1000);
          core.classList.remove("think");
          await travel(wires[target], 800);
          nodes[target].classList.add("on");
          await wait(1900);
          nodes[target].classList.remove("on");
          [wireIn, ...wires].forEach((w) => w.classList.remove("lit"));
          text.textContent = "";
          await wait(500);
        }
      })();
    }
  }

  // --- "hire in a sentence" tile ---------------------------------------------
  const hireCard = document.getElementById("hire-card");
  if (hireCard) {
    const art = hireCard.parentElement;
    const typed = document.getElementById("hire-typed");
    const HIRES = [
      ["a strict Spanish tutor", "🇪🇸", "Profe", "Strict Spanish tutor"],
      ["a calm meditation guide", "🧘", "Serene", "Gentle mindfulness guide"],
      ["a ruthless code reviewer", "🧑‍💻", "Lint", "Finds every bug in your PR"],
      ["a chef for busy weeknights", "🍳", "Tadka", "Fifteen-minute dinners"],
    ];
    const fill = ([, emoji, name, role]) => {
      document.getElementById("hire-emoji").textContent = emoji;
      document.getElementById("hire-name").textContent = name;
      document.getElementById("hire-role").textContent = role;
    };
    if (still) {
      typed.textContent = HIRES[0][0];
      hireCard.classList.add("show");
    } else {
      const ready = watch(art);
      (async () => {
        for (let i = 0; ; i = (i + 1) % HIRES.length) {
          await ready();
          await type(typed, HIRES[i][0], 34);
          await wait(250);
          art.classList.add("go");
          await wait(550);
          fill(HIRES[i]);
          hireCard.classList.add("show");
          await wait(2600);
          hireCard.classList.remove("show");
          art.classList.remove("go");
          await wait(600);
          typed.textContent = "";
        }
      })();
    }
  }

  // --- the Telegram conversation tile ----------------------------------------
  const crewBox = document.getElementById("demo-crew");
  const log = document.getElementById("demo-log");
  const typedChat = document.getElementById("demo-typed");
  const status = document.getElementById("demo-status");
  if (!crewBox) return;

  const BASE = [["✨", "Sidekick"], ["🍳", "Chef"], ["🧑‍💻", "Coder"]];
  const SCRIPT = [
    { say: "what can I cook with paneer tonight?", who: "Chef", emoji: "🍳",
      reply: "Paneer bhurji. One pan, fifteen minutes. Want the steps?" },
    { say: "why is this Python loop so slow?", who: "Coder", emoji: "🧑‍💻",
      reply: "You're searching a list inside the loop. Turn it into a set and lookups become instant." },
    { say: "/hire a strict Spanish tutor", hire: ["🇪🇸", "Profe"],
      reply: "🎉 Hired 🇪🇸 Profe: strict Spanish tutor who corrects your grammar" },
    { say: "how do I say “I'm running late”?", who: "Profe", emoji: "🇪🇸",
      reply: "«Voy con retraso.» Say it back to me, and roll that double r." },
  ];

  function chip([emoji, name]) {
    const node = document.createElement("span");
    node.className = "chip";
    node.dataset.name = name;
    node.textContent = `${emoji} ${name}`;
    crewBox.append(node);
    return node;
  }

  function bubble(kind, content, label) {
    const node = document.createElement("div");
    node.className = `bubble ${kind}`;
    if (label) {
      const tag = document.createElement("b");
      tag.textContent = label;
      node.append(tag);
    }
    node.append(content);
    log.append(node);
    log.scrollTo({ top: log.scrollHeight, behavior: still ? "auto" : "smooth" });
    return node;
  }

  function reset() {
    crewBox.replaceChildren();
    log.replaceChildren();
    typedChat.textContent = "";
    BASE.forEach(chip);
  }

  if (still) {  // no motion: show the finished conversation
    reset();
    for (const step of SCRIPT.slice(0, 2)) {
      bubble("me", step.say);
      bubble("them", step.reply, `${step.emoji} ${step.who}`);
    }
    return;
  }

  const ready = watch(log);
  (async () => {
    for (;;) {
      reset();
      await wait(900);
      for (const step of SCRIPT) {
        await ready();
        await type(typedChat, step.say, 26);
        await wait(350);
        typedChat.textContent = "";
        bubble("me", step.say);

        const chips = [...crewBox.children];
        if (step.hire) {
          status.textContent = "writing a new agent…";
          await wait(1300);
          chip(step.hire).classList.add("new");
        } else {
          status.textContent = "choosing an agent…";
          for (let i = 0; i < chips.length * 2; i++) {  // the dispatcher scans the crew
            chips.forEach((c, j) => c.classList.toggle("scan", j === i % chips.length));
            await wait(110);
          }
          chips.forEach((c) => { c.classList.remove("scan"); c.classList.toggle("on", c.dataset.name === step.who); });
          status.textContent = `${step.who} is typing…`;
        }
        const dots = bubble("them dots", "");
        dots.innerHTML = "<i></i><i></i><i></i>";
        await wait(1100);
        dots.remove();
        bubble("them", step.reply, step.hire ? "" : `${step.emoji} ${step.who}`);
        status.textContent = "bot";
        await wait(1900);
        [...crewBox.children].forEach((c) => c.classList.remove("on"));
      }
      await wait(2200);
    }
  })();
})();
