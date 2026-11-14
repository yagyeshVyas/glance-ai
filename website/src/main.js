import "@fontsource-variable/manrope/index.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./style.css";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);
ScrollTrigger.config({ ignoreMobileResize: true });

const $ = (selector, context = document) => context.querySelector(selector);
const $$ = (selector, context = document) => Array.from(context.querySelectorAll(selector));
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let lenis = null;
let menuTimeline = null;

/* ---------------------------------------------------------
   Smooth scroll + anchors
   --------------------------------------------------------- */
function setupSmoothScroll() {
  if (reducedMotion) return;

  lenis = new Lenis({
    lerp: 0.085,
    smoothWheel: true,
    syncTouch: false,
    wheelMultiplier: 1,
    touchMultiplier: 1.5,
    autoRaf: false,
  });

  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);

  const hashTarget = window.location.hash && document.querySelector(window.location.hash);
  if (hashTarget) {
    window.setTimeout(() => {
      lenis.scrollTo(hashTarget, { offset: -70, immediate: true });
    }, 80);
  }
}

function scrollToTarget(target) {
  if (!target) return;
  if (lenis) {
    lenis.scrollTo(target, { offset: -62, duration: 0.9 });
  } else {
    const top = target.getBoundingClientRect().top + window.scrollY - 62;
    window.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
  }
}

function setupAnchors() {
  $$('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (event) => {
      const href = link.getAttribute("href");
      if (!href || href === "#") return;
      const target = document.querySelector(href);
      if (!target) return;
      event.preventDefault();
      closeMenu();
      scrollToTarget(target);
      if (history.pushState) history.pushState(null, "", href);
    });
  });
}

/* ---------------------------------------------------------
   Navigation, progress, mobile menu
   --------------------------------------------------------- */
function setupChrome() {
  const nav = $("#nav");
  const progress = $(".page-progress span");
  const update = () => {
    const y = window.scrollY || window.pageYOffset || 0;
    nav.classList.toggle("is-scrolled", y > 18);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = max > 0 ? Math.min(y / max, 1) : 0;
    progress.style.transform = `scaleX(${ratio})`;
  };

  update();
  window.addEventListener("scroll", update, { passive: true });
  if (lenis) lenis.on("scroll", update);
  window.addEventListener("resize", update, { passive: true });
}

function openMenu() {
  const toggle = $("#menuToggle");
  const menu = $("#mobileMenu");
  if (!menu || !toggle) return;
  menu.hidden = false;
  toggle.setAttribute("aria-expanded", "true");
  toggle.setAttribute("aria-label", "Close menu");
  document.body.classList.add("menu-open");
  if (lenis) lenis.stop();

  if (menuTimeline) menuTimeline.kill();
  if (reducedMotion) {
    gsap.set(menu, { opacity: 1 });
  } else {
    menuTimeline = gsap.timeline({ defaults: { ease: "power3.out" } });
    menuTimeline
      .fromTo(menu, { opacity: 0 }, { opacity: 1, duration: 0.28 })
      .fromTo(menu.querySelectorAll("nav a"), { y: 26, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, stagger: 0.055 }, 0.06)
      .fromTo(menu.querySelector(".mobile-menu-foot"), { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5 }, 0.26);
  }

  const firstLink = menu.querySelector("nav a");
  window.setTimeout(() => {
    if (!menu.hidden) firstLink?.focus();
  }, 80);
}

function closeMenu(restoreFocus = false) {
  const toggle = $("#menuToggle");
  const menu = $("#mobileMenu");
  if (!menu || !toggle || menu.hidden) return;
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open menu");
  document.body.classList.remove("menu-open");
  if (lenis) lenis.start();

  if (menuTimeline) menuTimeline.kill();
  if (reducedMotion) {
    menu.hidden = true;
  } else {
    menuTimeline = gsap.to(menu, {
      opacity: 0,
      duration: 0.2,
      ease: "power2.in",
      onComplete: () => {
        menu.hidden = true;
        gsap.set(menu, { clearProps: "opacity" });
      },
    });
  }
  if (restoreFocus) toggle.focus();
}

function setupMenu() {
  const toggle = $("#menuToggle");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    const isOpen = toggle.getAttribute("aria-expanded") === "true";
    if (isOpen) closeMenu(true);
    else openMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      closeMenu(true);
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 980) closeMenu();
  });
}

/* ---------------------------------------------------------
   Hero intro
   --------------------------------------------------------- */
function setupHeroIntro() {
  const items = $$(".hero [data-anim]");
  if (!items.length) return;

  if (reducedMotion) {
    gsap.set(items, { opacity: 1, y: 0 });
    return;
  }

  gsap.to(items, {
    opacity: 1,
    y: 0,
    duration: 1.05,
    ease: "power3.out",
    stagger: 0.085,
    delay: 0.08,
  });

  // Safety net: never leave content invisible if a later animation throws.
  window.setTimeout(() => {
    items.forEach((item) => {
      if (Number(getComputedStyle(item).opacity) === 0) {
        item.style.opacity = "1";
        item.style.transform = "none";
      }
    });
  }, 3200);
}

/* ---------------------------------------------------------
   Scroll reveals, statement, counters
   --------------------------------------------------------- */
function setupReveals() {
  const elements = $$("[data-reveal]");
  if (reducedMotion || !("IntersectionObserver" in window)) {
    elements.forEach((el) => {
      el.style.opacity = "1";
      el.style.visibility = "visible";
    });
    return;
  }

  gsap.set(elements, { y: 34, autoAlpha: 0 });

  const reveal = (el) => {
    if (el.dataset.revealed === "true") return;
    el.dataset.revealed = "true";
    gsap.to(el, {
      y: 0,
      autoAlpha: 1,
      duration: 0.95,
      ease: "power3.out",
      overwrite: true,
    });
  };

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        reveal(entry.target);
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.01 }
  );
  elements.forEach((el) => observer.observe(el));

  // A fast scrollbar drag or an anchor jump can skip an element entirely.
  // Reveal anything already above the viewport so content never stays hidden.
  let queued = false;
  const catchSkipped = () => {
    queued = false;
    elements.forEach((el) => {
      if (el.dataset.revealed === "true") return;
      if (el.getBoundingClientRect().top < window.innerHeight * 0.92) reveal(el);
    });
  };
  window.addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(catchSkipped);
  }, { passive: true });
  catchSkipped();
}

function setupStatement() {
  const heading = $("[data-words]");
  if (!heading) return;

  const text = heading.textContent.trim().replace(/\s+/g, " ");
  const words = text.split(" ");
  heading.setAttribute("aria-label", text);
  heading.innerHTML = words
    .map((word) => `<span class="word" aria-hidden="true"><span>${escapeHTML(word)}</span></span>`)
    .join(" ");
  const spans = $$(".word > span", heading);

  if (reducedMotion) {
    spans.forEach((span) => (span.style.color = "#eef2fa"));
  } else {
    gsap.to(spans, {
      color: "#eef2fa",
      stagger: 0.07,
      ease: "none",
      scrollTrigger: {
        trigger: heading,
        start: "top 78%",
        end: "bottom 58%",
        scrub: 0.5,
      },
    });
  }

  $$("[data-count]").forEach((el) => {
    const end = Number(el.dataset.count || 0);
    if (!end) return;
    if (reducedMotion) {
      el.textContent = String(end).padStart(2, "0");
      return;
    }
    const state = { value: 0 };
    ScrollTrigger.create({
      trigger: el,
      start: "top 88%",
      once: true,
      onEnter: () => {
        gsap.to(state, {
          value: end,
          duration: 1.3,
          ease: "power2.out",
          onUpdate: () => {
            el.textContent = String(Math.round(state.value)).padStart(2, "0");
          },
        });
      },
    });
  });
}

function escapeHTML(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

/* ---------------------------------------------------------
   Video player
   --------------------------------------------------------- */
function setupDemo() {
  const shell = $("#videoShell");
  const video = $("#demoVideo");
  if (!shell || !video) return;

  const playButton = $("#videoPlay");
  const bigPlay = $("#videoBigPlay");
  const seek = $("#videoSeek");
  const fill = $("#vcFill");
  const timeLabel = $("#vcTime");
  const timecode = $("#playerTimecode");
  const captionText = $(".video-caption .caption-text");
  const captionIndex = $(".video-caption .caption-index");
  const fullButton = $("#videoFull");
  const chapters = $$(".chapter");

  const chapterData = [
    { at: 0, label: "The question lands. Glance is already listening." },
    { at: 7, label: "One keystroke. Screen OCR and transcript go to your model." },
    { at: 14, label: "The answer streams in, ready to say, not to read." },
  ];

  let userPaused = false;
  let activeChapter = -1;

  const format = (seconds) => {
    if (!Number.isFinite(seconds)) return "00:00";
    const whole = Math.max(0, Math.floor(seconds));
    const m = String(Math.floor(whole / 60)).padStart(2, "0");
    const s = String(whole % 60).padStart(2, "0");
    return `${m}:${s}`;
  };

  const updateA11yLabel = () => {
    const playing = !video.paused;
    playButton.setAttribute("aria-label", playing ? "Pause demo" : "Play demo");
  };

  const setPlayingState = () => {
    const playing = !video.paused;
    shell.classList.toggle("is-playing", playing);
    shell.classList.toggle("is-paused", !playing);
    updateA11yLabel();
  };

  const updateProgress = () => {
    const duration = Number.isFinite(video.duration) ? video.duration : 20.47;
    const ratio = duration > 0 ? Math.min(video.currentTime / duration, 1) : 0;
    fill.style.width = `${ratio * 100}%`;
    seek.value = String(ratio * 100);
    timeLabel.textContent = `${format(video.currentTime)} / ${format(duration)}`;
    timecode.textContent = format(video.currentTime);

    let index = 0;
    chapterData.forEach((chapter, i) => {
      if (video.currentTime >= chapter.at) index = i;
    });

    if (index !== activeChapter) {
      activeChapter = index;
      chapters.forEach((chapter, i) => chapter.classList.toggle("is-active", i === index));
      if (captionText) captionText.textContent = chapterData[index].label;
      if (captionIndex) captionIndex.textContent = String(index + 1).padStart(2, "0");
    }
  };

  const play = () => {
    userPaused = false;
    video.play().then(() => {
      setPlayingState();
    }).catch(() => {
      userPaused = true;
      setPlayingState();
    });
  };

  const togglePlay = () => {
    if (video.paused) play();
    else {
      userPaused = true;
      video.pause();
    }
  };

  playButton?.addEventListener("click", togglePlay);
  bigPlay?.addEventListener("click", play);

  video.addEventListener("play", setPlayingState);
  video.addEventListener("pause", setPlayingState);
  video.addEventListener("timeupdate", updateProgress);
  video.addEventListener("loadedmetadata", updateProgress);
  video.addEventListener("click", togglePlay);

  seek?.addEventListener("input", () => {
    if (!Number.isFinite(video.duration)) return;
    video.currentTime = (Number(seek.value) / 100) * video.duration;
    updateProgress();
  });

  chapters.forEach((chapter) => {
    chapter.addEventListener("click", () => {
      const at = Number(chapter.dataset.time || 0);
      video.currentTime = Math.min(at, (video.duration || 20.47) - 0.1);
      play();
      updateProgress();
    });
  });

  fullButton?.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) {
        await shell.requestFullscreen();
        await video.play();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      /* Fullscreen is a progressive enhancement. */
    }
  });

  document.addEventListener("fullscreenchange", () => {
    fullButton?.setAttribute("aria-label", document.fullscreenElement ? "Exit fullscreen" : "Enter fullscreen");
  });

  setPlayingState();
  updateProgress();

  if (!reducedMotion) {
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry.isIntersecting && !userPaused) {
          video.play().catch(() => {});
        } else if (!entry.isIntersecting && !video.paused) {
          video.pause();
        }
      },
      { threshold: 0.38 }
    );
    observer.observe(shell);
  }
}

/* ---------------------------------------------------------
   Hero video · pause control · capture toggle · hotkeys
   --------------------------------------------------------- */
function setupMotionToggle() {
  const stage = $(".hero-stage");
  const button = $("#stageMotion");
  const heroVideo = $("#heroVideo");
  if (!stage || !button || !heroVideo) return;
  const label = $("span", button);
  let userPaused = reducedMotion;
  let inView = true;

  const sync = () => {
    const paused = heroVideo.paused;
    button.setAttribute("aria-pressed", String(paused));
    if (label) label.textContent = paused ? "Play motion" : "Pause motion";
    stage.classList.toggle("is-motion-paused", userPaused);
  };

  const play = () => heroVideo.play().then(sync).catch(sync);

  button.addEventListener("click", () => {
    if (heroVideo.paused) {
      userPaused = false;
      stage.classList.remove("is-motion-paused");
      play();
    } else {
      userPaused = true;
      stage.classList.add("is-motion-paused");
      heroVideo.pause();
      sync();
    }
  });

  if (reducedMotion) {
    heroVideo.pause();
    stage.classList.add("is-motion-paused");
  } else {
    play();
  }

  const visibility = new IntersectionObserver(
    (entries) => {
      inView = entries[0].isIntersecting;
      if (!inView) heroVideo.pause();
      else if (!userPaused) play();
    },
    { rootMargin: "160px 0px", threshold: 0.01 }
  );
  visibility.observe(stage);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) heroVideo.pause();
    else if (inView && !userPaused) play();
  });

  heroVideo.addEventListener("play", sync);
  heroVideo.addEventListener("pause", sync);
  sync();
}

function setupCaptureToggle() {
  const stage = $("#captureStage");
  if (!stage) return;
  const buttons = $$("[data-view]");

  const setView = (view) => {
    stage.classList.toggle("is-capture", view === "capture");
    buttons.forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  };

  buttons.forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
}

function setupHotkeys() {
  const rows = $$(".hotkey-row");
  if (!rows.length) return;

  const normalise = (value) => value
    .replace("ArrowUp", "↑")
    .replace("ArrowDown", "↓")
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replace("Enter", "Enter")
    .replace("Control", "Ctrl");

  document.addEventListener("keydown", (event) => {
    if (!event.ctrlKey) return;
    const pressed = [
      event.ctrlKey ? "Ctrl" : null,
      event.altKey ? "Alt" : null,
      event.shiftKey ? "Shift" : null,
      event.metaKey ? "Meta" : null,
      normalise(event.key.length === 1 ? event.key.toUpperCase() : event.key),
    ].filter(Boolean);

    rows.forEach((row) => {
      const keyText = $$("kbd", row).map((key) => key.textContent.trim().toLowerCase());
      const last = pressed[pressed.length - 1].toLowerCase();
      const base = pressed.slice(0, -1).map((key) => key.toLowerCase());
      const match = base.every((key) => keyText.includes(key))
        && (keyText.includes(last) || (/^[↑↓←→]$/.test(last) && keyText.some((key) => /^[↑↓←→]$/.test(key))));
      row.classList.toggle("is-pressed", match);
      if (match) window.setTimeout(() => row.classList.remove("is-pressed"), 550);
    });
  });
}

function setupPointerEffects() {
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  if (!finePointer || reducedMotion) return;

  const glow = $(".cursor-glow");
  if (glow) {
    const xTo = gsap.quickTo(glow, "x", { duration: 0.55, ease: "power3" });
    const yTo = gsap.quickTo(glow, "y", { duration: 0.55, ease: "power3" });
    gsap.set(glow, { xPercent: -50, yPercent: -50, x: window.innerWidth / 2, y: window.innerHeight / 2 });
    window.addEventListener("pointermove", (event) => {
      xTo(event.clientX);
      yTo(event.clientY);
      glow.style.opacity = "1";
    }, { passive: true });
    document.addEventListener("pointerleave", () => {
      glow.style.opacity = "0";
    });
  }

  const stage = $(".hero-stage");
  const panel = $("#stagePanel");
  if (stage && panel) {
    gsap.set(panel, { transformPerspective: 1200, rotationX: 2.6, rotationY: -8 });
    const rotateXTo = gsap.quickTo(panel, "rotationX", { duration: 0.7, ease: "power3" });
    const rotateYTo = gsap.quickTo(panel, "rotationY", { duration: 0.7, ease: "power3" });
    stage.addEventListener("pointermove", (event) => {
      const rect = stage.getBoundingClientRect();
      const nx = (event.clientX - rect.left) / Math.max(rect.width, 1);
      const ny = (event.clientY - rect.top) / Math.max(rect.height, 1);
      rotateXTo(2.6 + (0.5 - ny) * 8);
      rotateYTo(-8 + (nx - 0.5) * 13);
    });
    stage.addEventListener("pointerleave", () => {
      rotateXTo(2.6);
      rotateYTo(-8);
    });
  }

  if (window.matchMedia("(hover: hover)").matches) {
    $$(".tilt").forEach((card) => {
      gsap.set(card, { transformPerspective: 900, transformOrigin: "50% 50%" });
      const rotateXTo = gsap.quickTo(card, "rotationX", { duration: 0.42, ease: "power3" });
      const rotateYTo = gsap.quickTo(card, "rotationY", { duration: 0.42, ease: "power3" });

      card.addEventListener("pointermove", (event) => {
        const rect = card.getBoundingClientRect();
        const nx = (event.clientX - rect.left) / rect.width;
        const ny = (event.clientY - rect.top) / rect.height;
        card.style.setProperty("--mx", `${nx * 100}%`);
        card.style.setProperty("--my", `${ny * 100}%`);
        rotateXTo((0.5 - ny) * 2.2);
        rotateYTo((nx - 0.5) * 2.2);
      });
      card.addEventListener("pointerleave", () => {
        rotateXTo(0);
        rotateYTo(0);
      });
    });
  }
}

function setupMisc() {
  const year = $("#year");
  if (year) year.textContent = String(new Date().getFullYear());

  // Add a subtle current-state class if the visitor is on Windows.
  if (/Windows/i.test(navigator.userAgent)) {
    document.documentElement.classList.add("is-windows");
  }
}

/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */
function boot() {
  setupMisc();
  setupSmoothScroll();
  setupChrome();
  setupMenu();
  setupAnchors();
  setupHeroIntro();
  setupReveals();
  setupStatement();
  setupDemo();
  setupMotionToggle();
  setupCaptureToggle();
  setupHotkeys();
  setupPointerEffects();

  const refresh = () => ScrollTrigger.refresh();
  window.addEventListener("load", refresh, { once: true });
  if (document.fonts?.ready) document.fonts.ready.then(refresh).catch(() => {});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
