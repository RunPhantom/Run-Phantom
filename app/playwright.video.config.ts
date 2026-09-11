import { defineConfig, devices } from "@playwright/test";

/**
 * Recording profile for the demo-capture harness.
 *
 * Deliberately separate from playwright.config.ts: CI optimises for speed and
 * determinism, this optimises for how the recording looks. The video is the
 * artifact here, not the pass/fail.
 *
 * THE RULE THAT MATTERS: video.size must equal the viewport. Playwright does
 * not scale the page to fill the video frame — it composites the page at its
 * natural size into the top-left corner and leaves the rest grey. A 1280x720
 * viewport inside a 1920x1080 video yields dead space across the bottom and
 * right of every frame. Confirmed by extracting frames from both settings; the
 * metadata reads 1920x1080 either way, so only the pixels reveal it.
 *
 * 1280x720 is chosen over a native 1920x1080 viewport because upscaling to
 * 1080p at encode time renders text ~1.5x larger, which is what makes a span
 * name legible in a phone-sized LinkedIn player.
 */
export default defineConfig({
  testDir: "./tests-video",
  // Serial by design: parallel workers interleave daemon startup and make
  // in-take pacing unpredictable, which shows up as stutter on camera.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  timeout: 300_000,
  outputDir: "./video-out",
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    // Renders at 2560x1440 internally so glyphs stay crisp through the
    // capture-then-upscale round trip.
    deviceScaleFactor: 2,
    video: {
      mode: "on",
      size: { width: 1280, height: 720 },
      // Playwright 1.62 burns action labels and a synthetic cursor into the
      // recording, plus step titles along the bottom edge. Verified present in
      // extracted frames — this removes most manual captioning.
      show: {
        actions: { duration: 700, position: "top-right", fontSize: 22, cursor: "pointer" },
        test: { level: "step", position: "bottom", fontSize: 24 },
      },
    },
    trace: "off",
    screenshot: "off",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    // Gives each action a beat. Without it the UI settles faster than the eye
    // tracks and the recording is useless as an explainer.
    launchOptions: { slowMo: 220 },
  },
  projects: [
    {
      name: "capture",
      use: {
        ...devices["Desktop Chrome"],
        // MUST come after the device spread. devices["Desktop Chrome"] carries
        // its own viewport and deviceScaleFactor: 1, and project-level `use`
        // outranks the top-level block — spreading it last silently discards
        // both settings above and reintroduces the corner-boxing.
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
      },
    },
  ],
});
