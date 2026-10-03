"use strict";
/* Landing page motion: scroll reveals and the looping Telegram demo. */
(() => {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // --- reveal on scroll ----------------------------------------------------
  const targets = document.querySelectorAll(".reveal");
  if (still || !("IntersectionObserver" in window)) {
    targets.forEach((t) => t.classList.add("in"));
  } else {
    const seen = new IntersectionObserver((entries) => {
      entries.forEach((entry, i) => {
        if (!entry.isIntersecting) return;
        entry.target.style.transitionDelay = `${Math.min(i, 4) * 70}ms`;
        entry.target.classList.add("in");
        seen.unobserve(entry.target);
      });
    }, { threshold: 0.15 });
    targets.forEach((t) => seen.observe(t));
  }

  // --- nav, stars, orb parallax, floating card ------------------------------
  const nav = document.querySelector("#auth .nav");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 24);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const canvas = document.getElementById("stars");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    let stars = [];
    const size = () => {
      const ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = canvas.clientWidth * ratio;
      canvas.height = canvas.clientHeight * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = Math.round((canvas.clientWidth * canvas.clientHeight) / 9000);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.clientWidth, y: Math.random() * canvas.clientHeight,
        r: Math.random() * 1.1 + 0.3, phase: Math.random() * 6.28, speed: Math.random() * 0.9 + 0.3,
      }));
    };
    const draw = (time) => {
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      for (const star of stars) {
        ctx.globalAlpha = still ? 0.6 : 0.25 + 0.6 * Math.abs(Math.sin(star.phase + (time / 1000) * star.speed));
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.r, 0, 6.28);
        ctx.fillStyle = "#fff";
        ctx.fill();
      }
      if (!still) requestAnimationFrame(draw);
    };
    // The landing starts hidden, so size the canvas whenever it actually gets a box.
    new ResizeObserver(size).observe(canvas);
    requestAnimationFrame(draw);
  }

  const orb = document.getElementById("orb");
  if (orb && !still && matchMedia("(pointer: fine)").matches) {
    addEventListener("pointermove", (e) => {
      orb.style.setProperty("--px", `${(e.clientX / innerWidth - 0.5) * 36}px`);
      orb.style.setProperty("--py", `${(e.clientY / innerHeight - 0.5) * 22}px`);
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

  // --- the demo conversation -----------------------------------------------
  const crewBox = document.getElementById("demo-crew");
  const log = document.getElementById("demo-log");
  const typed = document.getElementById("demo-typed");
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

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = () => !document.getElementById("auth").hidden && !document.hidden;

  function chip([emoji, name]) {
    const node = document.createElement("span");
    node.className = "chip";
    node.dataset.name = name;
    node.textContent = `${emoji} ${name}`;
    crewBox.append(node);
    return node;
  }

  function bubble(kind, text, label) {
    const node = document.createElement("div");
    node.className = `bubble ${kind}`;
    if (label) {
      const tag = document.createElement("b");
      tag.textContent = label;
      node.append(tag);
    }
    node.append(text);
    log.append(node);
    log.scrollTo({ top: log.scrollHeight, behavior: still ? "auto" : "smooth" });
    return node;
  }

  function reset() {
    crewBox.replaceChildren();
    log.replaceChildren();
    typed.textContent = "";
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

  async function play() {
    for (;;) {
      reset();
      await wait(900);
      for (const step of SCRIPT) {
        while (!visible()) await wait(500);
        for (const ch of step.say) { typed.textContent += ch; await wait(26 + Math.random() * 30); }
        await wait(350);
        typed.textContent = "";
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
  }
  play();
})();
